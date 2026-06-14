# Native Development Builds

This app needs a native Expo development build for Realtime voice because `react-native-webrtc` includes custom native code. Expo Go is not expected to support this flow.

## Installed Native Pieces

- `expo-dev-client` for local development builds.
- `react-native-webrtc` for native WebRTC peer connections.
- `@config-plugins/react-native-webrtc` to apply the required native iOS and Android configuration during prebuild.

The WebRTC config plugin sets Android network/audio permissions, including `RECORD_AUDIO`, and adds iOS camera and microphone usage descriptions. The app also keeps the existing Expo Camera plugin for the photo capture flow.

## Local Build Commands

Install dependencies:

```sh
pnpm install
```

Build and launch a native development build:

```sh
pnpm dev:ios
```

or:

```sh
pnpm dev:android
```

After the dev build is installed on the device or simulator, start Metro for that dev client:

```sh
pnpm start:dev-client
```

Open the installed `tutor` development build and connect it to Metro. Do not use Expo Go for the WebRTC voice work.

## WebRTC Smoke Check

In native development builds, the app runs a dev-only startup smoke check that creates and closes an `RTCPeerConnection` with a data channel. The check does not request microphone access and does not start a tutor session.

Look in the Metro logs for:

```json
{"service":"tutor-app","event":"webrtc_peer_connection_smoke","ok":true}
```

If the app is launched in Expo Go or without the native WebRTC module, the log will report `ok: false` with `native_module_unavailable`. That means the native development build needs to be rebuilt or relaunched.

## Camera Flow Check

After installing the dev build:

1. Launch the app.
2. Confirm the home screen still shows `Hi!` and the `Capture` button.
3. Tap `Capture`.
4. Allow camera access.
5. Take a photo, then verify `Retake` and `Done` still work.
