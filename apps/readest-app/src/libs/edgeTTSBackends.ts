import { getEdgeTTSWsUrls } from '@/services/environment';

// Load balancer for the interchangeable self-hosted Edge TTS WebSocket
// backends. Each synthesis asks for an ordered list of candidates and tries
// them in turn (see EdgeSpeechTTS.#fetchEdgeSpeechWsBalanced); a backend that
// fails is put on a cooldown so later requests skip it until it has had time
// to recover. The contract the caller relies on:
//
//   - orderedCandidates() never returns an empty list while any backend is
//     configured, so playback always has something to try (both-down is the
//     only real failure the user can see).
//   - A single dead/unreachable backend is disabled for 10 min, after which it
//     is offered again; if it works it is re-enabled, otherwise re-disabled.
//   - Failures that look network-wide (device offline, or multiple backends
//     failing within a few seconds of each other) use a short cooldown instead
//     of the full 10 min, and any 'online'/connection-change event clears all
//     cooldowns. Together these make recovery after a network switch, a weak
//     signal, or a fast reconnect near-instant instead of a 10 min stall.
//
// URL list: any length (1..N). Configured in constants.ts READEST_EDGE_TTS_BASE_URLS
// or NEXT_PUBLIC_EDGE_TTS_BASE_URLS — see getEdgeTTSWsUrls().
//
// State is process-global (module singleton) so every EdgeSpeechTTS instance
// and the shared WS concurrency limiter observe the same health picture.

// A backend that fails in isolation is presumed genuinely down and benched for
// this long before being offered again.
export const EDGE_TTS_BACKEND_COOLDOWN_MS = 10 * 60 * 1000;

// Failures that correlate with a network-wide problem recover on this much
// shorter timer so a blip / handoff does not bench every backend for 10 min.
const NETWORK_ISSUE_COOLDOWN_MS = 5 * 1000;

// Two failures landing within this window of each other are treated as one
// network-wide event rather than two independent backend outages.
const CORRELATED_FAILURE_WINDOW_MS = 5 * 1000;

interface BackendState {
  url: string;
  // Epoch ms until which this backend is benched; <= now means healthy.
  disabledUntil: number;
  lastFailureAt: number;
  consecutiveFailures: number;
}

const now = (): number => Date.now();

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

class EdgeTTSBackendPool {
  #states: BackendState[] = [];
  #rrIndex = 0;
  #initialized = false;

  #ensureInit(): void {
    if (this.#initialized) return;
    this.#initialized = true;
    const urls = getEdgeTTSWsUrls();
    this.#states = urls.map((url) => ({
      url,
      disabledUntil: 0,
      lastFailureAt: 0,
      consecutiveFailures: 0,
    }));
    this.#installNetworkListeners();
  }

  // A network transition (Wi-Fi <-> cellular, tunnel up/down, regained signal)
  // changes which backends are reachable, so any prior verdict is stale. Wipe
  // all cooldowns on these events and let the next request re-probe from
  // scratch — this is what makes a fast reconnect resume immediately.
  #installNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    const reset = () => this.resetAll();
    try {
      window.addEventListener('online', reset);
    } catch {
      // window without addEventListener (non-browser DOM shim); ignore.
    }
    const connection = (
      navigator as unknown as {
        connection?: { addEventListener?: (t: string, cb: () => void) => void };
      }
    )?.connection;
    connection?.addEventListener?.('change', reset);
  }

  #find(url: string): BackendState | undefined {
    return this.#states.find((state) => state.url === url);
  }

  resetAll(): void {
    for (const state of this.#states) {
      state.disabledUntil = 0;
      state.consecutiveFailures = 0;
    }
  }

  getBackendUrls(): string[] {
    this.#ensureInit();
    return this.#states.map((state) => state.url);
  }

  // Ordered candidates for a single synthesis attempt: healthy backends first
  // (round-robin so load spreads across them), then any benched backends by
  // soonest recovery as a last resort. The benched fallback guarantees the
  // list is never empty — when everything is on cooldown (e.g. both went down
  // together) we still hand back the closest-to-recovery URL so playback keeps
  // trying instead of hard-failing, and a success there re-enables it.
  orderedCandidates(): string[] {
    this.#ensureInit();
    if (this.#states.length === 0) return [];
    const t = now();
    const healthy = this.#states.filter((s) => s.disabledUntil <= t);
    const benched = this.#states
      .filter((s) => s.disabledUntil > t)
      .sort((a, b) => a.disabledUntil - b.disabledUntil);

    const rotated = this.#rotate(healthy);
    // Advance the round-robin cursor once per request so consecutive requests
    // start from different backends even when a single request only uses one.
    if (healthy.length > 0) this.#rrIndex = (this.#rrIndex + 1) % healthy.length;

    return [...rotated, ...benched].map((s) => s.url);
  }

  #rotate(states: BackendState[]): BackendState[] {
    if (states.length <= 1) return states;
    const offset = this.#rrIndex % states.length;
    return [...states.slice(offset), ...states.slice(0, offset)];
  }

  // Cheapest single pick (first ordered candidate) for callers that do not do
  // their own failover loop.
  pick(): string | null {
    const candidates = this.orderedCandidates();
    return candidates[0] ?? null;
  }

  reportSuccess(url: string): void {
    this.#ensureInit();
    const state = this.#find(url);
    if (!state) return;
    state.disabledUntil = 0;
    state.consecutiveFailures = 0;
  }

  // Bench a backend after a failed synthesis. `networkLikely` lets the caller
  // force the short cooldown (e.g. the error was an abort/timeout that clearly
  // reflects the local link, not the server); by default the pool infers it
  // from the offline flag and cross-backend failure correlation.
  reportFailure(url: string, options?: { networkLikely?: boolean }): void {
    this.#ensureInit();
    const state = this.#find(url);
    if (!state) return;

    const t = now();
    state.lastFailureAt = t;
    state.consecutiveFailures += 1;

    const others = this.#states.filter((s) => s !== state);
    const correlated = others.some(
      (o) => o.lastFailureAt > 0 && t - o.lastFailureAt <= CORRELATED_FAILURE_WINDOW_MS,
    );
    const networkLikely = options?.networkLikely || isOffline() || correlated;
    const cooldown = networkLikely ? NETWORK_ISSUE_COOLDOWN_MS : EDGE_TTS_BACKEND_COOLDOWN_MS;
    state.disabledUntil = t + cooldown;

    // When a failure is network-wide, relax any sibling that was long-benched
    // in the same window: it was almost certainly the same outage, not a
    // genuine server fault, so it should recover on the short timer too.
    if (networkLikely) {
      for (const other of others) {
        if (
          other.disabledUntil > t + NETWORK_ISSUE_COOLDOWN_MS &&
          other.lastFailureAt > 0 &&
          t - other.lastFailureAt <= CORRELATED_FAILURE_WINDOW_MS
        ) {
          other.disabledUntil = t + NETWORK_ISSUE_COOLDOWN_MS;
        }
      }
    }
  }
}

export const edgeTTSBackends = new EdgeTTSBackendPool();
