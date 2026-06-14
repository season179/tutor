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
const REALTIME_IMAGE_MAX_EDGE = 1400;
const REALTIME_IMAGE_COMPRESSION = 0.72;

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  text?: string;
  transcript?: string;
  response?: {
    status?: string;
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
        transcript?: string;
      }>;
    }>;
  };
  error?: {
    message?: string;
  };
};

type TutorDataChannel = ReturnType<RTCPeerConnection['createDataChannel']>;

type PreparedRealtimeImage = {
  base64: string;
  contentType: typeof REALTIME_IMAGE_CONTENT_TYPE;
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
};

export async function startTutorRealtimeSession(
  input: StartTutorRealtimeSessionInput,
): Promise<TutorRealtimeSession> {
  input.onStatus('Opening microphone...');
  let localStream: MediaStream | null = null;
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: TutorDataChannel | null = null;
  let backendSession: TutorBackendSession | null = null;

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
      handleServerEvent(String(event.data), input, {
        access: input.access,
        backendUrl: input.backendUrl,
        getSessionId: () => backendSession?.sessionId || null,
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

    sendQuestionImage(dataChannel, realtimeImage);
    input.onTranscript({
      id: `student-photo-${Date.now()}`,
      role: 'student',
      text: 'I sent a photo of the question.',
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

    input.onStatus('Tutor is thinking...');
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

function sendQuestionImage(dataChannel: TutorDataChannel, image: PreparedRealtimeImage) {
  dataChannel.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please analyze this question photo first. If you can read the question, start the conversation by gently saying what you see, then ask the child one small guiding question. Match the language in the photo unless the child speaks or types another language.',
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
  createTutorResponse(dataChannel);
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

function createTutorResponse(dataChannel: TutorDataChannel) {
  dataChannel.send(
    JSON.stringify({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
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

function handleServerEvent(
  rawData: string,
  input: StartTutorRealtimeSessionInput,
  context: RealtimeEventContext,
) {
  let event: RealtimeServerEvent;
  try {
    event = JSON.parse(rawData) as RealtimeServerEvent;
  } catch {
    return;
  }

  switch (event.type) {
    case 'session.created':
      input.onStatus('Tutor connected.');
      break;
    case 'input_audio_buffer.speech_started':
      input.onStatus('Listening...');
      break;
    case 'input_audio_buffer.speech_stopped':
      input.onStatus('Tutor is thinking...');
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
      input.onStatus('Listening...');
      break;
    case 'error':
      input.onError(event.error?.message || 'Realtime session error.');
      break;
  }
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
