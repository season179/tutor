import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  type MediaStream,
  type MediaStreamTrack,
} from 'react-native-webrtc';
import {
  appendTutorEvents,
  createBackendRealtimeSession,
  finishTutorSession,
  uploadSessionPhoto,
  type TutorBackendSession,
  type TutorAccess,
} from './tutorBackend';
import { setSpeakerOutputEnabled } from './audioRoute';
import type {
  StartTutorRealtimeSessionInput,
  TutorRealtimeSession,
  TutorTranscriptEntry,
} from './realtimeTutor';

const REALTIME_IMAGE_CONTENT_TYPE = 'image/jpeg';
const REALTIME_IMAGE_MAX_EDGE = 2400;
const REALTIME_IMAGE_COMPRESSION = 0.9;

type RealtimeServerEvent = {
  type?: string;
  event_id?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  item?: {
    id?: string;
    role?: string;
    type?: string;
  };
  response?: {
    id?: string;
    status?: string;
    usage?: {
      input_token_details?: {
        image_tokens?: number;
        text_tokens?: number;
        audio_tokens?: number;
      };
    };
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
        transcript?: string;
      }>;
    }>;
  };
  error?: {
    code?: string;
    event_id?: string;
    message?: string;
    param?: string;
    type?: string;
  };
};

type TutorDataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;

type PreparedRealtimeImage = {
  base64: string;
  contentType: typeof REALTIME_IMAGE_CONTENT_TYPE;
  uri: string;
  width: number;
  height: number;
  byteLength: number;
};

type NativeEventTarget<TEvent> = {
  addEventListener?: (type: string, listener: (event: TEvent) => void) => void;
};

type RealtimeEventContext = {
  access: TutorAccess;
  backendUrl: string;
  getSessionId: () => string | null;
  diagnostics: RealtimeDiagnosticsState;
};

type RealtimeEventWaiter = {
  predicate: (event: RealtimeServerEvent) => boolean;
  rejectPredicate: (event: RealtimeServerEvent) => boolean;
  resolve: (event: RealtimeServerEvent) => void;
  reject: (error: Error) => void;
};

type RealtimeDiagnosticsState = {
  activeResponseId: string | null;
  responseActive: boolean;
};

export async function startTutorRealtimeSession(
  input: StartTutorRealtimeSessionInput,
): Promise<TutorRealtimeSession> {
  input.onStatus('Opening microphone...');
  let localStream: MediaStream | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: TutorDataChannel | null = null;
  let backendSession: TutorBackendSession | null = null;
  const realtimeEvents = createRealtimeEventBus();
  const diagnostics: RealtimeDiagnosticsState = {
    activeResponseId: null,
    responseActive: false,
  };

  try {
    await preferSpeakerOutput();
    localStream = await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    await preferSpeakerOutput();
    const audioTracks = localStream.getAudioTracks();

    peerConnection = new RTCPeerConnection({ iceServers: [] });
    for (const track of audioTracks) {
      peerConnection.addTrack(track, localStream);
    }

    dataChannel = peerConnection.createDataChannel('oai-events');
    listenToNativeEvent(dataChannel, 'message', (event: { data: unknown }) => {
      const serverEvent = parseServerEvent(String(event.data));
      if (!serverEvent) {
        return;
      }
      realtimeEvents.dispatch(serverEvent);
      handleServerEvent(serverEvent, input, {
        access: input.access,
        backendUrl: input.backendUrl,
        getSessionId: () => backendSession?.sessionId || null,
        diagnostics,
      });
    });

    listenToNativeEvent(peerConnection, 'track', () => {
      void preferSpeakerOutput();
      input.onStatus('Tutor audio connected.');
    });

    input.onStatus('Creating realtime session...');
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    backendSession = await createBackendRealtimeSession({
      backendUrl: input.backendUrl,
      access: input.access,
      offerSdp: offer.sdp,
    });

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription({
        type: 'answer',
        sdp: backendSession.answerSdp,
      }),
    );
    await preferSpeakerOutput();

    await waitForDataChannelOpen(dataChannel);

    const initialQuestionText = input.initialQuestionText?.trim();
    if (initialQuestionText) {
      input.onTranscript({
        id: `system-question-${Date.now()}`,
        role: 'system',
        text: `Extracted question:\n${initialQuestionText}`,
      });
      void appendTutorEvents({
        backendUrl: input.backendUrl,
        access: input.access,
        sessionId: backendSession.sessionId,
        events: [
          {
            eventType: 'question_text_extracted',
            role: 'tool',
            modality: 'text',
            content: initialQuestionText,
            metadata: {
              source: 'pre_tutor_extraction',
              sourcePhotoR2Key: input.sourcePhotoR2Key || null,
              sourceSessionId: input.sourceSessionId || null,
            },
            clientCreatedAt: new Date().toISOString(),
          },
        ],
      }).catch(() => undefined);

      sendInitialQuestionText(dataChannel, initialQuestionText);

      const firstResponseEventId = `create-first-response-${Date.now()}`;
      const firstResponseStarted = waitForResponseCreated(realtimeEvents, firstResponseEventId);
      input.onStatus('Starting tutor response...');
      createTutorResponse(dataChannel, {
        eventId: firstResponseEventId,
        instructions:
          'Start speaking now. Do not wait for the child to speak. The extracted question text is already in the conversation. Briefly say what the question is about, then ask one small guiding question. Match the language of the extracted question.',
      });
      await firstResponseStarted;
      input.onStatus('Tutor is speaking...');

      if (!backendSession || !dataChannel || !peerConnection || !localStream) {
        throw new Error('Realtime tutoring session did not finish initializing.');
      }

      const activeBackendSession = backendSession;
      const activeDataChannel = dataChannel;
      const activePeerConnection = peerConnection;
      const activeLocalStream = localStream;

      return {
        sessionId: activeBackendSession.sessionId,
        photoR2Key: input.sourcePhotoR2Key || null,
        sendText: (text) => {
          sendTextMessage(activeDataChannel, text);
          input.onTranscript({
            id: `student-text-${Date.now()}`,
            role: 'student',
            text,
          });
          void appendTutorEvents({
            backendUrl: input.backendUrl,
            access: input.access,
            sessionId: activeBackendSession.sessionId,
            events: [
              {
                eventType: 'student_text_followup',
                role: 'student',
                modality: 'text',
                content: text,
                clientCreatedAt: new Date().toISOString(),
              },
            ],
          }).catch(() => undefined);
        },
        setMuted: (muted) => {
          for (const track of audioTracks) {
            track.enabled = !muted;
          }
        },
        end: async (status = 'ended', errorSummary) => {
          stopMedia(activeLocalStream, audioTracks);
          activeDataChannel.close();
          activePeerConnection.close();
          await restoreDefaultAudioRoute();
          await finishTutorSession({
            backendUrl: input.backendUrl,
            access: input.access,
            sessionId: activeBackendSession.sessionId,
            status,
            errorSummary,
          });
        },
      };
    }

    input.onStatus('Preparing question photo...');
    const [photoUpload, realtimeImage] = await Promise.all([
      uploadSessionPhoto({
        backendUrl: input.backendUrl,
        access: input.access,
        sessionId: backendSession.sessionId,
        photoUri: input.photoUri,
        contentType: input.photoContentType,
      }),
      prepareRealtimeImage(input),
    ]);

    const questionImageItemId = `question-photo-${Date.now()}`;
    const questionImageEventId = `create-question-photo-${Date.now()}`;
    const questionImageAccepted = waitForConversationItemCreated(realtimeEvents, {
      eventId: questionImageEventId,
      itemId: questionImageItemId,
    });
    input.onStatus('Sending question photo...');
    sendQuestionImage(dataChannel, realtimeImage, {
      eventId: questionImageEventId,
      itemId: questionImageItemId,
    });
    input.onTranscript({
      id: `student-photo-${Date.now()}`,
      role: 'student',
      text: `I sent the compressed question photo that the tutor sees. ${realtimeImage.width} x ${realtimeImage.height}, ${formatBytes(realtimeImage.byteLength)}.`,
      image: {
        uri: realtimeImage.uri,
        width: realtimeImage.width,
        height: realtimeImage.height,
        contentType: realtimeImage.contentType,
        byteLength: realtimeImage.byteLength,
      },
    });
    void questionImageAccepted
      .then(() => {
        console.info(
          JSON.stringify({
            service: 'tutor-app',
            event: 'realtime_question_photo_accepted',
            sessionId: backendSession?.sessionId || null,
            itemId: questionImageItemId,
            width: realtimeImage.width,
            height: realtimeImage.height,
            byteLength: realtimeImage.byteLength,
          }),
        );
      })
      .catch((error) => {
        console.warn(
          JSON.stringify({
            service: 'tutor-app',
            event: 'realtime_question_photo_ack_timeout',
            sessionId: backendSession?.sessionId || null,
            itemId: questionImageItemId,
            message: messageFromUnknown(error),
          }),
        );
      });
    void appendTutorEvents({
      backendUrl: input.backendUrl,
      access: input.access,
      sessionId: backendSession.sessionId,
      events: [
        {
          eventType: 'question_photo_sent',
          role: 'student',
          modality: 'image',
          content: photoUpload.r2Key,
          metadata: {
            r2Key: photoUpload.r2Key,
            originalContentType: input.photoContentType,
            realtimeContentType: realtimeImage.contentType,
            realtimeWidth: realtimeImage.width,
            realtimeHeight: realtimeImage.height,
            realtimeByteLength: realtimeImage.byteLength,
          },
          clientCreatedAt: new Date().toISOString(),
        },
      ],
    }).catch(() => undefined);

    const firstResponseEventId = `create-first-response-${Date.now()}`;
    const firstResponseStarted = waitForResponseCreated(realtimeEvents, firstResponseEventId);
    input.onStatus('Starting tutor response...');
    createTutorResponse(dataChannel, {
      eventId: firstResponseEventId,
      instructions:
        'Start speaking now. Do not wait for the child to speak. Analyze the question photo already in the conversation first. If you can read it, briefly say what you see, then ask one small guiding question. If it contains Chinese or Mandarin, speak Chinese. If the image is unclear, say exactly what part is unclear.',
    });
    firstResponseStarted
      .then(() => {
        console.info(
          JSON.stringify({
            service: 'tutor-app',
            event: 'realtime_first_response_started',
            sessionId: backendSession?.sessionId || null,
          }),
        );
      })
      .catch((error) => {
        console.warn(
          JSON.stringify({
            service: 'tutor-app',
            event: 'realtime_first_response_ack_timeout',
            sessionId: backendSession?.sessionId || null,
            message: messageFromUnknown(error),
          }),
        );
      });
    input.onStatus('Tutor is speaking...');
    if (!backendSession || !dataChannel || !peerConnection || !localStream) {
      throw new Error('Realtime tutoring session did not finish initializing.');
    }

    const activeBackendSession = backendSession;
    const activeDataChannel = dataChannel;
    const activePeerConnection = peerConnection;
    const activeLocalStream = localStream;

    return {
      sessionId: activeBackendSession.sessionId,
      photoR2Key: photoUpload.r2Key,
      sendText: (text) => {
        sendTextMessage(activeDataChannel, text);
        input.onTranscript({
          id: `student-text-${Date.now()}`,
          role: 'student',
          text,
        });
        void appendTutorEvents({
          backendUrl: input.backendUrl,
          access: input.access,
          sessionId: activeBackendSession.sessionId,
          events: [
            {
              eventType: 'student_text_followup',
              role: 'student',
              modality: 'text',
              content: text,
              clientCreatedAt: new Date().toISOString(),
            },
          ],
        }).catch(() => undefined);
      },
      setMuted: (muted) => {
        for (const track of audioTracks) {
          track.enabled = !muted;
        }
      },
      end: async (status = 'ended', errorSummary) => {
        stopMedia(activeLocalStream, audioTracks);
        activeDataChannel.close();
        activePeerConnection.close();
        await restoreDefaultAudioRoute();
        await finishTutorSession({
          backendUrl: input.backendUrl,
          access: input.access,
          sessionId: activeBackendSession.sessionId,
          status,
          errorSummary,
        });
      },
    };
  } catch (error) {
    if (localStream) {
      stopMedia(localStream, localStream.getAudioTracks());
    }
    dataChannel?.close();
    peerConnection?.close();
    await restoreDefaultAudioRoute();

    if (backendSession) {
      await finishTutorSession({
        backendUrl: input.backendUrl,
        access: input.access,
        sessionId: backendSession.sessionId,
        status: 'failed',
        errorSummary: messageFromUnknown(error),
      }).catch(() => undefined);
    }

    throw error;
  }
}

async function prepareRealtimeImage(
  input: StartTutorRealtimeSessionInput,
): Promise<PreparedRealtimeImage> {
  const context = ImageManipulator.manipulate(input.photoUri);
  const resize = realtimeImageResize(input.photoWidth, input.photoHeight);
  if (resize.width || resize.height) {
    context.resize(resize);
  }

  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    base64: true,
    compress: REALTIME_IMAGE_COMPRESSION,
    format: SaveFormat.JPEG,
  });

  if (!result.base64) {
    throw new Error('Could not prepare the question photo for realtime tutoring.');
  }

  return {
    base64: result.base64,
    contentType: REALTIME_IMAGE_CONTENT_TYPE,
    uri: result.uri,
    width: result.width,
    height: result.height,
    byteLength: base64ByteLength(result.base64),
  };
}

function realtimeImageResize(width: number, height: number): { width?: number; height?: number } {
  if (!width || !height) {
    return { width: REALTIME_IMAGE_MAX_EDGE };
  }

  const maxEdge = Math.max(width, height);
  if (maxEdge <= REALTIME_IMAGE_MAX_EDGE) {
    return {};
  }

  return width >= height ? { width: REALTIME_IMAGE_MAX_EDGE } : { height: REALTIME_IMAGE_MAX_EDGE };
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sendQuestionImage(
  dataChannel: TutorDataChannel,
  image: PreparedRealtimeImage,
  ids: { eventId: string; itemId: string },
) {
  dataChannel.send(
    JSON.stringify({
      event_id: ids.eventId,
      type: 'conversation.item.create',
      item: {
        id: ids.itemId,
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please analyze this question photo first. If it contains Chinese or Mandarin text, try to read it directly. If you can read the question, start the conversation by gently saying what you see, then ask the child one small guiding question. Match the language in the photo unless the child speaks or types another language. Only say the photo is blurry or unreadable when the text is genuinely unclear.',
          },
          {
            type: 'input_image',
            image_url: `data:${image.contentType};base64,${image.base64}`,
            detail: 'high',
          },
        ],
      },
    }),
  );
}

function sendTextMessage(dataChannel: TutorDataChannel, text: string) {
  dataChannel.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
      },
    }),
  );
  createTutorResponse(dataChannel);
}

function sendInitialQuestionText(dataChannel: TutorDataChannel, questionText: string) {
  dataChannel.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `This is the extracted school question text. Start tutoring from this text, not from the photo:\n\n${questionText}`,
          },
        ],
      },
    }),
  );
}

function createTutorResponse(
  dataChannel: TutorDataChannel,
  options?: { eventId?: string; instructions?: string },
) {
  dataChannel.send(
    JSON.stringify({
      ...(options?.eventId ? { event_id: options.eventId } : {}),
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        ...(options?.instructions ? { instructions: options.instructions } : {}),
      },
    }),
  );
}

async function preferSpeakerOutput() {
  await setSpeakerOutputEnabled(true).catch(() => undefined);
}

async function restoreDefaultAudioRoute() {
  await setSpeakerOutputEnabled(false).catch(() => undefined);
}

function parseServerEvent(rawData: string): RealtimeServerEvent | null {
  try {
    return JSON.parse(rawData) as RealtimeServerEvent;
  } catch {
    return null;
  }
}

function createRealtimeEventBus() {
  let waiters: RealtimeEventWaiter[] = [];
  let recentEvents: RealtimeServerEvent[] = [];

  return {
    dispatch(event: RealtimeServerEvent) {
      recentEvents = [...recentEvents.slice(-49), event];
      waiters = waiters.filter((waiter) => {
        if (waiter.predicate(event)) {
          waiter.resolve(event);
          return false;
        }

        if (waiter.rejectPredicate(event)) {
          waiter.reject(new Error(realtimeErrorMessage(event)));
          return false;
        }

        return true;
      });
    },
    waitFor(
      predicate: RealtimeEventWaiter['predicate'],
      rejectPredicate: RealtimeEventWaiter['rejectPredicate'],
      timeoutMs: number,
      timeoutMessage: string,
    ) {
      const matchingEvent = recentEvents.find(predicate);
      if (matchingEvent) {
        return Promise.resolve(matchingEvent);
      }

      const rejectedEvent = recentEvents.find(rejectPredicate);
      if (rejectedEvent) {
        return Promise.reject(new Error(realtimeErrorMessage(rejectedEvent)));
      }

      return new Promise<RealtimeServerEvent>((resolve, reject) => {
        const waiter: RealtimeEventWaiter = {
          predicate,
          rejectPredicate,
          resolve: (event) => {
            clearTimeout(timeout);
            resolve(event);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };

        const timeout = setTimeout(() => {
          waiters = waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(timeoutMessage));
        }, timeoutMs);

        waiters.push(waiter);
      });
    },
  };
}

async function waitForConversationItemCreated(
  realtimeEvents: ReturnType<typeof createRealtimeEventBus>,
  ids: { eventId: string; itemId: string },
) {
  await realtimeEvents.waitFor(
    (event) => event.type === 'conversation.item.created' && event.item?.id === ids.itemId,
    (event) =>
      event.type === 'error' &&
      (event.error?.event_id === ids.eventId || event.error?.param?.includes(ids.itemId) === true),
    5_000,
    'The realtime tutor did not acknowledge the question photo.',
  );
}

async function waitForResponseCreated(
  realtimeEvents: ReturnType<typeof createRealtimeEventBus>,
  eventId: string,
) {
  await realtimeEvents.waitFor(
    (event) => event.type === 'response.created',
    (event) => event.type === 'error' && event.error?.event_id === eventId,
    10_000,
    'The tutor did not start its first response. Please try starting the session again.',
  );
}

function realtimeErrorMessage(event: RealtimeServerEvent): string {
  const message = event.error?.message || 'Realtime session error.';
  const code = event.error?.code ? ` (${event.error.code})` : '';
  return `${message}${code}`;
}

function handleServerEvent(
  event: RealtimeServerEvent,
  input: StartTutorRealtimeSessionInput,
  context: RealtimeEventContext,
) {
  switch (event.type) {
    case 'session.created':
      input.onStatus('Tutor connected.');
      break;
    case 'input_audio_buffer.speech_started':
      logRealtimeDiagnosticEvent(context, 'realtime_speech_started', event);
      input.onStatus('Listening...');
      break;
    case 'input_audio_buffer.speech_stopped':
      logRealtimeDiagnosticEvent(context, 'realtime_speech_stopped', event);
      input.onStatus('Tutor is thinking...');
      break;
    case 'response.created':
      context.diagnostics.responseActive = true;
      context.diagnostics.activeResponseId = event.response?.id || null;
      logRealtimeDiagnosticEvent(context, 'realtime_response_created', event);
      input.onStatus('Tutor is speaking...');
      break;
    case 'response.output_text.delta':
    case 'response.output_audio_transcript.delta':
      if (event.delta) {
        input.onAssistantDelta(event.delta);
      }
      break;
    case 'response.output_text.done':
    case 'response.output_audio_transcript.done':
      {
        const text = event.transcript || event.text || extractResponseText(event);
        if (text) {
          input.onTranscript(assistantEntry(text));
          logAssistantTranscript(context, event.type, text);
        }
      }
      input.onStatus('Listening...');
      break;
    case 'response.done':
      logResponseUsage(context, event);
      logRealtimeDiagnosticEvent(context, 'realtime_response_done', event);
      context.diagnostics.responseActive = false;
      context.diagnostics.activeResponseId = null;
      input.onStatus('Listening...');
      break;
    case 'error':
      console.warn(
        JSON.stringify({
          service: 'tutor-app',
          event: 'openai_realtime_error',
          sessionId: context.getSessionId(),
          message: event.error?.message || null,
          code: event.error?.code || null,
          errorEventId: event.error?.event_id || null,
          param: event.error?.param || null,
          type: event.error?.type || null,
        }),
      );
      input.onError(realtimeErrorMessage(event));
      break;
  }
}

function logRealtimeDiagnosticEvent(
  context: RealtimeEventContext,
  eventType: string,
  event: RealtimeServerEvent,
) {
  const sessionId = context.getSessionId();
  const metadata = {
    realtimeEventType: event.type || null,
    realtimeEventId: event.event_id || null,
    duringResponse: context.diagnostics.responseActive,
    activeResponseId: context.diagnostics.activeResponseId,
    responseId: event.response?.id || null,
    responseStatus: event.response?.status || null,
  };

  console.info(
    JSON.stringify({
      service: 'tutor-app',
      event: eventType,
      sessionId,
      ...metadata,
    }),
  );

  if (!sessionId) {
    return;
  }

  void appendTutorEvents({
    backendUrl: context.backendUrl,
    access: context.access,
    sessionId,
    events: [
      {
        eventType,
        role: 'system',
        modality: 'data',
        metadata,
        clientCreatedAt: new Date().toISOString(),
      },
    ],
  }).catch(() => undefined);
}

function logResponseUsage(context: RealtimeEventContext, event: RealtimeServerEvent) {
  const inputTokenDetails = event.response?.usage?.input_token_details;
  if (!inputTokenDetails) {
    return;
  }

  console.info(
    JSON.stringify({
      service: 'tutor-app',
      event: 'openai_realtime_response_usage',
      sessionId: context.getSessionId(),
      imageTokens: inputTokenDetails.image_tokens ?? null,
      textTokens: inputTokenDetails.text_tokens ?? null,
      audioTokens: inputTokenDetails.audio_tokens ?? null,
    }),
  );
}

function logAssistantTranscript(
  context: RealtimeEventContext,
  eventType: string,
  text: string,
) {
  const sessionId = context.getSessionId();
  if (!sessionId) {
    return;
  }

  void appendTutorEvents({
    backendUrl: context.backendUrl,
    access: context.access,
    sessionId,
    events: [
      {
        eventType,
        role: 'assistant',
        modality: eventType.includes('audio') ? 'audio_transcript' : 'text',
        content: text,
        clientCreatedAt: new Date().toISOString(),
      },
    ],
  }).catch(() => undefined);
}

function assistantEntry(text: string): TutorTranscriptEntry {
  return {
    id: `assistant-${Date.now()}`,
    role: 'assistant',
    text,
  };
}

function waitForDataChannelOpen(dataChannel: TutorDataChannel): Promise<void> {
  if (dataChannel.readyState === 'open') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime data channel did not open.')), 15_000);

    listenToNativeEvent(dataChannel, 'open', () => {
      clearTimeout(timeout);
      resolve();
    });

    listenToNativeEvent(dataChannel, 'error', () => {
      clearTimeout(timeout);
      reject(new Error('Realtime data channel failed to open.'));
    });
  });
}

function listenToNativeEvent<TEvent>(
  target: object,
  type: string,
  listener: (event: TEvent) => void,
) {
  const eventTarget = target as NativeEventTarget<TEvent>;
  if (eventTarget.addEventListener) {
    eventTarget.addEventListener(type, listener);
    return;
  }

  (target as Record<string, unknown>)[`on${type}`] = listener;
}

function extractResponseText(event: RealtimeServerEvent): string | null {
  const content = event.response?.output?.flatMap((output) => output.content || []) || [];
  const textParts = content
    .map((part) => part.transcript || part.text)
    .filter((part): part is string => Boolean(part));

  return textParts.length > 0 ? textParts.join('') : null;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown realtime tutoring error.';
}

function stopMedia(localStream: MediaStream, audioTracks: MediaStreamTrack[]) {
  for (const track of audioTracks) {
    track.stop();
  }

  for (const track of localStream.getTracks()) {
    if (!audioTracks.includes(track)) {
      track.stop();
    }
  }
}
