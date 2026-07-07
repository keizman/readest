#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"

export PATH="/opt/homebrew/opt/node@24/bin:${PNPM_HOME:-$ROOT_DIR/.pnpm-home}/bin:$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/28.2.13676358}"

export CARGO_BUILD_JOBS="$JOBS"
export CMAKE_BUILD_PARALLEL_LEVEL="$JOBS"
export GRADLE_OPTS="-Dorg.gradle.parallel=true -Dorg.gradle.workers.max=${JOBS} -Dorg.gradle.caching=true"
export NEXT_TELEMETRY_DISABLED=1

cd "$APP_DIR"
pnpm tauri android build -t aarch64 --apk --split-per-abi "$@"

pick_apk() {
  local dir="$1" name="$2"
  if [[ -f "$dir/$name" ]]; then
    echo "$dir/$name"
    return 0
  fi
  return 1
}

APK=""
for candidate in \
  "arm64/release/app-arm64-release-unsigned.apk" \
  "arm64/release/app-arm64-release.apk" \
  "universal/release/app-universal-release-unsigned.apk" \
  "universal/release/app-universal-release.apk"; do
  if [[ -f "$APP_DIR/src-tauri/gen/android/app/build/outputs/apk/$candidate" ]]; then
    APK="$APP_DIR/src-tauri/gen/android/app/build/outputs/apk/$candidate"
    break
  fi
done
if [[ -z "$APK" ]]; then
  echo "No release APK found under src-tauri/gen/android/app/build/outputs/apk/" >&2
  exit 1
fi

if [[ "$APK" == *-unsigned.apk ]]; then
  SIGNED_APK="${APK%-unsigned.apk}.apk"
  bash "$APP_DIR/scripts/sign-android-apk.sh" "$APK" "$SIGNED_APK"
  APK="$SIGNED_APK"
fi

echo ""
echo "Built APK: $APK"
echo "Install:   pnpm install-android-apk $APK"