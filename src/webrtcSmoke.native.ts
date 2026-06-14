import { Platform } from 'react-native';

type NativeWebRTCSmokeResult =
  | {
      ok: true;
      platform: typeof Platform.OS;
      connectionState: string;
      iceGatheringState: string;
      signalingState: string;
    }
  | {
      ok: false;
      platform: typeof Platform.OS;
      reason: 'native_module_unavailable';
      message: string;
    };

export async function runNativeWebRTCSmokeTest(): Promise<NativeWebRTCSmokeResult> {
  try {
    const { RTCPeerConnection } = await import('react-native-webrtc');
    const peerConnection = new RTCPeerConnection({ iceServers: [] });

    peerConnection.createDataChannel('tutor-smoke');

    const result: NativeWebRTCSmokeResult = {
      ok: true,
      platform: Platform.OS,
      connectionState: peerConnection.connectionState,
      iceGatheringState: peerConnection.iceGatheringState,
      signalingState: peerConnection.signalingState,
    };

    peerConnection.close();
    return result;
  } catch (error) {
    return {
      ok: false,
      platform: Platform.OS,
      reason: 'native_module_unavailable',
      message:
        error instanceof Error
          ? error.message
          : 'Could not create a native WebRTC peer connection.',
    };
  }
}
