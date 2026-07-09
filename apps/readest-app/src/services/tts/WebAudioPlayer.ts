// Gapless chunk scheduler on a persistent Web Audio context.
//
// Sentence buffers are scheduled back-to-back into an always-running
// AudioContext so the OS-level output stream never stops between sentences or
// paragraphs — per-sentence track restarts are what let Bluetooth fade-in /
// noise gates swallow the first word (#3851) and what put audible gaps
// between sentences (#2033). Chunk transitions ride source onended callbacks
// (background-safe when rAF and timers are throttled with the screen off);
// word-highlight polling is the only rAF consumer, and it lives in the client.
//
// The real AudioContext is a MODULE-LEVEL SINGLETON shared by all player
// instances and never closed: a fresh TTSController (and thus client+player)
// is constructed per tts-speak, and WebKit caps live AudioContexts (~4 on
// iOS) — per-player contexts would leak until every new one is born suspended
// and TTS goes silent. Sessions are isolated purely by generation tokens.
//
// This module speaks to the context through structural interfaces so jsdom
// tests can drive a fake clock.

export interface TTSAudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
  copyToChannel(source: Float32Array, channel: number): void;
}

export interface TTSAudioBufferSourceNode {
  buffer: TTSAudioBuffer | null;
  onended: (() => void) | null;
  readonly playbackRate: { value: number };
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface TTSAudioContext {
  readonly currentTime: number;
  readonly state: string; // 'running' | 'suspended' | 'interrupted' | 'closed'
  readonly destination: unknown;
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  createBufferSource(): TTSAudioBufferSourceNode;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): TTSAudioBuffer;
  decodeAudioData(data: ArrayBuffer): Promise<TTSAudioBuffer>;
}

export interface ChunkTiming {
  // Leading trim in original (rate-1.0) media time; word boundaries live there.
  trimStartSec: number;
  // originalTrimmedDuration / outputDuration (≈ playback rate).
  mediaScale: number;
  // Silence scheduled after this chunk; the caller rate-scales it.
  gapSec: number;
  // Extra speed applied via Web Audio source.playbackRate (default 1.0).
  // Used when the TTS engine's max rate < the desired user rate.
  playbackRate?: number;
}

export type WebAudioPlayerEvent =
  | { type: 'chunk-start'; chunkIndex: number }
  | { type: 'session-end' }
  | { type: 'context-error'; message: string }
  | { type: 'audio-interrupted' };

interface ScheduledChunk {
  index: number;
  source: TTSAudioBufferSourceNode;
  startTime: number;
  duration: number;
  timing: ChunkTiming;
  ended: boolean;
}

interface PlayerSession {
  generation: number;
  onEvent: (event: WebAudioPlayerEvent) => void;
  chunks: ScheduledChunk[];
  nextStartTime: number;
  ended: boolean;
  endedEmitted: boolean;
  waiters: Array<(ready: boolean) => void>;
  earlyEndTimer: ReturnType<typeof setTimeout> | null;
}

// Small offset so start() never lands in the past between the read of
// currentTime and the schedule call.
const SCHEDULE_SAFETY_SEC = 0.03;
// Announce 'session-end' this far before the final chunk's scheduled end on
// the audio clock, instead of waiting for its onended callback. The paragraph
// handoff (session-end → controller.forward → preprocess → cache lookup →
// decode → reschedule) is a serial JS pipeline that used to run only AFTER
// the audio had already gone silent — that latency was the audible gap
// between paragraphs. Emitting early lets the next paragraph prepare while
// the tail is still playing; startSession()'s natural-end handoff (see
// finishSessionForHandoff) then schedules the next chunk at exactly the old
// session's end time, so an early announcement can never truncate or overlap
// the tail. The onended path stays as the backstop when timers are throttled
// (backgrounded page) or the context is suspended.
const SESSION_END_EARLY_LEAD_SEC = 0.3;
// Keep enough decoded chunks scheduled that delayed main-thread `onended`
// delivery cannot drain the audio timeline. The page-hidden budget is deeper
// because Android/WebKit may throttle JS callbacks aggressively after lock.
const MAX_PENDING_VISIBLE = 16;
const MAX_PENDING_HIDDEN = 40;
// Bounds decoded PCM at slow rates (0.2x stretches a 30s sentence to 150s).
const MAX_AHEAD_SEC = 120;
// While hidden, a much deeper scheduled-ahead window is worth the extra
// decoded-PCM memory (small mono MP3-derived buffers): this is the ceiling
// that was actually capping background resilience. Even with the fetch
// pipeline queued far ahead (EdgeTTSClient's PIPELINE_LOOKAHEAD_HIDDEN), the
// player refused to schedule more than MAX_AHEAD_SEC past the audio clock —
// so once backgrounded (main-thread CPU/network throttling can slow fetch +
// decode well beyond real time), the actual insurance buffer was still only
// the visible cap and a slow batch could still starve the timeline. Hidden
// sessions let already-prepared audio queue up several minutes deep instead.
const MAX_AHEAD_SEC_HIDDEN = 300;

// REVERTED (see #tts-android-eager-lookahead-regression): making Android
// treat itself as permanently background-at-risk — i.e. always requesting
// the *_HIDDEN budgets and EdgeTTSClient's PIPELINE_LOOKAHEAD_HIDDEN even
// while visible — caused sustained over-fetching against the self-hosted
// Edge TTS relay (continuously trying to keep up to 300s/40 chunks warm
// instead of settling once the visible-tier buffer filled) and broke TTS
// entirely in the field ("Edge TTS WebSocket timed out" on every batch,
// including the very first preload). The *_HIDDEN budgets stay reactive
// (`document.visibilityState === 'hidden'` only); do not resurrect the
// always-on variant without first confirming the self-hosted relay can
// absorb sustained max-depth prefetch, not just brief bursts.

let sharedContext: TTSAudioContext | null = null;

const getSharedContext = (): TTSAudioContext => {
  if (!sharedContext) {
    sharedContext = new AudioContext() as unknown as TTSAudioContext;
  }
  return sharedContext;
};

// Warm up (create + resume) the shared context. Call this synchronously in a
// user-gesture handler: speak() itself runs after network awaits, outside
// WebKit's gesture window, where resume() can be rejected by autoplay policy.
export const ensureSharedAudioContext = async (): Promise<void> => {
  if (typeof AudioContext === 'undefined') return;
  try {
    const ctx = getSharedContext();
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
  } catch (err) {
    console.warn('[TTS] audio context warmup failed', err);
  }
};

export class WebAudioPlayer {
  #createContext: () => TTSAudioContext;
  #usesSharedContext: boolean;
  #ctx: TTSAudioContext | null = null;
  #generation = 0;
  #session: PlayerSession | null = null;
  // Audio-clock end time of the last naturally-finished session's tail; the
  // next session starts there instead of "now" so paragraph handoffs are
  // gapless. Always consumed (and reset) by startSession; a stale value is
  // harmless because scheduleChunk clamps to the current time anyway.
  #handoffNextStartTime = 0;
  #userPaused = false;
  #knownOutputDeviceIds: string[] = [];
  #deviceChangeHandler: (() => void) | null = null;

  constructor(createContext?: () => TTSAudioContext) {
    this.#createContext = createContext ?? getSharedContext;
    this.#usesSharedContext = !createContext;
  }

  async ensureContext(): Promise<TTSAudioContext> {
    if (!this.#ctx) {
      this.#ctx = this.#createContext();
      this.#ctx.onstatechange = () => this.#handleStateChange();
    }
    if (this.#ctx.state !== 'running' && !this.#userPaused) {
      await this.#ctx.resume();
    }
    return this.#ctx;
  }

  async decode(data: ArrayBuffer): Promise<TTSAudioBuffer> {
    const ctx = await this.ensureContext();
    return ctx.decodeAudioData(data);
  }

  async createMonoBuffer(samples: Float32Array, sampleRate: number): Promise<TTSAudioBuffer> {
    const ctx = await this.ensureContext();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  startSession(onEvent: (event: WebAudioPlayerEvent) => void): number {
    // A naturally-finished predecessor hands its timeline over instead of
    // being aborted: its scheduled tail keeps playing and the new session's
    // first chunk is scheduled at exactly its end time — the gapless
    // paragraph handoff. (The generator's cleanup usually performs the
    // handoff before this runs, leaving no session but a stored handoff
    // time — that time must survive, so only a live session gets aborted.)
    if (this.#session && !this.finishSessionForHandoff()) {
      this.abortSession();
    }
    const generation = ++this.#generation;
    this.#session = {
      generation,
      onEvent,
      chunks: [],
      nextStartTime: this.#handoffNextStartTime,
      ended: false,
      endedEmitted: false,
      waiters: [],
      earlyEndTimer: null,
    };
    this.#handoffNextStartTime = 0;
    this.#registerDeviceChangeListener();
    console.log(`[TTS] session ${generation} start`);
    return generation;
  }

  scheduleChunk(generation: number, buffer: TTSAudioBuffer, timing: ChunkTiming): void {
    const session = this.#session;
    const ctx = this.#ctx;
    if (!session || session.generation !== generation || !ctx) return;
    const plannedStart = session.nextStartTime;
    const start = Math.max(plannedStart, ctx.currentTime + SCHEDULE_SAFETY_SEC);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const playbackRate = timing.playbackRate ?? 1.0;
    source.playbackRate.value = playbackRate;
    source.connect(ctx.destination);
    const effectiveDuration = buffer.duration / playbackRate;
    const chunk: ScheduledChunk = {
      index: session.chunks.length,
      source,
      startTime: start,
      duration: effectiveDuration,
      timing,
      ended: false,
    };
    source.onended = () => this.#handleChunkEnded(session, chunk);
    session.chunks.push(chunk);
    session.nextStartTime = start + effectiveDuration + Math.max(0, timing.gapSec);
    source.start(start);
    const scheduleGapMs = Math.max(0, (start - plannedStart) * 1000);
    console.log(
      `[TTS] schedule ${generation}:${chunk.index} at ${start.toFixed(2)} dur ${effectiveDuration.toFixed(2)}` +
        (scheduleGapMs > 5 ? ` gap ${scheduleGapMs.toFixed(0)}ms` : ''),
    );
    if (scheduleGapMs > 50 && chunk.index > 0) {
      console.warn(
        `[TTS] batch ${chunk.index} scheduled ${scheduleGapMs.toFixed(0)}ms late — likely cache/prefetch underrun`,
      );
    }
    if (chunk.index === 0) {
      session.onEvent({ type: 'chunk-start', chunkIndex: 0 });
    }
  }

  endSession(generation: number): void {
    const session = this.#session;
    if (!session || session.generation !== generation) return;
    session.ended = true;
    // Fires synchronously when nothing is unfinished: a session whose marks
    // were all skipped (zero chunks) or whose last onended beat endSession
    // must still end, or auto-advance dead-ends with controls stuck playing.
    this.#maybeEmitSessionEnd(session);
    if (!session.endedEmitted) this.#armEarlyEnd(session);
  }

  // Retire a session that finished naturally (scheduler done, session-end
  // already announced) WITHOUT stopping its still-scheduled tail. Records the
  // tail's end time so the next startSession continues the timeline
  // seamlessly. Returns false — caller should abort instead — when the
  // session is still actively producing or playing un-announced audio.
  finishSessionForHandoff(): boolean {
    const session = this.#session;
    if (!session || !session.ended || !session.endedEmitted) return false;
    if (session.earlyEndTimer !== null) clearTimeout(session.earlyEndTimer);
    this.#session = null;
    this.#unregisterDeviceChangeListener();
    // No scheduler is waiting on a finished session, but resolve defensively.
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter(false);
    this.#handoffNextStartTime = session.nextStartTime;
    console.log(`[TTS] session ${session.generation} handoff`);
    return true;
  }

  abortSession(): void {
    this.#handoffNextStartTime = 0;
    const session = this.#session;
    if (!session) return;
    if (session.earlyEndTimer !== null) clearTimeout(session.earlyEndTimer);
    this.#session = null;
    this.#unregisterDeviceChangeListener();
    for (const chunk of session.chunks) {
      chunk.source.onended = null;
      try {
        chunk.source.stop();
      } catch {
        // Sources that never started or already ended throw; irrelevant here.
      }
      try {
        chunk.source.disconnect();
      } catch {
        // Ignore repeated disconnects.
      }
    }
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter(false);
    console.log(`[TTS] session ${session.generation} abort`);
  }

  async waitUntilReady(generation: number): Promise<boolean> {
    for (;;) {
      const session = this.#session;
      if (!session || session.generation !== generation) return false;
      if (this.#isReadyForMore(session)) return true;
      const ready = await new Promise<boolean>((resolve) => {
        session.waiters.push(resolve);
      });
      if (!ready) return false;
    }
  }

  async pauseContext(): Promise<void> {
    this.#userPaused = true;
    if (this.#ctx && this.#ctx.state === 'running') {
      await this.#ctx.suspend();
    }
  }

  async resumeContext(): Promise<void> {
    this.#userPaused = false;
    const ctx = this.#ctx;
    if (!ctx) return;
    await ctx.resume();
    if (ctx.state !== 'running') {
      // iOS can refuse to leave 'interrupted' (e.g. right after a phone
      // call); fail loudly so the controller stops visibly instead of
      // showing "playing" over silence.
      throw new Error(`AudioContext failed to resume (state: ${ctx.state})`);
    }
  }

  isUserPaused(): boolean {
    return this.#userPaused;
  }

  getPlaybackPosition(generation: number): { chunkIndex: number; mediaTimeSec: number } | null {
    const session = this.#session;
    const ctx = this.#ctx;
    if (!session || session.generation !== generation || !ctx) return null;
    const first = session.chunks[0];
    if (!first) return null;
    const t = ctx.currentTime;
    let active = first;
    for (const chunk of session.chunks) {
      if (chunk.startTime <= t) active = chunk;
      else break;
    }
    const within = Math.min(Math.max(t - active.startTime, 0), active.duration);
    return {
      chunkIndex: active.index,
      mediaTimeSec: active.timing.trimStartSec + within * active.timing.mediaScale,
    };
  }

  async shutdown(): Promise<void> {
    this.abortSession();
    if (this.#ctx && !this.#usesSharedContext) {
      // Test-injected contexts are owned by this player; the shared context
      // stays alive for the whole page (see module comment).
      await this.#ctx.close().catch(() => {});
    }
    this.#ctx = null;
  }

  #isReadyForMore(session: PlayerSession): boolean {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const unfinished = session.chunks.reduce((n, c) => n + (c.ended ? 0 : 1), 0);
    const limit = hidden ? MAX_PENDING_HIDDEN : MAX_PENDING_VISIBLE;
    if (unfinished >= limit) return false;
    if (this.#ctx && session.chunks.length > 0) {
      const maxAheadSec = hidden ? MAX_AHEAD_SEC_HIDDEN : MAX_AHEAD_SEC;
      const aheadSec = session.nextStartTime - this.#ctx.currentTime;
      if (aheadSec >= maxAheadSec) return false;
    }
    return true;
  }

  #handleChunkEnded(session: PlayerSession, chunk: ScheduledChunk): void {
    if (this.#session !== session) return;
    chunk.ended = true;
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter(true);
    const next = session.chunks[chunk.index + 1];
    if (next) {
      session.onEvent({ type: 'chunk-start', chunkIndex: next.index });
    }
    this.#maybeEmitSessionEnd(session);
  }

  #maybeEmitSessionEnd(session: PlayerSession): void {
    if (!session.ended || session.endedEmitted) return;
    if (session.chunks.some((c) => !c.ended)) return;
    session.endedEmitted = true;
    session.onEvent({ type: 'session-end' });
  }

  // Wall-clock timer targeting (scheduledEnd - SESSION_END_EARLY_LEAD_SEC) on
  // the audio clock. Best-effort only: paused/suspended contexts and
  // throttled timers fall back to the onended path.
  #armEarlyEnd(session: PlayerSession): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const fireInSec = session.nextStartTime - SESSION_END_EARLY_LEAD_SEC - ctx.currentTime;
    if (fireInSec <= 0) return;
    session.earlyEndTimer = setTimeout(() => this.#tryEarlyEnd(session), fireInSec * 1000);
  }

  #tryEarlyEnd(session: PlayerSession): void {
    session.earlyEndTimer = null;
    if (this.#session !== session || !session.ended || session.endedEmitted) return;
    const ctx = this.#ctx;
    if (!ctx) return;
    // While paused the audio clock is frozen; announcing the end now would
    // advance paragraphs over silence. Leave it to onended after resume.
    if (this.#userPaused || ctx.state !== 'running') return;
    const remainingSec = session.nextStartTime - ctx.currentTime;
    if (remainingSec > SESSION_END_EARLY_LEAD_SEC + 0.05) {
      // The audio clock lagged wall time (brief suspension); re-arm.
      session.earlyEndTimer = setTimeout(
        () => this.#tryEarlyEnd(session),
        (remainingSec - SESSION_END_EARLY_LEAD_SEC) * 1000,
      );
      return;
    }
    session.endedEmitted = true;
    session.onEvent({ type: 'session-end' });
  }

  #registerDeviceChangeListener(): void {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    // Snapshot current output devices so we can detect removals on change.
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        this.#knownOutputDeviceIds = devices
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => d.deviceId);
      })
      .catch(() => {});
    this.#deviceChangeHandler = () => this.#handleDeviceChange();
    navigator.mediaDevices.addEventListener('devicechange', this.#deviceChangeHandler);
  }

  #unregisterDeviceChangeListener(): void {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !this.#deviceChangeHandler)
      return;
    navigator.mediaDevices.removeEventListener('devicechange', this.#deviceChangeHandler);
    this.#deviceChangeHandler = null;
    this.#knownOutputDeviceIds = [];
  }

  #handleDeviceChange(): void {
    if (!this.#session || this.#userPaused) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const newIds = devices.filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId);
        const outputDeviceRemoved = this.#knownOutputDeviceIds.some((id) => !newIds.includes(id));
        this.#knownOutputDeviceIds = newIds;
        if (outputDeviceRemoved && this.#session && !this.#userPaused) {
          console.log('[TTS] audio output device removed; stopping playback');
          this.#session.onEvent({ type: 'audio-interrupted' });
        }
      })
      .catch(() => {});
  }

  #handleStateChange(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    if (ctx.state === 'running' || this.#userPaused) return;
    if (!this.#session) return;
    // Unexpected AudioContext suspension (e.g. Bluetooth disconnect on iOS,
    // incoming call): stop rather than silently resuming to another output.
    console.log(`[TTS] audio context ${ctx.state}; stopping playback`);
    this.#session.onEvent({ type: 'audio-interrupted' });
  }
}
