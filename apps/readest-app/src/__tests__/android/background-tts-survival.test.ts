import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const manifest = readFileSync(
  resolve(process.cwd(), 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
  'utf-8',
);
const mediaPlaybackService = readFileSync(
  resolve(
    process.cwd(),
    'src-tauri/plugins/tauri-plugin-native-tts/android/src/main/java/MediaPlaybackService.kt',
  ),
  'utf-8',
);

describe('Android background TTS survival', () => {
  test('declares wake-lock access for foreground audio playback', () => {
    expect(manifest).toContain('android.permission.WAKE_LOCK');
  });

  test('keeps the CPU awake through the Media3 player while TTS is active', () => {
    expect(mediaPlaybackService).toContain('setWakeMode(C.WAKE_MODE_LOCAL)');
  });
});
