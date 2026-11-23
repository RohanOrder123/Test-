# Verification checklist

## CI checks configured by this update

The GitHub Actions workflow is designed to fail if any of the following is missing:

- Required web application, Capacitor configuration, native plugin source and signing keystore.
- Sherpa-ONNX 1.13.8 dependency declaration and JitPack repository configuration.
- Native plugin registration in `MainActivity`.
- Hindi and English Piper model files and `tokens.txt`.
- eSpeak-NG phonemizer data (`phondata`, `phonindex`, `phontab`, `intonations`, `en_dict`, `hi_dict`).
- Sherpa-ONNX JNI library for `arm64-v8a` and the native plugin class in the resulting APK.
- Expected web assets, voice models, manifest entries and APK signing.

## Required Android device tests after the first successful build

1. Install the generated APK over the existing app. The workflow retains `rc-debug.keystore`; do not replace it.
2. Call `SherpaTts.status()` and confirm `nativeOk: true`, both voice model assets are listed, and `espeakInApk: true`.
3. Call `SherpaTts.selfTest({voice: 'hi_IN-priyamvada-medium', text: 'नमस्ते, यह हिंदी आवाज़ की जाँच है।'})`. Confirm `ok`, `modelLoaded`, and `phonemizerOk` are true, `samples` and `sampleRate` are positive, `peak` is above zero, and `audioSec` is positive.
4. Repeat with `voice: 'en_US-amy-medium'` and English text.
5. Call `SherpaTts.speak()` with both voices and confirm audible playback.
6. Start a longer utterance, call `SherpaTts.stop()`, and confirm the pending `speak()` resolves with `interrupted: true` without hanging.
7. Repeat a short utterance and confirm the existing short-phrase cache still behaves normally.

## Current status

- Source/workflow static review: completed for this prepared patch.
- GitHub Actions dependency resolution and APK build: not run here.
- Runtime phonemizer/synthesis on a physical Android device: not run here.
- Hindi and English audible playback: not yet verified.

A successful APK build alone does not prove that both voice models synthesize correctly. The two `selfTest()` calls and audible playback checks above are required before marking the feature verified.
