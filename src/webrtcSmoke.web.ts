type WebRTCSmokeResult = {
  ok: false;
  platform: 'web';
  reason: 'web_not_targeted';
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
