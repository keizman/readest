import { create } from 'zustand';
import { SystemSettings } from '@/types/settings';
import { Book, BookConfig, BookNote } from '@/types/book';
import { EnvConfigType } from '@/services/environment';
import { BookDoc } from '@/libs/document';
import { useLibraryStore } from './libraryStore';

// Throttle library.json writes triggered by per-book saveConfig.
//
// Why: `saveConfig` ran two large fs.writeFile IPC calls *every* invocation —
// one for the per-book config.json and one for the WHOLE library.json (because
// saveLibraryBooks writes a backup + the file itself). For a user with N
// books in their shelf, that's `2 * JSON.stringify(N entries)` of work + 2
// Tauri IPC round-trips per save. With auto-save firing once per second of
// reading (useProgressAutoSave), Chrome DevTools' Bottom-Up profile shows
// `processIpcMessage` chewing ~25% of main-thread time during a reading
// session — directly responsible for the swipe jank the user is reporting
// (touchmove gets queued behind IPC processing).
//
// Progress durability (do not regress):
//   1. Per-book config.json is written *eagerly* on every saveConfig — this is
//      the source of truth if the app is killed mid-session.
//   2. library.json is throttled but force-flushed on book close, background,
//      and pagehide so shelf progress/MRU is not lost on normal exit.
//   3. In-memory shelf updates use patchBookFields (no refreshGroups) so a
//      300+ book library does not freeze TTS/reader every autosave.
//
// LIBRARY_SAVE_THROTTLE_MS=30s: long enough to collapse a swipe burst into a
// single IPC, short enough that a backgrounded app still gets a rollup soon.
// Force-flush happens via flushPendingLibrarySave() on unmount + hide.
const LIBRARY_SAVE_THROTTLE_MS = 30_000;
let librarySaveTimeoutId: ReturnType<typeof setTimeout> | null = null;
let librarySaveAppService: { saveLibraryBooks: (books: Book[]) => Promise<void> } | null = null;
/** True when in-memory library differs from last written library.json. */
let libraryDiskDirty = false;
/** Hashes that should be promoted to MRU front on the next library.json flush. */
const pendingPromoteHashes = new Set<string>();

const scheduleLibrarySave = (appService: {
  saveLibraryBooks: (books: Book[]) => Promise<void>;
}) => {
  librarySaveAppService = appService;
  libraryDiskDirty = true;
  if (librarySaveTimeoutId != null) return;
  librarySaveTimeoutId = setTimeout(() => {
    librarySaveTimeoutId = null;
    void flushPendingLibrarySave();
  }, LIBRARY_SAVE_THROTTLE_MS);
};

/**
 * Apply deferred MRU order and persist library.json if dirty.
 * Safe to call often; no-ops when nothing is pending.
 */
export const flushPendingLibrarySave = async () => {
  if (librarySaveTimeoutId != null) {
    clearTimeout(librarySaveTimeoutId);
    librarySaveTimeoutId = null;
  }

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
    console.warn('Throttled library save failed:', err);
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
    const updatedBook = patchBookFields(hash, {
      progress: config.progress,
      updatedAt: now,
      downloadedAt: original.downloadedAt || now,
    });
    if (!updatedBook) return;
    pendingPromoteHashes.add(hash);

    // Refresh updatedAt immutably via the store rather than mutating the
    // caller-provided object. This notifies Zustand subscribers and works
    // regardless of whether the caller passed the shared store config.
    get().setConfig(bookKey, { updatedAt: now });
    const configToSave = { ...config, updatedAt: now };
    // Per-book config: always write eagerly — small, and the durability
    // guarantee if the process is killed before library.json is flushed.
    await appService.saveBookConfig(updatedBook, configToSave, settings);
    // Library JSON: throttled; force-flushed on hide/close (see lifecycle hooks).
    scheduleLibrarySave(appService);
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
