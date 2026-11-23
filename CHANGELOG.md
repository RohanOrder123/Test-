# Changelog

## Prepared update — 2026-11-23

- Pin the Android Sherpa-ONNX integration to **1.13.8**, matching the legacy Piper VITS + eSpeak-NG phonemizer configuration used by `SherpaTtsPlugin.java`.
- Resolve the Android artifact through the documented JitPack coordinate instead of the workflow's unverified 2.0.3 static-AAR filename and hard-coded byte count.
- Keep the two existing Piper voice IDs and APK asset layout unchanged: `hi_IN-priyamvada-medium` and `en_US-amy-medium`.
- Validate copied eSpeak-NG data files before accepting the completion marker; report incomplete phonemizer data with a dedicated `PHONEMIZER_FAIL` error.
- Expand `selfTest()` to report model initialization, successful phonemizer-backed synthesis, sample count, sample rate, peak amplitude, audio duration, synthesis time and real-time factor.
- Preserve Capacitor 6.2.0, app ID, JavaScript voice bridge, playback, chunking, caching, stop/interruption handling and signing-key workflow.

## Verification status

These files have been statically reviewed and generated from the uploaded project. A GitHub Actions build and on-device Hindi/English playback test have **not** been run in this environment. See `VERIFICATION.md`.
