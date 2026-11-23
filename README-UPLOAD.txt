NEW REPO - upload everything in this zip (keep the folder names: .github/workflows, native, tests).

STILL COPY FROM YOUR OLD REPO (these were never given to Claude, so they are not in this zip):
  manifest.json
  icon-192.png  icon-512.png  icon-maskable-512.png
  assets/icon.png            (optional, launcher icon)
  tests/nlu-quick.js  tests/va-tests.js   (optional; the workflow skips them if missing)

After the FIRST successful run: download the "package-lock" artifact and upload package-lock.json to the repo root.
rc-debug.keystore must stay the same file (same signing key = new APK installs over the old app and keeps data).
Do NOT upload piper-entry.js (no longer used).
