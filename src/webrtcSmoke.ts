export type WebRTCSmokeResult =
  | {
      ok: true;
      platform: string;
      connectionState: string;
      iceGatheringState: string;
      signalingState: string;
    }
  | {
      ok: false;
      platform: string;
      reason: 'web_not_targeted' | 'native_module_unavailable';
      message: string;
    };

export async function runNativeWebRTCSmokeTest(): Promise<WebRTCSmokeResult> {
  return {
    ok: false,
    platform: 'web',
    reason: 'web_not_targeted',
    message: 'WebRTC native smoke test only runs in native development builds.',
  };
}
