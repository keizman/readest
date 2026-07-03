import { create } from 'zustand';

/**
 * The active/last TTS ("listen") session, kept in a module-level store so it
 * survives navigating between the reader and the library routes (the reader
 * owns the TTS controller and unmounts on navigation). The library shows a
 * "now playing" bar from this so the user can jump back and resume.
 */
export interface NowPlayingInfo {
  bookHash: string;
  bookId: string;
  title: string;
  author: string;
  coverImageUrl?: string | null;
  /** Overall reading position (0..1), matching BookProgress.fraction. */
  fraction: number;
  /** Live playback state; false once the reader route (and audio) tears down. */
  isPlaying: boolean;
}

interface NowPlayingState {
  nowPlaying: NowPlayingInfo | null;
  // Book id awaiting TTS auto-resume once its reader view is ready (set when the
  // library bar is tapped, consumed by the reader). Kept outside `nowPlaying` so
  // it never leaks into the bar's render.
  resumeRequestBookId: string | null;
  setNowPlaying: (info: NowPlayingInfo) => void;
  updateNowPlaying: (patch: Partial<NowPlayingInfo>) => void;
  clearNowPlaying: () => void;
  requestResume: (bookId: string) => void;
  consumeResume: (bookId: string) => boolean;
}

export const useNowPlayingStore = create<NowPlayingState>((set, get) => ({
  nowPlaying: null,
  resumeRequestBookId: null,
  setNowPlaying: (info) => set({ nowPlaying: info }),
  updateNowPlaying: (patch) =>
    set((state) => (state.nowPlaying ? { nowPlaying: { ...state.nowPlaying, ...patch } } : state)),
  clearNowPlaying: () => set({ nowPlaying: null }),
  requestResume: (bookId) => set({ resumeRequestBookId: bookId }),
  consumeResume: (bookId) => {
    if (get().resumeRequestBookId !== bookId) return false;
    set({ resumeRequestBookId: null });
    return true;
  },
}));
