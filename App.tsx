import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import {
  ArrowLeft,
  Camera,
  Check,
  FileText,
  ImagePlus,
  LogOut,
  Mic,
  MicOff,
  RotateCcw,
  Send,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { TUTOR_BACKEND_URL } from './src/config';
import {
  startTutorRealtimeSession,
  type TutorRealtimeSession,
  type TutorTranscriptEntry,
} from './src/realtimeTutor';
import {
  appendTutorEvents,
  extractAccessCookie,
  extractQuestionFromPhoto,
  type TutorAccess,
  type TutorQuestionExtraction,
} from './src/tutorBackend';
import { runNativeWebRTCSmokeTest } from './src/webrtcSmoke';

type Screen = 'source' | 'camera' | 'preview' | 'auth' | 'review' | 'tutor';
type CapturedPhoto = {
  uri: string;
  width: number;
  height: number;
  contentType: string;
  deleteAfterUse: boolean;
};

const ACCESS_COOKIE_SCRIPT = `
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'cookies',
    cookie: document.cookie,
    url: window.location.href
  }));
  true;
`;

const QUESTION_EXTRACTION_IMAGE_CONTENT_TYPE = 'image/jpeg';
const QUESTION_EXTRACTION_IMAGE_MAX_EDGE = 2400;
const QUESTION_EXTRACTION_IMAGE_COMPRESSION = 0.9;

function deleteTemporaryPhoto(photo?: CapturedPhoto | null) {
  if (!photo?.deleteAfterUse || Platform.OS === 'web' || photo.uri.startsWith('data:')) {
    return;
  }

  try {
    const file = new File(photo.uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Temporary cleanup should never interrupt the capture flow.
  }
}

function contentTypeFromUri(uri: string): string {
  const normalized = uri.toLowerCase();
  if (normalized.endsWith('.png')) {
    return 'image/png';
  }
  if (normalized.endsWith('.webp')) {
    return 'image/webp';
  }
  if (normalized.endsWith('.heic')) {
    return 'image/heic';
  }
  if (normalized.endsWith('.heif')) {
    return 'image/heif';
  }
  return 'image/jpeg';
}

function photoContentType(photo: CapturedPhoto): string {
  return photo.contentType || contentTypeFromUri(photo.uri);
}

async function prepareQuestionExtractionPhoto(photo: CapturedPhoto): Promise<CapturedPhoto> {
  const context = ImageManipulator.manipulate(photo.uri);
  const resize = imageResize(photo.width, photo.height, QUESTION_EXTRACTION_IMAGE_MAX_EDGE);
  if (resize.width || resize.height) {
    context.resize(resize);
  }

  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    compress: QUESTION_EXTRACTION_IMAGE_COMPRESSION,
    format: SaveFormat.JPEG,
  });

  return {
    uri: result.uri,
    width: result.width,
    height: result.height,
    contentType: QUESTION_EXTRACTION_IMAGE_CONTENT_TYPE,
    deleteAfterUse: true,
  };
}

function imageResize(width: number, height: number, maxEdge: number): { width?: number; height?: number } {
  if (!width || !height) {
    return { width: maxEdge };
  }

  const currentMaxEdge = Math.max(width, height);
  if (currentMaxEdge <= maxEdge) {
    return {};
  }

  return width >= height ? { width: maxEdge } : { height: maxEdge };
}

function transcriptRoleLabel(role: TutorTranscriptEntry['role']): string {
  if (role === 'assistant') {
    return 'Tutor';
  }

  if (role === 'system') {
    return 'System';
  }

  return 'Student';
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export default function App() {
  const cameraRef = useRef<CameraView>(null);
  const transcriptScrollRef = useRef<ScrollView>(null);
  const tutorSessionRef = useRef<TutorRealtimeSession | null>(null);
  const accessStartRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [screen, setScreen] = useState<Screen>('source');
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [access, setAccess] = useState<TutorAccess | null>(null);
  const [tutorSession, setTutorSession] = useState<TutorRealtimeSession | null>(null);
  const [questionExtraction, setQuestionExtraction] = useState<TutorQuestionExtraction | null>(null);
  const [validatedQuestionText, setValidatedQuestionText] = useState('');
  const [transcript, setTranscript] = useState<TutorTranscriptEntry[]>([]);
  const [assistantDraft, setAssistantDraft] = useState('');
  const [followUpText, setFollowUpText] = useState('');
  const [statusText, setStatusText] = useState('Ready');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraAvailable, setIsCameraAvailable] = useState<boolean | null>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [hasCameraPreviewTimedOut, setHasCameraPreviewTimedOut] = useState(false);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [isPickingPhoto, setIsPickingPhoto] = useState(false);
  const [isStartingTutor, setIsStartingTutor] = useState(false);
  const [isEndingTutor, setIsEndingTutor] = useState(false);
  const [isSavingQuestion, setIsSavingQuestion] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => deleteTemporaryPhoto(photo);
  }, [photo]);

  useEffect(() => {
    tutorSessionRef.current = tutorSession;
  }, [tutorSession]);

  useEffect(() => {
    return () => {
      void tutorSessionRef.current?.end('cancelled');
    };
  }, []);

  useEffect(() => {
    if (
      screen !== 'camera' ||
      !permission?.granted ||
      isCameraReady ||
      isCameraAvailable === false
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      setHasCameraPreviewTimedOut(true);
      setErrorMessage('Camera preview did not start. Use a physical phone to take a photo.');
    }, 7000);

    return () => clearTimeout(timeout);
  }, [isCameraAvailable, isCameraReady, permission?.granted, screen]);

  useEffect(() => {
    if (!__DEV__ || Platform.OS === 'web') {
      return;
    }

    let isMounted = true;

    void runNativeWebRTCSmokeTest().then((result) => {
      if (!isMounted) {
        return;
      }

      const log = result.ok ? console.info : console.warn;
      log(
        JSON.stringify({
          service: 'tutor-app',
          event: 'webrtc_peer_connection_smoke',
          ...result,
        }),
      );
    });

    return () => {
      isMounted = false;
    };
  }, []);

  function appendTranscript(entry: TutorTranscriptEntry) {
    setTranscript((current) => [...current, entry]);
    setAssistantDraft('');
  }

  async function openCamera() {
    setErrorMessage(null);
    setHasCameraPreviewTimedOut(false);
    setScreen('camera');

    if (Platform.OS === 'web') {
      const cameraAvailable = await CameraView.isAvailableAsync();
      setIsCameraAvailable(cameraAvailable);
      if (!cameraAvailable) {
        setErrorMessage('Camera is not available here. Use a physical phone to take a photo.');
        return;
      }
    }

    if (!permission?.granted) {
      await requestPermission();
    }
  }

  function returnHome() {
    deleteTemporaryPhoto(photo);
    setPhoto(null);
    setTutorSession(null);
    setQuestionExtraction(null);
    setValidatedQuestionText('');
    accessStartRef.current = false;
    setTranscript([]);
    setAssistantDraft('');
    setFollowUpText('');
    setIsMuted(false);
    setIsCameraAvailable(null);
    setIsTakingPhoto(false);
    setIsPickingPhoto(false);
    setIsCameraReady(false);
    setHasCameraPreviewTimedOut(false);
    setIsStartingTutor(false);
    setIsEndingTutor(false);
    setIsSavingQuestion(false);
    setStatusText('Ready');
    setErrorMessage(null);
    setScreen('source');
  }

  async function takePhoto() {
    if (!cameraRef.current || !isCameraReady || isTakingPhoto) {
      return;
    }

    setIsTakingPhoto(true);
    setErrorMessage(null);

    try {
      const result = await cameraRef.current.takePictureAsync({
        base64: false,
        exif: false,
        quality: 0.7,
      });

      if (result) {
        setQuestionExtraction(null);
        setValidatedQuestionText('');
        setPhoto({
          uri: result.uri,
          width: result.width,
          height: result.height,
          contentType: contentTypeFromUri(result.uri),
          deleteAfterUse: true,
        });
        setScreen('preview');
      }
    } catch {
      setErrorMessage('Could not take photo.');
    } finally {
      setIsTakingPhoto(false);
    }
  }

  async function chooseExistingPhoto() {
    if (isPickingPhoto) {
      return;
    }

    setIsPickingPhoto(true);
    setErrorMessage(null);

    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync(false);
      if (!permissionResult.granted) {
        setErrorMessage('Photo library access is needed.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: false,
        mediaTypes: ['images'],
        quality: 0.85,
      });

      if (result.canceled || !result.assets[0]) {
        return;
      }

      const asset = result.assets[0];
      deleteTemporaryPhoto(photo);
      setQuestionExtraction(null);
      setValidatedQuestionText('');
      setPhoto({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        contentType: asset.mimeType || contentTypeFromUri(asset.uri),
        deleteAfterUse: false,
      });
      setScreen('preview');
    } catch {
      setErrorMessage('Could not choose photo.');
    } finally {
      setIsPickingPhoto(false);
    }
  }

  function retakePhoto() {
    deleteTemporaryPhoto(photo);
    setPhoto(null);
    setQuestionExtraction(null);
    setValidatedQuestionText('');
    accessStartRef.current = false;
    setErrorMessage(null);
    setIsCameraReady(false);
    setHasCameraPreviewTimedOut(false);
    setScreen('camera');
  }

  async function startSessionFromPreview(nextAccess = access) {
    if (!photo) {
      return;
    }
    const currentPhoto = photo;
    let extractionPhoto: CapturedPhoto | null = null;

    if (!nextAccess) {
      setErrorMessage(null);
      setScreen('auth');
      return;
    }

    setIsStartingTutor(true);
    setErrorMessage(null);
    setTranscript([]);
    setAssistantDraft('');
    setFollowUpText('');
    setQuestionExtraction(null);
    setValidatedQuestionText('');
    setStatusText('Extracting question...');

    try {
      extractionPhoto = await prepareQuestionExtractionPhoto(currentPhoto);
      const extraction = await extractQuestionFromPhoto({
        backendUrl: TUTOR_BACKEND_URL,
        access: nextAccess,
        photoUri: extractionPhoto.uri,
        contentType: extractionPhoto.contentType,
      });
      setQuestionExtraction(extraction);
      setValidatedQuestionText(extraction.extractedQuestion);

      if (!extraction.isTutorable || extraction.needsRetake) {
        const reason = extraction.reason || 'I could not find a tutor-ready question in this photo.';
        setErrorMessage(`${reason} Please take or choose the photo again.`);
        setStatusText('Please retake the photo.');
        setScreen('preview');
        return;
      }

      setStatusText('Starting tutor...');
      setScreen('tutor');
      const session = await startTutorRealtimeSession({
        backendUrl: TUTOR_BACKEND_URL,
        access: nextAccess,
        photoUri: currentPhoto.uri,
        photoContentType: photoContentType(currentPhoto),
        photoWidth: currentPhoto.width,
        photoHeight: currentPhoto.height,
        initialQuestionText: extraction.extractedQuestion,
        sourcePhotoR2Key: extraction.photo.r2Key,
        sourceSessionId: extraction.sessionId,
        onStatus: setStatusText,
        onTranscript: appendTranscript,
        onAssistantDelta: (delta) => {
          setAssistantDraft((current) => current + delta);
        },
        onError: (message) => {
          setErrorMessage(message);
          setStatusText('Needs attention');
        },
      });
      setTutorSession(session);
      deleteTemporaryPhoto(currentPhoto);
      setPhoto(null);
    } catch (error) {
      setErrorMessage(messageFromError(error));
      setStatusText('Could not start session.');
      setScreen('preview');
    } finally {
      deleteTemporaryPhoto(extractionPhoto);
      setIsStartingTutor(false);
    }
  }

  function handleAccessMessage(event: WebViewMessageEvent) {
    let cookieText = event.nativeEvent.data;
    try {
      const parsed = JSON.parse(event.nativeEvent.data) as { cookie?: unknown };
      if (typeof parsed.cookie === 'string') {
        cookieText = parsed.cookie;
      }
    } catch {
      // Plain cookie strings are accepted too.
    }

    const nextAccess = extractAccessCookie(cookieText);
    if (!nextAccess || accessStartRef.current) {
      return;
    }

    accessStartRef.current = true;
    setAccess(nextAccess);
    setStatusText('Signed in.');
    void startSessionFromPreview(nextAccess);
  }

  function sendFollowUpText() {
    const text = followUpText.trim();
    if (!text || !tutorSession) {
      return;
    }

    tutorSession.sendText(text);
    setFollowUpText('');
    setStatusText('Tutor is thinking...');
  }

  function toggleMute() {
    if (!tutorSession) {
      return;
    }

    const nextMuted = !isMuted;
    tutorSession.setMuted(nextMuted);
    setIsMuted(nextMuted);
    setStatusText(nextMuted ? 'Microphone muted.' : 'Listening...');
  }

  async function saveValidatedQuestion() {
    const text = validatedQuestionText.trim();
    if (!questionExtraction || !access || !text || isSavingQuestion) {
      return;
    }

    setIsSavingQuestion(true);
    setErrorMessage(null);

    try {
      await appendTutorEvents({
        backendUrl: TUTOR_BACKEND_URL,
        access,
        sessionId: questionExtraction.sessionId,
        events: [
          {
            eventType: 'question_text_validated',
            role: 'student',
            modality: 'text',
            content: text,
            metadata: {
              source: 'manual_review',
              modelId: questionExtraction.modelId,
              openAiRequestId: questionExtraction.openAiRequestId,
            },
            clientCreatedAt: new Date().toISOString(),
          },
        ],
      });
      setStatusText('Validated question saved.');
    } catch (error) {
      setErrorMessage(messageFromError(error));
      setStatusText('Could not save validation.');
    } finally {
      setIsSavingQuestion(false);
    }
  }

  async function endTutorSession(status: 'ended' | 'failed' | 'cancelled' = 'ended') {
    setIsEndingTutor(true);
    try {
      await tutorSession?.end(status, status === 'failed' ? errorMessage || undefined : undefined);
    } finally {
      returnHome();
    }
  }

  if (screen === 'source') {
    return (
      <SafeAreaView style={styles.sourceScreen}>
        <StatusBar style="dark" />
        <View style={styles.sourceContent}>
          <Text style={styles.sourceTitle}>Question photo</Text>
          <View style={styles.sourceActions}>
            <Pressable onPress={openCamera} style={styles.sourcePrimaryButton}>
              <Camera color="#ffffff" size={21} strokeWidth={2.4} />
              <Text style={styles.sourcePrimaryButtonText}>Use camera</Text>
            </Pressable>
            <Pressable
              disabled={isPickingPhoto}
              onPress={() => void chooseExistingPhoto()}
              style={[styles.sourceSecondaryButton, isPickingPhoto && styles.disabledButton]}
            >
              {isPickingPhoto ? (
                <ActivityIndicator color="#111827" />
              ) : (
                <ImagePlus color="#111827" size={21} strokeWidth={2.4} />
              )}
              <Text style={styles.sourceSecondaryButtonText}>Choose photo</Text>
            </Pressable>
          </View>
          {errorMessage ? <Text style={styles.sourceErrorText}>{errorMessage}</Text> : null}
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'camera') {
    return (
      <SafeAreaView style={styles.cameraScreen}>
        <StatusBar style="light" />
        <View style={styles.cameraHeader}>
          <Pressable
            accessibilityLabel="Back"
            hitSlop={20}
            onPress={returnHome}
            style={styles.iconButton}
          >
            <ArrowLeft color="#ffffff" size={26} strokeWidth={2.3} />
          </Pressable>
        </View>

        {isCameraAvailable === false || hasCameraPreviewTimedOut ? (
          <View style={styles.permissionPanel}>
            <Text style={styles.permissionText}>Camera preview is not available here.</Text>
            <Text style={styles.permissionSubtext}>Use a physical phone to take a photo.</Text>
          </View>
        ) : permission?.granted ? (
          <CameraView
            active={screen === 'camera'}
            facing="back"
            mode="picture"
            onCameraReady={() => {
              setHasCameraPreviewTimedOut(false);
              setIsCameraReady(true);
            }}
            ref={cameraRef}
            style={styles.camera}
          />
        ) : (
          <View style={styles.permissionPanel}>
            <Text style={styles.permissionText}>Camera access is needed.</Text>
            <Pressable onPress={requestPermission} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Allow camera</Text>
            </Pressable>
          </View>
        )}

        {errorMessage && isCameraAvailable !== false && !hasCameraPreviewTimedOut ? (
          <Text style={styles.errorText}>{errorMessage}</Text>
        ) : null}

        {permission?.granted && isCameraAvailable !== false && !hasCameraPreviewTimedOut ? (
          <View style={styles.cameraFooter}>
            <Pressable
              accessibilityLabel="Choose photo"
              disabled={isPickingPhoto}
              onPress={() => void chooseExistingPhoto()}
              style={[styles.cameraGalleryButton, isPickingPhoto && styles.disabledButton]}
            >
              {isPickingPhoto ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <ImagePlus color="#ffffff" size={25} strokeWidth={2.4} />
              )}
            </Pressable>
            <Pressable
              accessibilityLabel="Take photo"
              disabled={!isCameraReady || isTakingPhoto}
              onPress={takePhoto}
              style={[
                styles.shutterButton,
                (!isCameraReady || isTakingPhoto) && styles.disabledButton,
              ]}
            >
              <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.cameraFooterSpacer} />
          </View>
        ) : null}
      </SafeAreaView>
    );
  }

  if (screen === 'auth') {
    return (
      <SafeAreaView style={styles.authScreen}>
        <StatusBar style="dark" />
        <View style={styles.authHeader}>
          <Pressable
            accessibilityLabel="Back"
            hitSlop={12}
            onPress={() => setScreen(photo ? 'preview' : 'source')}
            style={styles.lightIconButton}
          >
            <ArrowLeft color="#111827" size={25} strokeWidth={2.3} />
          </Pressable>
          <Text style={styles.authTitle}>Sign in</Text>
        </View>
        <Text style={styles.authText}>
          Use your Cloudflare Access email PIN. Question extraction will start after sign-in.
        </Text>
        {Platform.OS === 'web' ? (
          <View style={styles.authFallback}>
            <Text style={styles.authText}>Question extraction requires a native dev build.</Text>
          </View>
        ) : (
          <WebView
            injectedJavaScript={ACCESS_COOKIE_SCRIPT}
            onMessage={handleAccessMessage}
            onNavigationStateChange={() => undefined}
            sharedCookiesEnabled
            source={{ uri: `${TUTOR_BACKEND_URL}/debug` }}
            style={styles.authWebView}
            thirdPartyCookiesEnabled
          />
        )}
      </SafeAreaView>
    );
  }

  if (screen === 'preview' && photo) {
    return (
      <SafeAreaView style={styles.previewScreen}>
        <StatusBar style="light" />
        <Image resizeMode="contain" source={{ uri: photo.uri }} style={styles.previewImage} />
        {errorMessage ? <Text style={styles.previewErrorText}>{errorMessage}</Text> : null}
        <View style={styles.previewActions}>
          <Pressable
            disabled={isStartingTutor}
            onPress={retakePhoto}
            style={[styles.secondaryButton, isStartingTutor && styles.disabledButton]}
          >
            <RotateCcw color="#111827" size={19} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>Retake</Text>
          </Pressable>
          <Pressable
            disabled={isStartingTutor}
            onPress={() => void startSessionFromPreview()}
            style={[styles.primaryButton, isStartingTutor && styles.disabledButton]}
          >
            {isStartingTutor ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Check color="#ffffff" size={20} strokeWidth={2.4} />
            )}
            <Text style={styles.primaryButtonText}>Start session</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'review' && photo && questionExtraction) {
    return (
      <SafeAreaView style={styles.reviewScreen}>
        <StatusBar style="dark" />
        <View style={styles.reviewHeader}>
          <Pressable
            accessibilityLabel="Back"
            hitSlop={12}
            onPress={() => setScreen('preview')}
            style={styles.lightIconButton}
          >
            <ArrowLeft color="#111827" size={25} strokeWidth={2.3} />
          </Pressable>
          <View style={styles.reviewTitleBlock}>
            <Text style={styles.reviewTitle}>Review question</Text>
            <Text style={styles.reviewStatus}>{statusText}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.reviewContent}>
          <Image resizeMode="contain" source={{ uri: photo.uri }} style={styles.reviewImage} />

          <View style={styles.reviewMetaRow}>
            <FileText color="#111827" size={18} strokeWidth={2.3} />
            <Text style={styles.reviewMetaText}>
              {questionExtraction.modelId} - {questionExtraction.sessionId.slice(0, 8)}
            </Text>
          </View>

          <Text style={styles.reviewLabel}>Extracted question</Text>
          <TextInput
            multiline
            onChangeText={setValidatedQuestionText}
            placeholder="Extracted question text"
            placeholderTextColor="#6b7280"
            style={styles.reviewQuestionInput}
            textAlignVertical="top"
            value={validatedQuestionText}
          />

          {errorMessage ? <Text style={styles.reviewErrorText}>{errorMessage}</Text> : null}
        </ScrollView>

        <View style={styles.reviewActions}>
          <Pressable
            disabled={isSavingQuestion}
            onPress={retakePhoto}
            style={[styles.secondaryButton, isSavingQuestion && styles.disabledButton]}
          >
            <RotateCcw color="#111827" size={19} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>Retake</Text>
          </Pressable>
          <Pressable
            disabled={isSavingQuestion || !validatedQuestionText.trim()}
            onPress={() => void saveValidatedQuestion()}
            style={[
              styles.primaryButton,
              (isSavingQuestion || !validatedQuestionText.trim()) && styles.disabledButton,
            ]}
          >
            {isSavingQuestion ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Check color="#ffffff" size={20} strokeWidth={2.4} />
            )}
            <Text style={styles.primaryButtonText}>Save validation</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'tutor') {
    return (
      <SafeAreaView style={styles.tutorScreen}>
        <StatusBar style="dark" />
        <View style={styles.tutorHeader}>
          <Pressable
            accessibilityLabel="End session"
            disabled={isEndingTutor}
            onPress={() => void endTutorSession('ended')}
            style={styles.endButton}
          >
            <LogOut color="#ffffff" size={18} strokeWidth={2.3} />
            <Text style={styles.endButtonText}>End</Text>
          </Pressable>
          <View style={styles.tutorTitleBlock}>
            <Text style={styles.tutorTitle}>Tutor</Text>
            <Text style={styles.tutorStatus}>{statusText}</Text>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.transcriptContent}
          onContentSizeChange={() => transcriptScrollRef.current?.scrollToEnd({ animated: true })}
          ref={transcriptScrollRef}
          style={styles.transcript}
        >
          {transcript.length === 0 && !assistantDraft ? (
            <View style={styles.emptyTranscript}>
              <ActivityIndicator color="#111827" />
              <Text style={styles.emptyTranscriptText}>
                Starting voice tutoring from the extracted question...
              </Text>
            </View>
          ) : null}
          {transcript.map((entry) => (
            <View key={entry.id} style={styles.transcriptLine}>
              <Text style={styles.transcriptRole}>
                {transcriptRoleLabel(entry.role)}
              </Text>
              <Text style={styles.transcriptText}>{entry.text}</Text>
              {entry.image ? (
                <Image
                  resizeMode="contain"
                  source={{ uri: entry.image.uri }}
                  style={[
                    styles.transcriptImage,
                    { aspectRatio: entry.image.width / entry.image.height },
                  ]}
                />
              ) : null}
            </View>
          ))}
          {assistantDraft ? (
            <View style={styles.transcriptLine}>
              <Text style={styles.transcriptRole}>Tutor</Text>
              <Text style={styles.transcriptText}>{assistantDraft}</Text>
            </View>
          ) : null}
        </ScrollView>

        {errorMessage ? <Text style={styles.tutorErrorText}>{errorMessage}</Text> : null}

        <View style={styles.tutorControls}>
          <Pressable
            accessibilityLabel={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            disabled={!tutorSession}
            onPress={toggleMute}
            style={[styles.micButton, isMuted && styles.micButtonMuted, !tutorSession && styles.disabledButton]}
          >
            {isMuted ? (
              <MicOff color="#ffffff" size={21} strokeWidth={2.4} />
            ) : (
              <Mic color="#ffffff" size={21} strokeWidth={2.4} />
            )}
          </Pressable>
          <TextInput
            editable={Boolean(tutorSession)}
            onChangeText={setFollowUpText}
            onSubmitEditing={sendFollowUpText}
            placeholder="Ask a follow-up"
            placeholderTextColor="#6b7280"
            returnKeyType="send"
            style={styles.followUpInput}
            value={followUpText}
          />
          <Pressable
            accessibilityLabel="Send follow-up"
            disabled={!tutorSession || !followUpText.trim()}
            onPress={sendFollowUpText}
            style={[
              styles.sendButton,
              (!tutorSession || !followUpText.trim()) && styles.disabledButton,
            ]}
          >
            <Send color="#ffffff" size={20} strokeWidth={2.4} />
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  sourceScreen: {
    backgroundColor: '#ffffff',
    flex: 1,
  },
  sourceContent: {
    flex: 1,
    gap: 24,
    justifyContent: 'center',
    padding: 24,
  },
  sourceTitle: {
    color: '#111827',
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
  },
  sourceActions: {
    gap: 14,
  },
  sourcePrimaryButton: {
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: 18,
  },
  sourcePrimaryButtonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '800',
  },
  sourceSecondaryButton: {
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: 18,
  },
  sourceSecondaryButtonText: {
    color: '#111827',
    fontSize: 17,
    fontWeight: '800',
  },
  sourceErrorText: {
    color: '#b91c1c',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  cameraScreen: {
    backgroundColor: '#000000',
    flex: 1,
  },
  cameraHeader: {
    left: 18,
    position: 'absolute',
    top: 58,
    zIndex: 2,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(17, 24, 39, 0.58)',
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  lightIconButton: {
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  camera: {
    flex: 1,
  },
  permissionPanel: {
    alignItems: 'center',
    flex: 1,
    gap: 18,
    justifyContent: 'center',
    padding: 24,
  },
  permissionText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  permissionSubtext: {
    color: '#d1d5db',
    fontSize: 15,
    lineHeight: 21,
    maxWidth: 280,
    textAlign: 'center',
  },
  cameraFooter: {
    alignItems: 'center',
    bottom: 42,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 34,
    position: 'absolute',
    right: 0,
  },
  cameraGalleryButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(17, 24, 39, 0.58)',
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  cameraFooterSpacer: {
    width: 56,
  },
  shutterButton: {
    alignItems: 'center',
    borderColor: '#ffffff',
    borderRadius: 38,
    borderWidth: 4,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  shutterInner: {
    backgroundColor: '#ffffff',
    borderRadius: 28,
    height: 56,
    width: 56,
  },
  disabledButton: {
    opacity: 0.45,
  },
  errorText: {
    alignSelf: 'center',
    bottom: 134,
    color: '#fecaca',
    fontSize: 15,
    fontWeight: '700',
    position: 'absolute',
  },
  previewScreen: {
    backgroundColor: '#000000',
    flex: 1,
  },
  previewImage: {
    flex: 1,
  },
  previewActions: {
    alignItems: 'center',
    bottom: 34,
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  previewErrorText: {
    alignSelf: 'center',
    bottom: 100,
    color: '#fecaca',
    fontSize: 15,
    fontWeight: '700',
    paddingHorizontal: 20,
    position: 'absolute',
    textAlign: 'center',
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 18,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '700',
  },
  reviewScreen: {
    backgroundColor: '#f9fafb',
    flex: 1,
  },
  reviewHeader: {
    alignItems: 'center',
    borderBottomColor: '#e5e7eb',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  reviewTitleBlock: {
    flex: 1,
  },
  reviewTitle: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '800',
  },
  reviewStatus: {
    color: '#4b5563',
    fontSize: 14,
    marginTop: 2,
  },
  reviewContent: {
    gap: 14,
    padding: 18,
    paddingBottom: 108,
  },
  reviewImage: {
    alignSelf: 'center',
    backgroundColor: '#000000',
    borderRadius: 8,
    height: 260,
    width: '100%',
  },
  reviewMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  reviewMetaText: {
    color: '#374151',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  reviewLabel: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  reviewQuestionInput: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderRadius: 8,
    borderWidth: 1,
    color: '#111827',
    fontSize: 18,
    lineHeight: 26,
    minHeight: 220,
    padding: 14,
  },
  reviewErrorText: {
    color: '#b91c1c',
    fontSize: 14,
    fontWeight: '700',
  },
  reviewActions: {
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderTopColor: '#e5e7eb',
    borderTopWidth: 1,
    bottom: 0,
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'center',
    left: 0,
    padding: 14,
    position: 'absolute',
    right: 0,
  },
  authScreen: {
    backgroundColor: '#ffffff',
    flex: 1,
  },
  authHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    padding: 18,
  },
  authTitle: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '800',
  },
  authText: {
    color: '#374151',
    fontSize: 15,
    lineHeight: 21,
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  authFallback: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  authWebView: {
    flex: 1,
  },
  tutorScreen: {
    backgroundColor: '#f9fafb',
    flex: 1,
  },
  tutorHeader: {
    alignItems: 'center',
    borderBottomColor: '#e5e7eb',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  tutorTitleBlock: {
    flex: 1,
  },
  tutorTitle: {
    color: '#111827',
    fontSize: 22,
    fontWeight: '800',
  },
  tutorStatus: {
    color: '#4b5563',
    fontSize: 14,
    marginTop: 2,
  },
  endButton: {
    alignItems: 'center',
    backgroundColor: '#b91c1c',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 7,
    minHeight: 42,
    paddingHorizontal: 14,
  },
  endButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    gap: 14,
    padding: 18,
  },
  emptyTranscript: {
    alignItems: 'center',
    gap: 12,
    justifyContent: 'center',
    minHeight: 220,
  },
  emptyTranscriptText: {
    color: '#4b5563',
    fontSize: 16,
    textAlign: 'center',
  },
  transcriptLine: {
    gap: 4,
  },
  transcriptRole: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  transcriptText: {
    color: '#111827',
    fontSize: 17,
    lineHeight: 24,
  },
  transcriptImage: {
    backgroundColor: '#f9fafb',
    borderColor: '#d1d5db',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 6,
    maxHeight: 420,
    width: '100%',
  },
  tutorErrorText: {
    color: '#b91c1c',
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  tutorControls: {
    alignItems: 'center',
    borderTopColor: '#e5e7eb',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  micButton: {
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 8,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  micButtonMuted: {
    backgroundColor: '#6b7280',
  },
  followUpInput: {
    backgroundColor: '#ffffff',
    borderColor: '#d1d5db',
    borderRadius: 8,
    borderWidth: 1,
    color: '#111827',
    flex: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 8,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
});
