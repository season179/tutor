import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { ArrowLeft, Camera, Check, RotateCcw } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type Screen = 'home' | 'camera' | 'preview';
type CapturedPhoto = {
  uri: string;
  width: number;
  height: number;
};

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

export default function App() {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [screen, setScreen] = useState<Screen>('home');
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => deleteTemporaryPhoto(photo?.uri);
  }, [photo?.uri]);

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
    setIsTakingPhoto(false);
    setIsCameraReady(false);
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
    setErrorMessage(null);
    setScreen('camera');
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

  if (screen === 'preview' && photo) {
    return (
      <SafeAreaView style={styles.previewScreen}>
        <StatusBar style="light" />
        <Image resizeMode="contain" source={{ uri: photo.uri }} style={styles.previewImage} />
        <View style={styles.previewActions}>
          <Pressable onPress={retakePhoto} style={styles.secondaryButton}>
            <RotateCcw color="#111827" size={19} strokeWidth={2.2} />
            <Text style={styles.secondaryButtonText}>Retake</Text>
          </Pressable>
          <Pressable onPress={returnHome} style={styles.primaryButton}>
            <Check color="#ffffff" size={20} strokeWidth={2.4} />
            <Text style={styles.primaryButtonText}>Done</Text>
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
});
