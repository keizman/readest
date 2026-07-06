import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Dependency mocks (must be set up before importing the hook) ---

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    appService: { isIOSApp: false, isMobile: false },
    envConfig: {},
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false }),
}));

const mockView = {
  book: { primaryLanguage: 'en', sections: [{ id: 0 }] },
  renderer: {
    getContents: () => [{ index: 0, doc: document as unknown as Document }],
    scrollToAnchor: vi.fn(),
    primaryIndex: 0,
    scrolled: false,
    nextSection: vi.fn(),
    start: 0,
    end: 0,
    sideProp: 'height',
    goTo: vi.fn(),
  },
  resolveCFI: vi.fn().mockReturnValue({ index: 0, anchor: () => new Range() }),
  getCFI: vi.fn().mockReturnValue('cfi'),
  getCFIProgress: vi.fn().mockResolvedValue({ fraction: 0.6 }),
  deselect: vi.fn(),
  resolveNavigation: vi.fn(),
  goTo: vi.fn(),
  history: { back: vi.fn(), forward: vi.fn() },
  tts: {
    from: vi.fn().mockReturnValue('<speak>hello</speak>'),
    start: vi.fn().mockReturnValue('<speak>hello</speak>'),
    getLastRange: vi.fn().mockReturnValue(null),
    highlight: vi.fn(),
  },
};

let mockProgress = {
  location: { start: { cfi: '' }, end: { cfi: '' } },
  index: 0,
  range: null,
  sectionLabel: '',
};

const mockViewSettings = {
  ttsLocation: null as string | null,
  ttsRate: 1,
  ttsHighlightOptions: { style: 'highlight', color: '#ffff00' },
  isEink: false,
  showTTSBar: false,
  ttsMediaMetadata: 'sentence',
  translationEnabled: false,
  ttsReadAloudText: 'source',
};

const mockBookData = {
  isFixedLayout: false,
  book: { hash: 'book-1', primaryLanguage: 'en', title: 'T', author: 'A', coverImageUrl: '' },
};

vi.mock('@/store/readerStore', () => {
  const store = {
    hoveredBookKey: null,
    getView: () => mockView,
    getProgress: () => mockProgress,
    getViewSettings: () => mockViewSettings,
    setViewSettings: vi.fn(),
    setTTSEnabled: vi.fn(),
  };
  // Production code uses per-field selectors; mock must apply them.
  const useReaderStore = <R,>(selector?: (s: typeof store) => R) =>
    selector ? selector(store) : store;
  useReaderStore.getState = () => store;
  return { useReaderStore };
});

vi.mock('@/store/bookDataStore', () => {
  const state = { getBookData: () => mockBookData };
  return {
    useBookDataStore: <R,>(selector?: (s: typeof state) => R) =>
      selector ? selector(state) : state,
  };
});

// useTTSControl now reads progress reactively from readerProgressStore.
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => mockProgress,
  getBookProgress: () => mockProgress,
}));

vi.mock('@/store/proofreadStore', () => ({
  useProofreadStore: () => ({
    getMergedRules: () => [],
  }),
}));

vi.mock('@/services/transformers/proofread', () => ({
  proofreadTransformer: {
    transform: vi.fn(async (ctx: { content: string }) => ctx.content),
  },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

// Track TTSController instantiations — this is the assertion target.
const ttsControllerInstances: unknown[] = [];
// Gate init() calls so that handleTTSSpeak stays suspended inside an `await`.
// This is the exact point where a second concurrent invocation would otherwise
// race ahead and construct a second TTSController. The test releases all
// pending resolvers once both dispatches have had a chance to interleave.
const pendingInitResolvers: Array<() => void> = [];

vi.mock('@/services/tts', () => ({
  TTSController: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      init: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            pendingInitResolvers.push(() => resolve());
          }),
      ),
      initViewTTS: vi.fn().mockResolvedValue(undefined),
      updateHighlightOptions: vi.fn(),
      setHighlightGranularity: vi.fn(),
      setLang: vi.fn(),
      setRate: vi.fn(),
      setVoice: vi.fn(),
      setTargetLang: vi.fn(),
      speak: vi.fn(),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forward: vi.fn().mockResolvedValue(undefined),
      backward: vi.fn().mockResolvedValue(undefined),
      getVoices: vi.fn().mockResolvedValue([]),
      getVoiceId: vi.fn().mockReturnValue(''),
      getCurrentHighlightCfi: vi.fn().mockReturnValue(null),
      reapplyCurrentHighlight: vi.fn(),
      redispatchPosition: vi.fn(),
      view: mockView,
      state: 'idle',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    ttsControllerInstances.push(this);
  }),
}));

vi.mock('@/libs/mediaSession', () => ({
  TauriMediaSession: class {},
}));

vi.mock('@/utils/ssml', () => ({
  genSSMLRaw: vi.fn((s: string) => `<speak>${s}</speak>`),
  parseSSMLLang: vi.fn(() => 'en'),
}));

vi.mock('@/utils/throttle', () => ({
  throttle: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock('@/utils/cfi', () => ({
  isCfiInLocation: () => false,
}));

vi.mock('@/utils/misc', () => ({
  getLocale: () => 'en',
  stubTranslation: (key: string) => key,
}));

vi.mock('@/utils/ttsMetadata', () => ({
  buildTTSMediaMetadata: () => ({
    shouldUpdate: false,
    title: '',
    artist: '',
    album: '',
  }),
}));

vi.mock('@/utils/bridge', () => ({
  invokeUseBackgroundAudio: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/ttsTime', () => ({
  estimateTTSTime: () => ({
    chapterRemainingSec: 0,
    bookRemainingSec: 0,
    finishAtTimestamp: 0,
  }),
}));

const { mockDeinitMediaSession } = vi.hoisted(() => ({
  mockDeinitMediaSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/app/reader/hooks/useTTSMediaSession', () => ({
  useTTSMediaSession: () => ({
    mediaSessionRef: { current: null },
    unblockAudio: vi.fn(),
    releaseUnblockAudio: vi.fn(),
    initMediaSession: vi.fn().mockResolvedValue(undefined),
    deinitMediaSession: mockDeinitMediaSession,
  }),
}));

// Imports must come AFTER vi.mock calls so they pick up the mocked modules.
import { stopDetachedTTS, useTTSControl } from '@/app/reader/hooks/useTTSControl';
import { eventDispatcher } from '@/utils/event';
import { useReaderStore } from '@/store/readerStore';
import { useNowPlayingStore } from '@/store/nowPlayingStore';

const getSetTTSEnabledMock = () =>
  (
    useReaderStore as unknown as {
      getState: () => { setTTSEnabled: ReturnType<typeof vi.fn> };
    }
  ).getState().setTTSEnabled;

const Harness = () => {
  useTTSControl({ bookKey: 'book-1' });
  return null;
};

describe('useTTSControl concurrent tts-speak events', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('creates only one TTSController when two tts-speak events fire back-to-back', async () => {
    render(<Harness />);

    await act(async () => {
      // Kick off both dispatches without awaiting — this models rapid clicks
      // where the second click arrives while the first is still inside its
      // initial awaits (initMediaSession / backgroundAudio / init()).
      const p1 = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      const p2 = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });

      // Let both invocations drain microtasks and reach their gated await.
      // Without the single-flight guard in handleTTSSpeak, both invocations
      // would construct a TTSController here and both would be queued in
      // pendingInitResolvers.
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // The assertion that matters: exactly one controller was constructed.
      expect(ttsControllerInstances.length).toBe(1);

      // Release any pending init() promises so the dispatch chain can unwind
      // cleanly (otherwise the act() would never settle).
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await Promise.all([p1, p2]);
    });
  });
});

describe('useTTSControl tts-sync-request (mode-entry replay)', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  const startSession = async () => {
    render(<Harness />);
    await act(async () => {
      const p = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await p;
    });
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    return ttsControllerInstances[0] as { redispatchPosition: ReturnType<typeof vi.fn> };
  };

  it('replays the current position then the playback state when a session exists', async () => {
    const controller = await startSession();
    const order: string[] = [];
    controller.redispatchPosition.mockImplementation(() => order.push('position'));
    const stateListener = (e: Event) => {
      order.push(`state:${(e as CustomEvent).detail.state}`);
    };
    eventDispatcher.on('tts-playback-state', stateListener);

    await act(async () => {
      await eventDispatcher.dispatch('tts-sync-request', { bookKey: 'book-1' });
    });

    eventDispatcher.off('tts-playback-state', stateListener);
    // Position-before-state is required so RSVP's 'paused' handler (which drops
    // following) can't discard the replayed position.
    expect(order).toEqual(['position', 'state:playing']);
  });

  it('ignores a sync request for a different book', async () => {
    const controller = await startSession();
    controller.redispatchPosition.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('tts-sync-request', { bookKey: 'other-book' });
    });

    expect(controller.redispatchPosition).not.toHaveBeenCalled();
  });

  it('is a no-op once the session has stopped', async () => {
    const controller = await startSession();
    await act(async () => {
      await eventDispatcher.dispatch('tts-stop', { bookKey: 'book-1' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    controller.redispatchPosition.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('tts-sync-request', { bookKey: 'book-1' });
    });

    expect(controller.redispatchPosition).not.toHaveBeenCalled();
  });
});

describe('useTTSControl rate changes', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('updates the rate without stopping and restarting active playback', async () => {
    render(<Harness />);
    await act(async () => {
      const pending = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await pending;
    });

    const controller = ttsControllerInstances[0] as {
      state: string;
      setRate: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    };
    controller.state = 'playing';
    controller.setRate.mockClear();
    controller.start.mockClear();
    controller.stop.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('tts-set-rate', { bookKey: 'book-1', rate: 3.25 });
    });

    expect(controller.setRate).toHaveBeenCalledWith(3.25);
    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });
});

describe('useTTSControl handleStop resilience (#4676)', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    mockDeinitMediaSession.mockReset();
    mockDeinitMediaSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  const startSession = async () => {
    render(<Harness />);
    await act(async () => {
      const p = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await p;
    });
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    return ttsControllerInstances[0] as { shutdown: ReturnType<typeof vi.fn> };
  };

  it('disables TTS even when controller.shutdown rejects', async () => {
    // Regression: a native teardown that throws (observed with iOS system TTS)
    // must not skip the state resets that turn the TTS icon off.
    const controller = await startSession();
    const setTTSEnabled = getSetTTSEnabledMock();
    setTTSEnabled.mockClear();
    controller.shutdown.mockRejectedValueOnce(new Error('native teardown failed'));

    await act(async () => {
      await eventDispatcher.dispatch('tts-stop', { bookKey: 'book-1' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(setTTSEnabled).toHaveBeenCalledWith('book-1', false);
  });

  it('disables TTS even when controller.shutdown never resolves', async () => {
    // The state resets must run before (not after) the teardown await, so a
    // hung native teardown can never leave the TTS icon stuck on.
    const controller = await startSession();
    const setTTSEnabled = getSetTTSEnabledMock();
    setTTSEnabled.mockClear();
    controller.shutdown.mockReturnValueOnce(new Promise<void>(() => {}));

    await act(async () => {
      // Do not await the dispatch: handleStop intentionally never settles here.
      eventDispatcher.dispatch('tts-stop', { bookKey: 'book-1' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(setTTSEnabled).toHaveBeenCalledWith('book-1', false);
  });

  it('tears down the media session even when controller.shutdown never resolves', async () => {
    // Regression for the lock-screen Now Playing lingering with iOS system TTS:
    // the media-session teardown must not be gated behind the controller's own
    // shutdown, which can stall.
    const controller = await startSession();
    mockDeinitMediaSession.mockClear();
    controller.shutdown.mockReturnValueOnce(new Promise<void>(() => {}));

    await act(async () => {
      eventDispatcher.dispatch('tts-stop', { bookKey: 'book-1' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(mockDeinitMediaSession).toHaveBeenCalled();
  });
});

describe('useTTSControl handleHighlightMark cross-section navigation', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    mockView.renderer.scrollToAnchor.mockClear();
    mockView.renderer.goTo.mockClear();
    mockView.goTo.mockClear();
    mockView.resolveCFI.mockReset();
    mockViewSettings.ttsLocation = null;
    mockProgress = {
      location: { start: { cfi: '' }, end: { cfi: '' } },
      index: 0,
      range: null,
      sectionLabel: '',
    };
  });

  afterEach(() => {
    cleanup();
  });

  const setupAndCaptureHighlightHandler = async () => {
    const rendered = render(<Harness />);

    await act(async () => {
      const p = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await p;
    });

    // Let the listener-registration useEffect run.
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    const controller = ttsControllerInstances[0] as {
      addEventListener: { mock: { calls: [string, (e: Event) => void][] } };
    };
    const calls = controller.addEventListener.mock.calls;
    const entry = calls.find(([name]) => name === 'tts-highlight-mark');
    if (!entry) throw new Error('tts-highlight-mark listener was not registered');
    return { handler: entry[1], rerender: rendered.rerender };
  };

  it('navigates to the cfi via view.goTo when TTS crosses into a new section', async () => {
    const { handler } = await setupAndCaptureHighlightHandler();

    // primaryIndex is 0 (current view section). Make the TTS cfi resolve to section 1.
    mockView.resolveCFI.mockReturnValue({ index: 1, anchor: () => new Range() });

    await act(async () => {
      handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'epubcfi(/6/8!/4/2)' } }));
    });

    expect(mockView.goTo).toHaveBeenCalledWith('epubcfi(/6/8!/4/2)');
    expect(mockView.renderer.scrollToAnchor).not.toHaveBeenCalled();
  });

  it('keeps in-section behaviour: scrolls via renderer without navigating', async () => {
    const { handler } = await setupAndCaptureHighlightHandler();

    mockView.resolveCFI.mockReturnValue({ index: 0, anchor: () => new Range() });

    await act(async () => {
      handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'epubcfi(/6/4!/4/2)' } }));
    });

    expect(mockView.renderer.scrollToAnchor).toHaveBeenCalledTimes(1);
    expect(mockView.goTo).not.toHaveBeenCalled();
  });

  it('keeps the manually selected chapter when the user has stopped following TTS', async () => {
    const { handler, rerender } = await setupAndCaptureHighlightHandler();

    // First establish a TTS location in the visible section. The next progress
    // render represents the user moving elsewhere, so the hook exposes the
    // back-to-TTS action and disables automatic following.
    mockView.resolveCFI.mockReturnValue({ index: 0, anchor: () => new Range() });
    await act(async () => {
      handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'tts-old' } }));
      mockProgress = {
        ...mockProgress,
        location: { start: { cfi: 'manual-chapter' }, end: { cfi: 'manual-chapter-end' } },
      };
      rerender(<Harness />);
      await Promise.resolve();
    });

    mockView.goTo.mockClear();
    mockView.resolveCFI.mockReturnValue({ index: 1, anchor: () => new Range() });
    await act(async () => {
      handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'tts-next-chapter' } }));
    });

    expect(mockView.goTo).not.toHaveBeenCalled();
  });
});

describe('useTTSControl detached bookshelf progress', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    mockView.getCFIProgress.mockClear();
    mockViewSettings.ttsLocation = null;
    useNowPlayingStore.setState({ nowPlaying: null, resumeRequestBookId: null });
  });

  afterEach(() => {
    stopDetachedTTS();
    cleanup();
  });

  it('keeps the bookshelf progress in sync while TTS plays after reader unmount', async () => {
    const rendered = render(<Harness />);
    await act(async () => {
      const pending = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await pending;
    });

    rendered.unmount();
    const controller = ttsControllerInstances[0] as {
      addEventListener: { mock: { calls: [string, (event: Event) => void][] } };
    };
    const detachedHandler = controller.addEventListener.mock.calls
      .filter(([name]) => name === 'tts-highlight-mark')
      .at(-1)?.[1];
    if (!detachedHandler) throw new Error('detached progress listener was not registered');

    await act(async () => {
      detachedHandler(
        new CustomEvent('tts-highlight-mark', { detail: { cfi: 'epubcfi(/6/8!/4/2)' } }),
      );
      await vi.waitFor(() => expect(mockView.getCFIProgress).toHaveBeenCalledOnce());
    });

    expect(useNowPlayingStore.getState().nowPlaying?.fraction).toBe(0.6);
  });
});
