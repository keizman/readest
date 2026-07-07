#!/usr/bin/env bash
# Frontend build for Tauri/Android with retries. A cold .next (or a stale lock
# from an interrupted build) can make Next.js 16 fail once on pages-manifest;
# a second pass succeeds.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MAX_ATTEMPTS="${BUILD_FRONTEND_MAX_ATTEMPTS:-3}"

cd "$APP_DIR"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if ./node_modules/.bin/dotenv -e .env.tauri -- ./node_modules/.bin/next build --webpack; then
    exit 0
  fi

  echo "Frontend build attempt ${attempt}/${MAX_ATTEMPTS} failed." >&2
  rm -f .next/lock

  if [[ "$attempt" -eq "$MAX_ATTEMPTS" ]]; then
    echo "Frontend build failed after ${MAX_ATTEMPTS} attempts." >&2
    exit 1
  fi

  sleep 2
done