#!/usr/bin/env bash
# scripts/build-apk.sh
#
# Local APK build — same flow the GitHub Actions workflow runs, but
# usable from a dev laptop.
#
# Requirements:
#   - Node 18+ (for @bubblewrap/cli)
#   - JDK 17 (Temurin recommended)
#   - Android SDK with platforms;android-33 + build-tools;33.0.2
#   - The deployed site must be reachable at the HOST you pass in
#
# Usage:
#   scripts/build-apk.sh [host]
#
# host defaults to gabriella.vercel.app. The resulting APK is written
# to ./gabriella-release.apk.
#
# The script generates an ephemeral debug keystore for sideload testing.
# For Play Store builds, drop a real android.keystore at the repo root
# and set BW_KEYSTORE_PASSWORD / BW_KEY_PASSWORD / BW_KEY_ALIAS in your
# environment before running.

set -euo pipefail

HOST="${1:-gabriella.vercel.app}"
BUILD_DIR="twa-build"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

echo "→ Checking tool chain"
command -v node       >/dev/null || { echo "node not installed"; exit 1; }
command -v java       >/dev/null || { echo "java not installed (need JDK 17)"; exit 1; }
command -v keytool    >/dev/null || { echo "keytool not found on PATH"; exit 1; }

echo "→ Resolving bubblewrap"
if ! command -v bubblewrap >/dev/null; then
  echo "   installing @bubblewrap/cli globally"
  npm install -g @bubblewrap/cli@1.22.0
fi

echo "→ Patching twa-manifest.json for host=$HOST"
node - <<NODE
const fs = require("fs");
const m  = JSON.parse(fs.readFileSync("twa-manifest.json", "utf8"));
m.host            = "$HOST";
m.iconUrl         = "https://$HOST/icon-512.png";
m.maskableIconUrl = "https://$HOST/icon-512.png";
m.webManifestUrl  = "https://$HOST/manifest.webmanifest";
m.fullScopeUrl    = "https://$HOST/";
fs.writeFileSync("twa-manifest.json", JSON.stringify(m, null, 2));
NODE

echo "→ Confirming manifest is reachable"
if ! curl -sf "https://$HOST/manifest.webmanifest" > /dev/null; then
  echo "   FAIL: https://$HOST/manifest.webmanifest is unreachable"
  echo "   Deploy the site (or set HOST to an alternate host) and retry."
  exit 1
fi

echo "→ Preparing keystore"
if [ ! -f android.keystore ]; then
  echo "   generating ephemeral debug keystore"
  keytool -genkeypair \
    -keystore android.keystore \
    -alias android \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass android -keypass android \
    -dname "CN=Gabriella, OU=Dev, O=Gabriella, L=Local, S=Local, C=US"
fi
: "${BW_KEYSTORE_PASSWORD:=android}"
: "${BW_KEY_PASSWORD:=android}"
: "${BW_KEY_ALIAS:=android}"
export BW_KEYSTORE_PASSWORD BW_KEY_PASSWORD BW_KEY_ALIAS

echo "→ Seeding ~/.bubblewrap/config.json (skips JDK/SDK prompts)"
mkdir -p ~/.bubblewrap
JDK_PATH="${BW_JDK_PATH:-${JAVA_HOME:-}}"
SDK_PATH="${BW_SDK_PATH:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}}"
if [ -z "$JDK_PATH" ] || [ -z "$SDK_PATH" ]; then
  echo "   WARN: JDK_PATH or SDK_PATH is empty. Set JAVA_HOME + ANDROID_HOME (or BW_JDK_PATH / BW_SDK_PATH) before running, otherwise bubblewrap will prompt and abort." >&2
fi
cat > ~/.bubblewrap/config.json <<JSON
{
  "jdkPath": "${JDK_PATH}",
  "androidSdkPath": "${SDK_PATH}"
}
JSON

echo "→ Running bubblewrap build"
rm -rf "$BUILD_DIR"
mkdir  "$BUILD_DIR"
cd "$BUILD_DIR"
# bubblewrap init's --manifest wants a URL to the live Web App
# Manifest (not our local twa-manifest.json). It generates a scaffold
# + a fresh twa-manifest.json from the URL; we then overwrite it with
# our committed one and run `update` to regenerate the Android
# project against our overrides. --skipPwaValidation avoids
# eligibility checks that often reject Next.js PWAs.
bubblewrap init --manifest "https://${HOST}/manifest.webmanifest" --skipPwaValidation
cp ../twa-manifest.json ./twa-manifest.json
bubblewrap update --skipPwaValidation
cp ../android.keystore ./android.keystore
bubblewrap build --skipPwaValidation

APK_PATH=$(find . -maxdepth 3 -name "*.apk" -print -quit)
if [ -z "$APK_PATH" ]; then
  echo "FAIL: no APK produced" >&2
  exit 1
fi

cd "$ROOT_DIR"
cp "$BUILD_DIR/$APK_PATH" gabriella-release.apk
echo
echo "✔ APK built: $(pwd)/gabriella-release.apk"
ls -lh gabriella-release.apk
