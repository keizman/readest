#!/usr/bin/env bash
# Sign an unsigned Android APK with the default debug keystore for local adb install.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <unsigned.apk> [signed.apk]" >&2
  exit 1
fi

INPUT_APK="$1"
OUTPUT_APK="${2:-${INPUT_APK%-unsigned.apk}.apk}"
if [[ "$OUTPUT_APK" == "$INPUT_APK" ]]; then
  OUTPUT_APK="${INPUT_APK%.apk}-signed.apk"
fi

if [[ ! -f "$INPUT_APK" ]]; then
  echo "Input APK not found: $INPUT_APK" >&2
  exit 1
fi

INPUT_SIZE="$(wc -c <"$INPUT_APK" | tr -d ' ')"
if [[ "$INPUT_SIZE" -lt 1000000 ]]; then
  echo "Input APK is too small ($INPUT_SIZE bytes). File is likely corrupt." >&2
  exit 1
fi

if ! head -c 2 "$INPUT_APK" | grep -q 'PK'; then
  echo "Input file is not a valid ZIP/APK. Do not rename *-unsigned.apk manually." >&2
  exit 1
fi

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BUILD_TOOLS="$(ls -1d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
if [[ -z "$BUILD_TOOLS" ]]; then
  echo "apksigner not found. Set ANDROID_HOME and install build-tools." >&2
  exit 1
fi

DEBUG_KEYSTORE="${DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
if [[ ! -f "$DEBUG_KEYSTORE" ]]; then
  mkdir -p "$(dirname "$DEBUG_KEYSTORE")"
  keytool -genkeypair -v \
    -keystore "$DEBUG_KEYSTORE" \
    -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass android -keypass android \
    -dname "CN=Android Debug,O=Android,C=US"
fi

rm -f "$OUTPUT_APK"

"$BUILD_TOOLS" sign \
  --ks "$DEBUG_KEYSTORE" \
  --ks-pass pass:android \
  --ks-key-alias androiddebugkey \
  --key-pass pass:android \
  --out "$OUTPUT_APK" \
  "$INPUT_APK"

"$BUILD_TOOLS" verify --verbose "$OUTPUT_APK"

OUTPUT_SIZE="$(wc -c <"$OUTPUT_APK" | tr -d ' ')"
if [[ "$OUTPUT_SIZE" -lt 1000000 ]]; then
  echo "Signed APK is too small ($OUTPUT_SIZE bytes). Signing failed." >&2
  exit 1
fi

echo "Signed APK: $OUTPUT_APK ($(( OUTPUT_SIZE / 1024 / 1024 )) MB)"