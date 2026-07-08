import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/image', () => ({
  fetchImageAsBase64: vi.fn().mockResolvedValue('data:image/png;base64,x'),
}));

import { TTSMediaBridge } from '@/services/tts/ttsMediaBridge';
import { TauriMediaSession } from '@/libs/mediaSession';
import { useSettingsStore } from '@/store/settingsStore';
import type { TTSController } from '@/services/tts/TTSController';

// A controller stand-in: EventTarget + the surface the bridge consumes.
class FakeController extends EventTarget {
  state = 'playing';
  terminated = false;
  pause = vi.fn().mockResolvedValue(true);
  start = vi.fn().mockResolvedValue(undefined);
  forward = vi.fn().mockResolvedValue(undefined);
  backward = vi.fn().mockResolvedValue(undefined);
  seekToTime = vi.fn().mockResolvedValue(undefined);
  ensureTimeline = vi.fn().mockResolvedValue(null);
  getPlaybackInfo = vi.fn().mockReturnValue({ position: 12, duration: 60, measuredFraction: 1 });

  emitMark(text: string, name: string) {
    this.dispatchEvent(new CustomEvent('tts-speak-mark', { detail: { text, name } }));
  }
  emitState(state: string) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('tts-state-change', { detail: { state } }));
  }
}

interface FakeWebMediaSession {
  metadata: unknown;
  metadataSets: unknown[];
  playbackState: string;
  handlers: Map<string, (details: MediaSessionActionDetails) => void>;
  setActionHandler: ReturnType<typeof vi.fn>;
  setPositionState: ReturnType<typeof vi.fn>;
}

const makeFakeMediaSession = (): FakeWebMediaSession => {
  const handlers = new Map<string, (details: MediaSessionActionDetails) => void>();
  let metadata: unknown = null;
  const session = {
    metadataSets: [] as unknown[],
    playbackState: 'none',
    handlers,
    setActionHandler: vi.fn(
      (action: string, cb: ((d: MediaSessionActionDetails) => void) | null) => {
        if (cb) handlers.set(action, cb);
        else handlers.delete(action);
      },
    ),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(session, 'metadata', {
    get: () => metadata,
    set: (value: unknown) => {
      metadata = value;
      session.metadataSets.push(value);
    },
    enumerable: true,
    configurable: true,
  });
  return session as FakeWebMediaSession;
};

const meta = (overrides = {}) => ({
  bookKey: 'hash-abc',
  title: 'Alice',
  author: 'Carroll',
  coverImageUrl: null,
  metadataMode: 'sentence' as const,
  ...overrides,
});

// jsdom lacks MediaMetadata; the bridge constructs it for the web path.
class FakeMediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork?: MediaImage[];
  constructor(init: { title: string; artist: string; album: string; artwork?: MediaImage[] }) {
    this.title = init.title;
    this.artist = init.artist;
    this.album = init.album;
    this.artwork = init.artwork;
  }
}
vi.stubGlobal('MediaMetadata', FakeMediaMetadata);

describe('TTSMediaBridge', () => {
  let controller: FakeController;
  let fake: FakeWebMediaSession;
  let bridge: TTSMediaBridge;

  beforeEach(() => {
    controller = new FakeController();
    fake = makeFakeMediaSession();
    bridge = new TTSMediaBridge(() => fake as unknown as MediaSession);
    useSettingsStore.setState({ settings: {} as never });
  });

  const bind = () => bridge.bind(controller as unknown as TTSController, meta());

  test('bind registers transport handlers that drive the controller', async () => {
    await bind();
    expect(fake.handlers.has('play')).toBe(true);
    fake.handlers.get('pause')!({} as MediaSessionActionDetails);
    expect(controller.pause).toHaveBeenCalled();
    controller.state = 'paused';
    fake.handlers.get('play')!({} as MediaSessionActionDetails);
    expect(controller.start).toHaveBeenCalled();
    fake.handlers.get('seekto')!({ seekTime: 42 } as MediaSessionActionDetails);
    expect(controller.seekToTime).toHaveBeenCalledWith(42);
    fake.handlers.get('nexttrack')!({} as MediaSessionActionDetails);
    expect(controller.forward).toHaveBeenCalled();
  });

  test('speak-mark events update metadata and clamped position state headless', async () => {
    await bind();
    controller.getPlaybackInfo.mockReturnValue({ position: 90, duration: 60, measuredFraction: 1 });
    controller.emitMark('Hello there, reader.', '0');
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.metadata).toBeTruthy();
    expect((fake.metadata as FakeMediaMetadata).artist).toContain('Alice');
    expect(fake.setPositionState).toHaveBeenCalledWith({
      duration: 60,
      position: 60, // clamped, never skipped
      playbackRate: 1,
    });
  });

  test('state changes surface playing/paused but not transit stopped', async () => {
    await bind();
    controller.emitState('paused');
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.playbackState).toBe('paused');
    controller.emitState('stopped'); // transit: paragraph advance
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.playbackState).toBe('paused'); // unchanged
    controller.emitState('playing');
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.playbackState).toBe('playing');
  });

  test('rebinding the same controller refreshes meta without duplicate listeners', async () => {
    await bind();
    await bridge.bind(controller as unknown as TTSController, meta({ bookKey: 'hash-abc-2' }));
    controller.emitMark('Once more.', '1');
    await new Promise((r) => setTimeout(r, 0));
    // One metadata update per mark, not two.
    expect(fake.setPositionState).toHaveBeenCalledTimes(1);
  });

  test('unbind clears handlers and stops reacting to controller events', async () => {
    await bind();
    bridge.unbind();
    expect(fake.handlers.size).toBe(0);
    fake.setPositionState.mockClear();
    controller.emitMark('After unbind.', '2');
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.setPositionState).not.toHaveBeenCalled();
    expect(bridge.isBound).toBe(false);
  });

  test('section label falls back to the last known value when the source dies', async () => {
    let label: string | undefined = 'Chapter 7';
    await bridge.bind(controller as unknown as TTSController, {
      ...meta({ metadataMode: 'chapter' as const }),
      getSectionLabel: () => label,
    });
    controller.emitMark('First.', '0');
    await new Promise((r) => setTimeout(r, 0));
    const first = fake.metadata as FakeMediaMetadata;
    label = undefined; // hook unmounted
    controller.emitMark('Second.', '1');
    await new Promise((r) => setTimeout(r, 0));
    // Metadata still reflects the last known chapter, no crash, no blanking.
    expect(first).toBeTruthy();
    expect(bridge.isBound).toBe(true);
  });

  test('library privacy masks metadata text without replacing the media artwork', async () => {
    useSettingsStore.setState({
      settings: {
        libraryPrivacyModeEnabled: true,
        privateBookTitleAliases: {
          'hash-abc': { title: 'Alice', alias: 'Book-123456' },
        },
      } as never,
    });
    await bridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader', bookHash: 'hash-abc', coverImageUrl: 'cover.png' }),
    );

    controller.emitMark('Sensitive sentence text.', '0');
    await new Promise((r) => setTimeout(r, 0));

    const metadata = fake.metadata as FakeMediaMetadata;
    expect(metadata.title).toBe('Book-123456');
    expect(metadata.artist).toBe('Book-123456');
    expect(metadata.album).toBe('Book-123456');
    expect(metadata.artwork?.[0]?.src).toBe('cover.png');
  });

  test('library privacy does not resend identical lock-screen metadata on every mark', async () => {
    useSettingsStore.setState({
      settings: {
        libraryPrivacyModeEnabled: true,
        privateBookTitleAliases: {
          'hash-abc': { title: 'Alice', alias: 'Book-123456' },
        },
      } as never,
    });
    await bridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader', bookHash: 'hash-abc', coverImageUrl: 'cover.png' }),
    );

    controller.emitMark('First sensitive sentence.', '0');
    await new Promise((r) => setTimeout(r, 0));
    controller.emitMark('Second sensitive sentence.', '1');
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.metadataSets).toHaveLength(1);
  });

  test('web media session reuses the same metadata object for text-only updates', async () => {
    await bridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader', coverImageUrl: 'cover.png' }),
    );

    controller.emitMark('First visible sentence.', '0');
    await new Promise((r) => setTimeout(r, 0));
    const firstMetadata = fake.metadata as FakeMediaMetadata;
    controller.emitMark('Second visible sentence.', '1');
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.metadataSets).toHaveLength(2);
    expect(fake.metadataSets[1]).toBe(firstMetadata);
    expect((fake.metadata as FakeMediaMetadata).title).toBe('Second visible sentence.');
    expect((fake.metadata as FakeMediaMetadata).artwork?.[0]?.src).toBe('cover.png');
  });

  test('tauri privacy metadata is sent once while the masked fields stay unchanged', async () => {
    useSettingsStore.setState({
      settings: {
        libraryPrivacyModeEnabled: true,
        privateBookTitleAliases: {
          'hash-abc': { title: 'Alice', alias: 'Book-123456' },
        },
      } as never,
    });
    const tauri = new TauriMediaSession();
    const updateMetadata = vi.spyOn(tauri, 'updateMetadata').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'updatePlaybackState').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setActive').mockResolvedValue(undefined);
    const tauriBridge = new TTSMediaBridge(() => tauri);
    await tauriBridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader', bookHash: 'hash-abc', coverImageUrl: 'cover.png' }),
    );

    controller.emitMark('First sensitive sentence.', '0');
    await new Promise((r) => setTimeout(r, 0));
    controller.emitMark('Second sensitive sentence.', '1');
    await new Promise((r) => setTimeout(r, 0));

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(updateMetadata).toHaveBeenLastCalledWith({
      title: 'Book-123456',
      artist: 'Book-123456',
      album: 'Book-123456',
      artwork: 'data:image/png;base64,x',
    });
  });

  test('tauri sentence metadata updates avoid resending artwork on text-only changes', async () => {
    const tauri = new TauriMediaSession();
    const updateMetadata = vi.spyOn(tauri, 'updateMetadata').mockResolvedValue(undefined);
    const updatePlaybackState = vi.spyOn(tauri, 'updatePlaybackState').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setActive').mockResolvedValue(undefined);
    const tauriBridge = new TTSMediaBridge(() => tauri);
    await tauriBridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader', coverImageUrl: 'cover.png' }),
    );
    updateMetadata.mockClear();
    updatePlaybackState.mockClear();

    controller.emitMark('First visible sentence.', '0');
    await new Promise((r) => setTimeout(r, 0));

    expect(updateMetadata).toHaveBeenCalledWith({
      title: 'First visible sentence.',
      artist: 'Alice',
      album: 'Carroll',
    });
    expect(updatePlaybackState).toHaveBeenCalledWith({
      playing: true,
      position: 12000,
      duration: 60000,
    });
  });

  test('tauri playback-state-only updates omit position so native keeps the scrubber stable', async () => {
    const tauri = new TauriMediaSession();
    const updatePlaybackState = vi.spyOn(tauri, 'updatePlaybackState').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'updateMetadata').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setActive').mockResolvedValue(undefined);
    const tauriBridge = new TTSMediaBridge(() => tauri);
    await tauriBridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader' }),
    );
    updatePlaybackState.mockClear();

    controller.emitState('paused');
    await new Promise((r) => setTimeout(r, 0));

    expect(updatePlaybackState).toHaveBeenCalledWith({ playing: false });
  });

  test('tauri privacy position updates keep playing during paragraph handoff', async () => {
    useSettingsStore.setState({
      settings: {
        libraryPrivacyModeEnabled: true,
        privateBookTitleAliases: {
          'hash-abc': { title: 'Alice', alias: 'Book-123456' },
        },
      } as never,
    });
    const tauri = new TauriMediaSession();
    const updatePlaybackState = vi.spyOn(tauri, 'updatePlaybackState').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'updateMetadata').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'setActive').mockResolvedValue(undefined);
    const tauriBridge = new TTSMediaBridge(() => tauri);
    await tauriBridge.bind(
      controller as unknown as TTSController,
      meta({ bookKey: 'hash-abc-reader', bookHash: 'hash-abc', coverImageUrl: 'cover.png' }),
    );
    updatePlaybackState.mockClear();

    controller.emitState('stopped');
    controller.emitMark('Next masked sentence.', '0');
    await new Promise((r) => setTimeout(r, 0));

    expect(updatePlaybackState).toHaveBeenLastCalledWith({
      playing: true,
      position: 12000,
      duration: 60000,
    });
  });
});
