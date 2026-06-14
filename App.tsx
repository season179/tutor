import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import {
  ArrowLeft,
  Camera,
  Check,
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
import { extractAccessCookie, type TutorAccess } from './src/tutorBackend';
import { runNativeWebRTCSmokeTest } from './src/webrtcSmoke';

type Screen = 'home' | 'camera' | 'preview' | 'auth' | 'tutor';
type CapturedPhoto = {
  uri: string;
  width: number;
  height: number;
};

const ACCESS_COOKIE_SCRIPT = `
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'cookies',
    cookie: document.cookie,
    url: window.location.href
  }));
  true;
`;

function deleteTemporaryPhoto(uri?: string) {
  if (!uri || Platform.OS === 'web' || uri.startsWith('data:')) {
    return;
  }

  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Temporary cleanup should never interrupt the capture flow.
  }
}

function photoContentType(uri: string): string {
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

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export default function App() {
  const cameraRef = useRef<CameraView>(null);
  const transcriptScrollRef = useRef<ScrollView>(null);
  const tutorSessionRef = useRef<TutorRealtimeSession | null>(null);
  const accessStartRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [screen, setScreen] = useState<Screen>('home');
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [access, setAccess] = useState<TutorAccess | null>(null);
  const [tutorSession, setTutorSession] = useState<TutorRealtimeSession | null>(null);
  const [transcript, setTranscript] = useState<TutorTranscriptEntry[]>([]);
  const [assistantDraft, setAssistantDraft] = useState('');
  const [followUpText, setFollowUpText] = useState('');
  const [statusText, setStatusText] = useState('Ready');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [isStartingTutor, setIsStartingTutor] = useState(false);
  const [isEndingTutor, setIsEndingTutor] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => deleteTemporaryPhoto(photo?.uri);
  }, [photo?.uri]);

  useEffect(() => {
    tutorSessionRef.current = tutorSession;
  }, [tutorSession]);

  useEffect(() => {
    return () => {
      void tutorSessionRef.current?.end('cancelled');
    };
  }, []);

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
    setScreen('camera');

    if (!permission?.granted) {
      await requestPermission();
    }
  }

  function returnHome() {
    deleteTemporaryPhoto(photo?.uri);
    setPhoto(null);
    setTutorSession(null);
    accessStartRef.current = false;
    setTranscript([]);
    setAssistantDraft('');
    setFollowUpText('');
    setIsMuted(false);
    setIsTakingPhoto(false);
    setIsCameraReady(false);
    setIsStartingTutor(false);
    setIsEndingTutor(false);
    setStatusText('Ready');
    setErrorMessage(null);
    setScreen('home');
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
        setPhoto({
          uri: result.uri,
          width: result.width,
          height: result.height,
        });
        setScreen('preview');
      }
    } catch {
      setErrorMessage('Could not take photo.');
    } finally {
      setIsTakingPhoto(false);
    }
  }

  function retakePhoto() {
    deleteTemporaryPhoto(photo?.uri);
    setPhoto(null);
    accessStartRef.current = false;
    setErrorMessage(null);
    setScreen('camera');
  }

  async function startTutorFromPreview(nextAccess = access) {
    if (!photo) {
      return;
    }

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
    setStatusText('Connecting...');
    setScreen('tutor');

    try {
      const session = await startTutorRealtimeSession({
        backendUrl: TUTOR_BACKEND_URL,
        access: nextAccess,
        photoUri: photo.uri,
        photoContentType: photoContentType(photo.uri),
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
      deleteTemporaryPhoto(photo.uri);
      setPhoto(null);
      setStatusText('Listening...');
    } catch (error) {
      setErrorMessage(messageFromError(error));
      setStatusText('Could not start tutor.');
      setScreen('preview');
    } finally {
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
    void startTutorFromPreview(nextAccess);
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

  async function endTutorSession(status: 'ended' | 'failed' | 'cancelled' = 'ended') {
    setIsEndingTutor(true);
    try {
      await tutorSession?.end(status, status === 'failed' ? errorMessage || undefined : undefined);
    } finally {
      returnHome();
    }
  }

  if (screen === 'camera') {
    return (
      <SafeAreaView style={styles.cameraScreen}>
        <StatusBar style="light" />
        <View style={styles.cameraHeader}>
          <Pressable
            accessibilityLabel="Back"
            hitSlop={12}
            onPress={returnHome}
            style={styles.iconButton}
          >
            <ArrowLeft color="#ffffff" size={26} strokeWidth={2.3} />
          </Pressable>
        </View>

        {permission?.granted ? (
          <CameraView
            active={screen === 'camera'}
            facing="back"
            mode="picture"
            onCameraReady={() => setIsCameraReady(true)}
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

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

        {permission?.granted ? (
          <View style={styles.cameraFooter}>
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
            onPress={() => setScreen(photo ? 'preview' : 'home')}
            style={styles.lightIconButton}
          >
            <ArrowLeft color="#111827" size={25} strokeWidth={2.3} />
          </Pressable>
          <Text style={styles.authTitle}>Sign in</Text>
        </View>
        <Text style={styles.authText}>
          Use your Cloudflare Access email PIN. The tutor will start after sign-in.
        </Text>
        {Platform.OS === 'web' ? (
          <View style={styles.authFallback}>
            <Text style={styles.authText}>Realtime voice tutoring requires a native dev build.</Text>
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
            onPress={() => void startTutorFromPreview()}
            style={[styles.primaryButton, isStartingTutor && styles.disabledButton]}
          >
            {isStartingTutor ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Check color="#ffffff" size={20} strokeWidth={2.4} />
            )}
            <Text style={styles.primaryButtonText}>Start tutor</Text>
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
          <View>
            <Text style={styles.tutorTitle}>Tutor</Text>
            <Text style={styles.tutorStatus}>{statusText}</Text>
          </View>
          <Pressable
            accessibilityLabel="End session"
            disabled={isEndingTutor}
            onPress={() => void endTutorSession('ended')}
            style={styles.endButton}
          >
            <LogOut color="#ffffff" size={18} strokeWidth={2.3} />
            <Text style={styles.endButtonText}>End</Text>
          </Pressable>
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
                Starting voice tutoring from the photo...
              </Text>
            </View>
          ) : null}
          {transcript.map((entry) => (
            <View key={entry.id} style={styles.transcriptLine}>
              <Text style={styles.transcriptRole}>
                {entry.role === 'assistant' ? 'Tutor' : 'Student'}
              </Text>
              <Text style={styles.transcriptText}>{entry.text}</Text>
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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hi!</Text>
      <Pressable onPress={openCamera} style={styles.captureButton}>
        <Camera color="#ffffff" size={22} strokeWidth={2.4} />
        <Text style={styles.captureButtonText}>Capture</Text>
      </Pressable>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#fff',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#111827',
    fontSize: 42,
    fontWeight: '700',
    marginBottom: 28,
    textAlign: 'center',
  },
  captureButton: {
    alignItems: 'center',
    backgroundColor: '#111827',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 22,
  },
  captureButtonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  cameraScreen: {
    backgroundColor: '#000000',
    flex: 1,
  },
  cameraHeader: {
    left: 18,
    position: 'absolute',
    top: 18,
    zIndex: 2,
  },
  iconButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(17, 24, 39, 0.58)',
    borderRadius: 24,
    height: 48,
    justifyContent: 'center',
    width: 48,
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
  cameraFooter: {
    alignItems: 'center',
    bottom: 42,
    left: 0,
    position: 'absolute',
    right: 0,
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
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
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
