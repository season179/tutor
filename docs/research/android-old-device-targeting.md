# Research: Targeting an older Android device (≈5 years old) with this app

**Date:** 2026-06-13
**Project:** `tutor` — Expo SDK 56 / React Native 0.85.3 / React 19.2.3
**Question:** How do we develop a React Native app that targets a ~5-year-old Android device?

> Interpretation: "5 years old" = an Android **device** from mid-2021. The project is brand new (latest Expo SDK), so the question is about device compatibility, not legacy codebase migration.

---

## TL;DR

**A 5-year-old Android device is trivially supported — no special configuration needed.** This project already sets the bar far lower than required:

- It supports devices all the way back to **Android 7.0 (API 24, August 2016)**.
- A mid-2021 phone ships/runs **Android 11–12 (API 30–31)** — comfortably inside the supported range and still among the most common Android versions worldwide.
- The only real "old device" concerns are **performance** (RAM/CPU), not compatibility.

---

## 1. What this project targets (authoritative, cross-validated)

Verified across three independent sources: Expo's official support table, the React Native 0.85 community template `build.gradle`, and the React Native 0.85.3 gradle-plugin source.

### Android build configuration

| Setting | Value | Meaning |
|---|---|---|
| `minSdkVersion` | **24** | Lowest OS the app can install = Android 7.0 Nougat (Aug 2016) |
| `compileSdkVersion` | **36** | Compiles against Android 16 |
| `targetSdkVersion` | **36** | Runtime behavior targets Android 16 |
| `buildToolsVersion` | **36.0.0** | Android build tools |
| `ndkVersion` | **27.1.12297006** | Native code (C++) toolchain |
| `kotlinVersion` | **2.1.20** | Kotlin compiler |
| Java / JDK | **17** | Forced by RN gradle plugin (`JavaVersion.VERSION_17`) |
| ABIs | `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64` | Default architecture set (32- and 64-bit ARM, plus x86 emulators) |

### Runtime / engine

| Concern | Status |
|---|---|
| **New Architecture** (Fabric + TurboModules) | **Mandatory, hardcoded ON** — `IS_NEW_ARCHITECTURE_ENABLED = "true"` in the RN 0.85 gradle plugin. There is no opt-out. |
| **Hermes V1** | Default JS engine (faster startup + lower memory than Hermes V0). Opt out via `expo-build-properties` → `useHermesV1: false` if needed. |
| Node.js | RN 0.85 needs **≥ 20.19.4**; **Expo SDK 56 requires 22.13.x** (stricter — Expo wins). |

### Sources
- Expo SDK support table: https://docs.expo.dev/versions/v56.0.0/ → *"Expo SDK 56.0.0 → Android 7+, compileSdkVersion 36, targetSdkVersion 36, Node 22.13.x"*
- Expo SDK 56 changelog: https://expo.dev/changelog/sdk-56
- RN 0.85 release notes: https://reactnative.dev/blog/2026/04/07/react-native-0.85
- RN 0.85 gradle-plugin source (JDK 17, New Arch hardcoded): https://github.com/facebook/react-native/tree/0.85-stable/packages/gradle-plugin
- RN 0.85 community template `android/build.gradle` (SDK floors): `@react-native-community/template@0.85.0-rc.0`

---

## 2. What "5 years old" actually means today

Today is 2026-06-13. Five years ago = **mid-2021**.

| Android version | API level | Released | A mid-2021 phone? |
|---|---|---|---|
| Android 11 | **30** | Sep 2020 | ✅ Most mid-2021 phones shipped with this |
| Android 12 | **31** | Oct 2021 | ✅ Flagships from late 2021 onward |
| Android 10 | 29 | Sep 2019 | Some budget 2021 phones, never updated |

So a 5-year-old device today runs **API 30–31** (Android 11 or 12) — and even a never-updated 2021 budget phone is at least API 29–30. All of these sit **6–7 API levels above** this project's `minSdkVersion` of 24.

**Conclusion:** an old device is not a compatibility problem here. The app's minimum (Android 7.0 / 2016) is roughly *nine years* older than the target device.

---

## 3. Google Play Store requirements (the real constraint)

The store — not React Native — is where API-level pressure comes from.

- **Since Aug 31, 2025:** New apps and updates must **target API 35+** (Android 15) to be accepted.
- **Existing apps:** must target API 34+ to remain discoverable to users on newer devices.
- This project targets **API 36** — already ahead of the requirement, so Play submission is fine.

Source: https://developer.android.com/google/play/requirements/target-sdk

---

## 4. Practical implications for developing on/for old hardware

Compatibility is solved out of the box. The remaining issues are **performance and UX on weak hardware**:

1. **Test on the actual device (or a matching emulator).** Create an AVD with a 2021-era profile: low RAM (4–6 GB), `arm64-v8a` or `x86_64`, Android 11/12 system image. Performance issues only surface on real hardware.
2. **Keep Hermes V1 ON.** Faster cold start + lower memory directly help low-end devices. Don't opt out unless something breaks.
3. **RAM pressure is the main risk.** Older devices get killed by the OS first. Avoid holding large data in JS memory; paginate lists (`FlashList`/`FlatList`), release camera/media resources promptly, use `expo-file-system` instead of base64 blobs.
4. **Startup time.** SDK 56 already cut `Activity.onCreate` ~1.7× (Expo's numbers). Further wins: minimize top-level imports, defer heavy modules (code-splitting / dynamic `import()`), prefer prebuilt native modules.
5. **APK size.** The default build ships four ABIs. For an old *arm64* device this is wasted bytes. Use **EAS Build APK splits** or App Bundle (`.aab`) so the Play Store serves only the device's ABI.
6. **32-bit (`armeabi-v7a`).** Only relevant if the target device is a *very* old 32-bit ARM phone. A 2021 device is `arm64-v8a`. If you want to drop 32-bit to slim the build, restrict `reactNativeArchitectures` — but you almost certainly don't need to for a 5-year-old phone.
7. **Edge-to-edge / system bars.** SDK 56 unifies `expo-status-bar` + `expo-navigation-bar`. Edge-to-edge is enabled by default; verify it looks right on the target device's specific Android version (Android 11/12 handle insets differently than 16).

---

## 5. Minimum useful device to test against

- **Representative target:** Android 11 (API 30), arm64-v8a, 4 GB RAM — e.g. a Pixel 4a / Galaxy S21-era AVD.
- **Floor (stress test):** Android 7.0 (API 24), 2 GB RAM — only if you genuinely care about sub-2017 devices. Not required for the "5-year-old" target.

---

## 6. Things you do **not** need to do

- ❌ Lower `minSdkVersion` — it's already at 24; lower isn't possible with RN 0.85 and isn't needed.
- ❌ Disable New Architecture — it's mandatory and runs on Android 7+.
- ❌ Downgrade Expo/RN — older SDKs would *reduce* old-device performance (no Hermes V1, slower cold start) and risk Play Store rejection (lower target API).
- ❌ Polyfill anything for "old Android" — JS engine is Hermes, not the system WebView, so the system Android version has no effect on JS feature support.

---

## 7. Recommended next steps (when you're ready to build)

1. `npx expo prebuild --platform android` (or `eas build`) to generate the native project — confirms the SDK floors above land in the generated `android/build.gradle`.
2. Spin up an Android 11 (API 30) AVD and `npx expo run:android`.
3. Profile cold start + memory on that emulator before optimizing.
4. Decide APK-split strategy once you measure real APK size.
