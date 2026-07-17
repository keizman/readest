import { create } from 'zustand';
import { SystemSettings } from '@/types/settings';
import { Book, BookConfig, BookNote } from '@/types/book';
import { EnvConfigType } from '@/services/environment';
import { BookDoc } from '@/libs/document';
import { useLibraryStore } from './libraryStore';
import { getBookProgress } from './readerProgressStore';

// library.json is expensive for large shelves (read-merge-write of the whole
// index over Tauri IPC). Progress autosave used to schedule that write every
// ~30s, which showed up as a regular multi-second freeze while reading/TTS.
//
// Progress durability (do not regress):
//   1. Per-book config.json is written *eagerly* on every saveConfig — this is
//      the source of truth if the app is killed mid-session (rough progress
//      survives; at worst the last ~1–5s of debounce is missing).
//   2. library.json is ONLY written on lifecycle flush (book close, app
//      background, pagehide) — never on a mid-session timer.
//   3. In-memory shelf updates use patchBookFields (no refreshGroups).
//   4. MRU promote-to-front is deferred until that same lifecycle flush.
let librarySaveAppService: { saveLibraryBooks: (books: Book[]) => Promise<void> } | null = null;
/** True when in-memory library differs from last written library.json. */
let libraryDiskDirty = false;
/** Hashes that should be promoted to MRU front on the next library.json flush. */
const pendingPromoteHashes = new Set<string>();

/** Mark library.json dirty; do not write until flushPendingLibrarySave(). */
const markLibrarySavePending = (appService: {
  saveLibraryBooks: (books: Book[]) => Promise<void>;
}) => {
  librarySaveAppService = appService;
  libraryDiskDirty = true;
};

/**
 * Apply deferred MRU order and persist library.json if dirty.
 * Call on reader unmount / app background / pagehide — not on a timer.
 */
export const flushPendingLibrarySave = async () => {
  // Promote first so the written library.json matches "last read" order.
  if (pendingPromoteHashes.size > 0) {
    const { promoteBookToFront } = useLibraryStore.getState();
    for (const hash of pendingPromoteHashes) {
      promoteBookToFront(hash);
    }
    pendingPromoteHashes.clear();
    libraryDiskDirty = true;
  }

  if (!libraryDiskDirty || !librarySaveAppService) return;
  const svc = librarySaveAppService;
  const { library } = useLibraryStore.getState();
  libraryDiskDirty = false;
  try {
    await svc.saveLibraryBooks(library);
  } catch (err) {
    // Keep dirty so a later flush can retry; progress is still on disk in
    // each book's config.json from the eager saveBookConfig path.
    libraryDiskDirty = true;
    console.warn('Library rollup save failed:', err);
  }
};

/** Install once: flush library rollup when the app is backgrounded or closed. */
let lifecycleHooksInstalled = false;
export const ensureLibrarySaveLifecycleHooks = () => {
  if (lifecycleHooksInstalled || typeof window === 'undefined') return;
  lifecycleHooksInstalled = true;
  const flush = () => {
    void flushPendingLibrarySave();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
};

export interface BookData {
  /* Persistent data shared with different views of the same book */
  id: string;
  book: Book | null;
  file: File | null;
  config: BookConfig | null;
  bookDoc: BookDoc | null;
  isFixedLayout: boolean;
}

const isProgressTuple = (progress: BookConfig['progress']): progress is [number, number] => {
  return (
    Array.isArray(progress) &&
    progress.length === 2 &&
    Number.isFinite(progress[0]) &&
    Number.isFinite(progress[1]) &&
    progress[1] > 0
  );
};

const getLiveProgressConfigPatch = (
  bookKey: string,
): (Pick<BookConfig, 'location'> & Partial<Pick<BookConfig, 'progress'>>) | null => {
  const progress = getBookProgress(bookKey);
  if (!progress?.location) return null;
  if (progress.persistToConfig === false) return null;
  return {
    location: progress.location,
    ...(isProgressTuple(progress.progress) ? { progress: progress.progress } : {}),
  };
};

const getLiveReadingStatusPatch = (
  book: Book,
  progress: BookConfig['progress'],
  now: number,
): Partial<Book> => {
  if (!isProgressTuple(progress)) return {};

  let readingStatus = book.readingStatus;
  if (readingStatus === 'unread') {
    readingStatus = undefined;
  }
  if (Math.round((progress[0] / progress[1]) * 100) >= 100 && book.readingStatus !== 'finished') {
    readingStatus = 'finished';
  }
  if (readingStatus === book.readingStatus) return {};

  return {
    readingStatus,
    readingStatusUpdatedAt: now,
  };
};

interface BookDataState {
  booksData: { [id: string]: BookData };
  getConfig: (key: string | null) => BookConfig | null;
  setConfig: (key: string, partialConfig: Partial<BookConfig>) => void;
  saveConfig: (
    envConfig: EnvConfigType,
    bookKey: string,
    config: BookConfig,
    settings: SystemSettings,
  ) => Promise<void>;
  updateBooknotes: (key: string, booknotes: BookNote[]) => BookConfig | undefined;
  getBookData: (keyOrId: string) => BookData | null;
  clearBookData: (keyOrId: string) => void;
}

export const useBookDataStore = create<BookDataState>((set, get) => ({
  booksData: {},
  getBookData: (keyOrId: string) => {
    const id = keyOrId.split('-')[0]!;
    return get().booksData[id] || null;
  },
  clearBookData: (keyOrId: string) => {
    const id = keyOrId.split('-')[0]!;
    set((state) => {
      const newBooksData = { ...state.booksData };
      delete newBooksData[id];
      return {
        booksData: newBooksData,
      };
    });
  },
  getConfig: (key: string | null) => {
    if (!key) return null;
    const id = key.split('-')[0]!;
    return get().booksData[id]?.config || null;
  },
  setConfig: (key: string, partialConfig: Partial<BookConfig>) => {
    set((state: BookDataState) => {
      const id = key.split('-')[0]!;
      const config = state.booksData[id]?.config;
      if (!config) {
        console.warn('No config found for book', id);
        return state;
      }
      return {
        booksData: {
          ...state.booksData,
          [id]: {
            ...state.booksData[id]!,
            config: { ...config, ...partialConfig },
          },
        },
      };
    });
  },
  saveConfig: async (
    envConfig: EnvConfigType,
    bookKey: string,
    config: BookConfig,
    settings: SystemSettings,
  ) => {
    ensureLibrarySaveLifecycleHooks();
    const appService = await envConfig.getAppService();
    const { getBookByHash, patchBookFields } = useLibraryStore.getState();
    const hash = bookKey.split('-')[0]!;
    const original = getBookByHash(hash);
    if (!original) return;

    // Hot path: patch in place — no setLibrary, no refreshGroups (MD5 over N
    // books), no MRU reorder. Reorder is deferred to library.json flush so
    // continuous reading/TTS does not freeze on large shelves.
    const now = Date.now();
    const liveProgressPatch = getLiveProgressConfigPatch(bookKey);
    const configToSave = {
      ...config,
      ...(liveProgressPatch ?? {}),
      updatedAt: now,
    };
    const progressToPersist = configToSave.progress;
    const updatedBook = patchBookFields(hash, {
      progress: progressToPersist,
      updatedAt: now,
      downloadedAt: original.downloadedAt || now,
      ...(liveProgressPatch
        ? getLiveReadingStatusPatch(original, liveProgressPatch.progress, now)
        : {}),
    });
    if (!updatedBook) return;
    pendingPromoteHashes.add(hash);

    // Refresh updatedAt immutably via the store rather than mutating the
    // caller-provided object. This notifies Zustand subscribers and works
    // regardless of whether the caller passed the shared store config.
    get().setConfig(bookKey, {
      updatedAt: now,
      ...(liveProgressPatch ?? {}),
    });
    // Per-book config: always write eagerly — small, and the durability
    // guarantee if the process is killed before library.json is flushed.
    await appService.saveBookConfig(updatedBook, configToSave, settings);
    // library.json: mark dirty only — written on hide/close (no mid-read timer).
    markLibrarySavePending(appService);
  },
  updateBooknotes: (key: string, booknotes: BookNote[]) => {
    let updatedConfig: BookConfig | undefined;
    set((state) => {
      const id = key.split('-')[0]!;
      const book = state.booksData[id];
      if (!book) return state;
      const dedupedBooknotes = Array.from(
        new Map(booknotes.map((item) => [`${item.id}-${item.type}-${item.cfi}`, item])).values(),
      );
      updatedConfig = {
        ...book.config,
        updatedAt: Date.now(),
        booknotes: dedupedBooknotes,
      };
      return {
        booksData: {
          ...state.booksData,
          [id]: {
            ...book,
            config: {
              ...book.config,
              updatedAt: Date.now(),
              booknotes: dedupedBooknotes,
            },
          },
        },
      };
    });
    return updatedConfig;
  },
}));
