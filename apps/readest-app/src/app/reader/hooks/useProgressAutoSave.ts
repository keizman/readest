import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore, flushPendingLibrarySave } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useSettingsStore } from '@/store/settingsStore';
import { debounce } from '@/utils/debounce';

const PROGRESS_AUTOSAVE_MAX_DEFER_MS = 5_000;

export const useProgressAutoSave = (bookKey: string) => {
  const { envConfig } = useEnv();
  const getConfig = useBookDataStore((s) => s.getConfig);
  const saveConfig = useBookDataStore((s) => s.saveConfig);
  // Reactive subscription so the effect below fires the debounced save
  // whenever this book's progress changes. Reads from readerProgressStore.
  const progress = useBookProgress(bookKey);

  // Tracks the location we last persisted (or, before the first save, the
  // location loaded from disk at book open). We skip saveConfig when the
  // in-memory location matches — saveConfig unconditionally bumps
  // config.updatedAt, and a bump on the initial relocate makes the local
  // record look newer than a fresher server-side push, so the next sync
  // overwrites the server's progress with the stale local one (issue #4222).
  const lastSavedLocationRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const lastForcedSaveAtRef = useRef(0);

  const persistBookConfig = useCallback(async () => {
    // Skip while previewing a deep-link target — the user's actual
    // last-read position should not be overwritten by a transient view.
    if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
    const config = getConfig(bookKey);
    if (!config) return;
    const currentLocation = config.location ?? null;
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastSavedLocationRef.current = currentLocation;
      return;
    }
    if (currentLocation === lastSavedLocationRef.current) return;
    const settings = useSettingsStore.getState().settings;
    await saveConfig(envConfig, bookKey, config, settings);
    lastSavedLocationRef.current = currentLocation;
  }, [bookKey, envConfig, getConfig, saveConfig]);

  const persistBookConfigRef = useRef(persistBookConfig);
  persistBookConfigRef.current = persistBookConfig;

  const saveBookConfig = useMemo(
    () =>
      debounce(() => {
        void persistBookConfigRef.current();
      }, 1000),
    [],
  );

  useEffect(() => {
    // Snapshot the loaded-from-disk location before any progress events fire,
    // so we don't treat the initial relocate as a user-driven change.
    if (!initializedRef.current) {
      const config = getConfig(bookKey);
      if (config) {
        initializedRef.current = true;
        lastSavedLocationRef.current = config.location ?? null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  useEffect(() => {
    saveBookConfig();
    if (progress?.location) {
      const now = Date.now();
      if (now - lastForcedSaveAtRef.current >= PROGRESS_AUTOSAVE_MAX_DEFER_MS) {
        lastForcedSaveAtRef.current = now;
        saveBookConfig.flush();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.location, bookKey]);

  // Durability: flush debounced progress + library.json rollup when the
  // reader unmounts, the app is backgrounded, or the page is closing.
  // Per-book config.json is already written eagerly inside saveConfig; this
  // forces the last debounced tick and promotes MRU order into library.json
  // so force-close does not lose "rough" progress beyond the debounce window.
  useEffect(() => {
    const flushAll = () => {
      saveBookConfig.flush();
      void flushPendingLibrarySave().catch(() => {
        // Best-effort — per-book config.json remains the crash recovery path.
      });
    };
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        flushAll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushAll);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushAll);
      flushAll();
    };
  }, [saveBookConfig]);
};
