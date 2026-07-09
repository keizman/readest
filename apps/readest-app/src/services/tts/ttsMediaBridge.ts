// Session-scoped media-session ownership for TTS.
//
// The lock screen is the primary surface for background TTS: metadata,
// position state, and transport handlers must keep working after the reader
// (and its hooks) unmount. This bridge binds to a TTSController directly —
// its listeners ride controller events, not React lifecycles — and is the
// SOLE owner of media-session handlers from the moment a session starts.
//
// The silent keep-alive element lives here too: it unlocks WebAudio against
// the iOS mute switch, hosts navigator.mediaSession on platforms where a
// playing HTMLMediaElement is required (iOS lock screen, desktop Chromium
// media keys), and must survive hook unmount for a detached session.

import { buildTTSMediaMetadata } from '@/utils/ttsMetadata';
import { fetchImageAsBase64 } from '@/utils/image';
import { getMediaSession, TauriMediaSession } from '@/libs/mediaSession';
import { useSettingsStore } from '@/store/settingsStore';
import { getBookDisplayTitle, isBookMasked, isLibraryPrivacyModeEnabled } from '@/utils/privacy';
import { SILENCE_DATA } from './TTSData';
import type { TTSController } from './TTSController';
import type { TTSMark, TTSMediaMetadataMode } from './types';

export interface TTSMediaBridgeMeta {
  bookKey: string;
  bookHash?: string;
  title: string;
  author: string;
  coverImageUrl: string | null;
  metadataMode: TTSMediaMetadataMode;
  // Live section label while the reader is mounted; returns undefined when
  // the supplying hook is dead (headless) — the bridge then keeps the last
  // known label rather than freezing on a stale store read.
  getSectionLabel?: () => string | undefined;
}

// ---------------------------------------------------------------------------
// Keep-alive element (module-scoped: outlives hooks by design).

let unblockerAudio: HTMLAudioElement | null = null;

// This enables WebAudio to play even when the mute toggle switch is ON.
export const unblockAudio = (): void => {
  if (unblockerAudio) return;
  unblockerAudio = document.createElement('audio');
  unblockerAudio.setAttribute('x-webkit-airplay', 'deny');
  unblockerAudio.addEventListener('play', () => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
    }
  });
  unblockerAudio.preload = 'auto';
  unblockerAudio.loop = true;
  unblockerAudio.src = SILENCE_DATA;
  // jsdom's play() returns undefined; browsers return a promise that rejects
  // under autoplay policy outside a user gesture. The keep-alive is
  // best-effort: the production path calls this inside the tts-speak gesture
  // handler, and a rejection must not surface as an unhandled rejection.
  const playing = unblockerAudio.play() as Promise<void> | undefined;
  playing?.catch((err) => {
    console.warn('Keep-alive audio blocked:', err);
  });
};

export const releaseUnblockAudio = (): void => {
  if (!unblockerAudio) return;
  try {
    unblockerAudio.pause();
    unblockerAudio.currentTime = 0;
    unblockerAudio.removeAttribute('src');
    unblockerAudio.src = '';
    unblockerAudio.load();
    unblockerAudio = null;
    console.log('Unblock audio released');
  } catch (err) {
    console.warn('Error releasing unblock audio:', err);
  }
};

// ---------------------------------------------------------------------------

type BridgeMediaSession = TauriMediaSession | MediaSession;
type MediaMetadataText = Pick<MediaMetadataInit, 'title' | 'artist' | 'album'>;

export class TTSMediaBridge {
  #resolveMediaSession: () => BridgeMediaSession | null;
  #mediaSession: BridgeMediaSession | null = null;
  #controller: TTSController | null = null;
  #meta: TTSMediaBridgeMeta | null = null;
  #lastSectionLabel: string | undefined;
  #previousSectionLabel: string | undefined;
  #onSpeakMark: ((e: Event) => void) | null = null;
  #onStateChange: ((e: Event) => void) | null = null;
  #coverArtwork = '';
  #coverArtworkSrc = '';
  #lastMetadataSignature = '';
  #lastArtworkSrc = '';
  #webMetadata: MediaMetadata | null = null;
  #webArtworkSrc = '';
  #privacyActive = false;
  #mediaPlaybackPlaying = false;

  constructor(resolveMediaSession: () => BridgeMediaSession | null = getMediaSession) {
    this.#resolveMediaSession = resolveMediaSession;
  }

  get isBound(): boolean {
    return this.#controller !== null;
  }

  async bind(controller: TTSController, meta: TTSMediaBridgeMeta): Promise<void> {
    if (this.#controller === controller) {
      // Re-bind on adopt: refresh the meta (new bookKey / live label source)
      // without re-registering listeners or re-activating the session.
      this.#meta = meta;
      return;
    }
    this.unbind();
    this.#controller = controller;
    this.#meta = meta;
    this.#mediaPlaybackPlaying = controller.state === 'playing';
    this.#mediaSession = this.#resolveMediaSession();
    if (!this.#mediaSession) return;
    const privacyTitle = this.#getPrivacyTitle();
    this.#privacyActive = !!privacyTitle;

    if (this.#mediaSession instanceof TauriMediaSession) {
      const initialMetadata = {
        title: privacyTitle || meta.title,
        artist: privacyTitle || meta.author,
        album: privacyTitle || meta.title,
      };
      this.#rememberMetadata(initialMetadata, this.#getArtworkSrc());
      const artwork = await this.#resolveArtwork();
      await this.#mediaSession.setActive({ active: true });
      await this.#mediaSession.updateMetadata({
        ...initialMetadata,
        artwork,
      });
    }

    this.#registerActionHandlers();

    this.#onSpeakMark = (e: Event) => {
      const mark = (e as CustomEvent<TTSMark>).detail;
      void this.#updateMetadata(mark);
      void this.#updatePositionState();
    };
    this.#onStateChange = () => {
      void this.#updatePlaybackState();
    };
    controller.addEventListener('tts-speak-mark', this.#onSpeakMark);
    controller.addEventListener('tts-state-change', this.#onStateChange);
  }

  unbind(): void {
    if (this.#controller) {
      if (this.#onSpeakMark) {
        this.#controller.removeEventListener('tts-speak-mark', this.#onSpeakMark);
      }
      if (this.#onStateChange) {
        this.#controller.removeEventListener('tts-state-change', this.#onStateChange);
      }
    }
    const mediaSession = this.#mediaSession;
    if (mediaSession) {
      for (const action of [
        'play',
        'pause',
        'stop',
        'seekforward',
        'seekbackward',
        'nexttrack',
        'previoustrack',
        'seekto',
      ]) {
        try {
          mediaSession.setActionHandler(action as MediaSessionAction, null);
        } catch {
          // Unsupported actions on this engine.
        }
      }
      if (mediaSession instanceof TauriMediaSession) {
        void mediaSession.setActive({ active: false });
      }
    }
    this.#controller = null;
    this.#meta = null;
    this.#mediaSession = null;
    this.#onSpeakMark = null;
    this.#onStateChange = null;
    this.#lastSectionLabel = undefined;
    this.#previousSectionLabel = undefined;
    this.#coverArtwork = '';
    this.#coverArtworkSrc = '';
    this.#lastMetadataSignature = '';
    this.#lastArtworkSrc = '';
    this.#webMetadata = null;
    this.#webArtworkSrc = '';
    this.#privacyActive = false;
    this.#mediaPlaybackPlaying = false;
  }

  async refreshMetadata(): Promise<void> {
    await this.#updateMetadata(undefined);
  }

  #getPrivacyTitle(): string | null {
    const meta = this.#meta;
    if (!meta) return null;
    const settings = useSettingsStore.getState().settings;
    const bookHash = meta.bookHash ?? meta.bookKey.split('-')[0]!;
    if (isLibraryPrivacyModeEnabled(settings)) {
      return getBookDisplayTitle(settings, { hash: bookHash, title: meta.title });
    }
    return isBookMasked(settings, bookHash) ? meta.title : null;
  }

  #getArtworkSrc(): string {
    // Privacy (global library mode or a masked book) must not leak the real
    // cover to the lock screen either — titles are aliased, so the artwork
    // falls back to the generic app icon.
    if (this.#getPrivacyTitle()) return '/icon.png';
    return this.#meta?.coverImageUrl || '/icon.png';
  }

  #makeMetadataSignature(metadata: MediaMetadataText, artworkSrc: string): string {
    return `${metadata.title}\u0000${metadata.artist}\u0000${metadata.album}\u0000${artworkSrc}`;
  }

  #rememberMetadata(
    metadata: MediaMetadataText,
    artworkSrc: string,
  ): { unchanged: boolean; artworkChanged: boolean } {
    const signature = this.#makeMetadataSignature(metadata, artworkSrc);
    const unchanged = signature === this.#lastMetadataSignature;
    const artworkChanged = artworkSrc !== this.#lastArtworkSrc;
    if (!unchanged) {
      this.#lastMetadataSignature = signature;
      this.#lastArtworkSrc = artworkSrc;
    }
    return { unchanged, artworkChanged };
  }

  async #resolveArtwork(): Promise<string> {
    const source = this.#getArtworkSrc();
    // Cache per source: toggling privacy mid-session switches between the
    // real cover and the generic icon, and the stale bitmap must not win.
    if (this.#coverArtwork && this.#coverArtworkSrc === source) return this.#coverArtwork;
    let artwork = '';
    try {
      artwork = await fetchImageAsBase64(source);
    } catch {
      if (source !== '/icon.png') {
        try {
          artwork = await fetchImageAsBase64('/icon.png');
        } catch {
          artwork = '';
        }
      }
    }
    this.#coverArtwork = artwork;
    this.#coverArtworkSrc = source;
    return artwork;
  }

  #registerActionHandlers(): void {
    const mediaSession = this.#mediaSession;
    if (!mediaSession) return;
    const controller = () => this.#controller;

    const togglePlay = () => {
      const ctrl = controller();
      if (!ctrl) return;
      if (ctrl.state === 'playing') {
        void ctrl.pause();
      } else if (ctrl.state.includes('paused')) {
        void ctrl.start();
      }
    };
    mediaSession.setActionHandler('play', togglePlay);
    mediaSession.setActionHandler('pause', togglePlay);
    // 'stop' keeps its long-standing pause mapping; the hard stop lives in
    // the in-app surfaces (panel, now-playing bar).
    mediaSession.setActionHandler('stop', () => {
      const ctrl = controller();
      if (ctrl?.state === 'playing') void ctrl.pause();
    });
    mediaSession.setActionHandler('seekforward', () => void controller()?.forward(true));
    mediaSession.setActionHandler('seekbackward', () => void controller()?.backward(true));
    mediaSession.setActionHandler('nexttrack', () => void controller()?.forward());
    mediaSession.setActionHandler('previoustrack', () => void controller()?.backward());
    if (mediaSession instanceof TauriMediaSession) {
      mediaSession.setActionHandler('seekto', ((positionMs: number) => {
        void controller()?.seekToTime(positionMs / 1000);
      }) as (position: number) => void);
    } else {
      try {
        mediaSession.setActionHandler('seekto', (details: MediaSessionActionDetails) => {
          if (typeof details.seekTime === 'number') {
            void controller()?.seekToTime(details.seekTime);
          }
        });
      } catch {
        // 'seekto' unsupported on this engine.
      }
    }
  }

  async #updateMetadata(mark: TTSMark | undefined): Promise<void> {
    const mediaSession = this.#mediaSession;
    const meta = this.#meta;
    if (!mediaSession || !meta) return;
    const liveLabel = meta.getSectionLabel?.();
    if (liveLabel) this.#lastSectionLabel = liveLabel;
    const privacyTitle = this.#getPrivacyTitle();
    const privacyChanged = this.#privacyActive !== !!privacyTitle;
    this.#privacyActive = !!privacyTitle;

    const metadata = buildTTSMediaMetadata({
      markText: mark?.text || '',
      markName: mark?.name || '',
      sectionLabel: this.#lastSectionLabel || '',
      title: meta.title,
      author: meta.author,
      ttsMediaMetadata: meta.metadataMode,
      previousSectionLabel: this.#previousSectionLabel,
      privacyTitle,
    });
    if (meta.metadataMode === 'chapter') {
      this.#previousSectionLabel = this.#lastSectionLabel;
    }
    if (!metadata.shouldUpdate) return;
    const artworkSrc = this.#getArtworkSrc();
    const { unchanged, artworkChanged } = this.#rememberMetadata(metadata, artworkSrc);
    if (unchanged) return;

    if (mediaSession instanceof TauriMediaSession) {
      const shouldSendArtwork = artworkChanged || privacyChanged;
      const payload = {
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
      } as const;
      await mediaSession.updateMetadata(
        shouldSendArtwork ? { ...payload, artwork: await this.#resolveArtwork() } : payload,
      );
    } else {
      if (!this.#webMetadata || this.#webArtworkSrc !== artworkSrc) {
        this.#webMetadata = new MediaMetadata({
          title: metadata.title,
          artist: metadata.artist,
          album: metadata.album,
          artwork: [
            {
              src: artworkSrc,
              sizes: '512x512',
              type: 'image/png',
            },
          ],
        });
        this.#webArtworkSrc = artworkSrc;
      } else {
        this.#webMetadata.title = metadata.title;
        this.#webMetadata.artist = metadata.artist;
        this.#webMetadata.album = metadata.album;
      }
      mediaSession.metadata = this.#webMetadata;
    }
  }

  // Clamped, never skipped: skipping when the position overshoots an
  // estimated duration would freeze the lock-screen scrubber.
  #getMediaPlaybackPlaying(ctrl: TTSController): boolean {
    if (ctrl.state === 'playing') {
      this.#mediaPlaybackPlaying = true;
      return true;
    }
    if (ctrl.state === 'stopped' && !ctrl.terminated) {
      // Paragraph/chapter handoff briefly reports stopped while the next
      // utterance is queued. Keep the OS media session in the previous playing
      // state so Android does not emit a pause/play pulse between sentences.
      return this.#mediaPlaybackPlaying;
    }
    if (ctrl.state.includes('paused') || ctrl.terminated || ctrl.state === 'stopped') {
      this.#mediaPlaybackPlaying = false;
    }
    return this.#mediaPlaybackPlaying;
  }

  async #updatePositionState(): Promise<void> {
    const mediaSession = this.#mediaSession;
    const ctrl = this.#controller;
    if (!mediaSession || !ctrl) return;
    await ctrl.ensureTimeline();
    const info = ctrl.getPlaybackInfo();
    if (!info || !Number.isFinite(info.duration) || info.duration <= 0) return;
    const position = Math.min(Math.max(info.position, 0), info.duration);
    if (mediaSession instanceof TauriMediaSession) {
      await mediaSession.updatePlaybackState({
        playing: this.#getMediaPlaybackPlaying(ctrl),
        position: Math.round(position * 1000),
        duration: Math.round(info.duration * 1000),
      });
    } else if ('setPositionState' in mediaSession) {
      try {
        mediaSession.setPositionState({ duration: info.duration, position, playbackRate: 1 });
      } catch {
        // Transiently inconsistent states reject on some engines; the next
        // mark updates again.
      }
    }
  }

  async #updatePlaybackState(): Promise<void> {
    const mediaSession = this.#mediaSession;
    const ctrl = this.#controller;
    if (!mediaSession || !ctrl) return;
    // Transit 'stopped' flickers on every paragraph advance; only surface
    // playing/paused flips to the OS.
    if (ctrl.state === 'stopped' && !ctrl.terminated) return;
    const playing = this.#getMediaPlaybackPlaying(ctrl);
    if (mediaSession instanceof TauriMediaSession) {
      await mediaSession.updatePlaybackState({ playing });
    } else {
      mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }
}

export const ttsMediaBridge = new TTSMediaBridge();
