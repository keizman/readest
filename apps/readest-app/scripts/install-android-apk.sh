#!/usr/bin/env bash
# Install an Android APK via adb push (reliable for large APKs and odd host paths).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <apk>" >&2
  exit 1
fi

APK="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if [[ ! -f "$APK" ]]; then
  echo "APK not found: $APK" >&2
  exit 1
fi

SIZE="$(wc -c <"$APK" | tr -d ' ')"
if [[ "$SIZE" -lt 1000000 ]]; then
  echo "APK is too small ($SIZE bytes). File is corrupt or incomplete." >&2
  exit 1
fi

if ! head -c 2 "$APK" | grep -q 'PK'; then
  echo "Not a valid APK/ZIP file (missing PK header)." >&2
  exit 1
fi

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
APKSIGNER="$(ls -1d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "$APKSIGNER" ]]; then
  "$APKSIGNER" verify --verbose "$APK"
fi

REMOTE="/data/local/tmp/readest-install.apk"
echo "Pushing $APK ($(( SIZE / 1024 / 1024 )) MB) -> $REMOTE"
adb push "$APK" "$REMOTE"
adb shell pm install -r "$REMOTE"
adb shell rm -f "$REMOTE"
echo "Installed successfully."