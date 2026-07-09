import { getEdgeTTSWsUrls } from '@/services/environment';

// Load balancer for the interchangeable self-hosted Edge TTS WebSocket
// backends. Each synthesis asks for an ordered list of candidates and tries
// them in turn (see EdgeSpeechTTS.#fetchEdgeSpeechWsBalanced). Contract:
//
//   - A single abnormal response does NOT bench a backend. Only after
//     EDGE_TTS_FAILURES_BEFORE_DISABLE consecutive failures is it disabled
//     for EDGE_TTS_BACKEND_COOLDOWN_MS.
//   - When every backend is benched, orderedCandidates() clears all disables
//     and starts over (cycle) so playback never dead-ends on a full cooldown.
//   - Network-wide blips use a short cooldown; online/connection-change resets.
//
// URL list: any length (1..N). See getEdgeTTSWsUrls() / constants.ts.
// Process-global singleton so every EdgeSpeechTTS shares the same health map.

// Isolated multi-failure cooldown (one dead relay).
export const EDGE_TTS_BACKEND_COOLDOWN_MS = 10 * 60 * 1000;

// Soft failures before a backend is actually disabled. One flaky Microsoft
// "No audio" / timeout must not remove a healthy relay for 10 minutes.
export const EDGE_TTS_FAILURES_BEFORE_DISABLE = 3;

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
      state.lastFailureAt = 0;
    }
  }

  getBackendUrls(): string[] {
    this.#ensureInit();
    return this.#states.map((state) => state.url);
  }

  /** True when every configured backend is currently on cooldown. */
  allDisabled(): boolean {
    this.#ensureInit();
    if (this.#states.length === 0) return false;
    const t = now();
    return this.#states.every((s) => s.disabledUntil > t);
  }

  // Ordered candidates for a single synthesis attempt: healthy backends first
  // (round-robin), never soft-including benched ones in the normal path.
  // If *all* backends are disabled, clear the disable list and cycle so the
  // request always has a full healthy set to try again.
  orderedCandidates(): string[] {
    this.#ensureInit();
    if (this.#states.length === 0) return [];
    const t = now();
    let healthy = this.#states.filter((s) => s.disabledUntil <= t);

    if (healthy.length === 0) {
      // All benched → wipe cooldowns and retry the full pool (循环往复).
      this.resetAll();
      healthy = [...this.#states];
    }

    const rotated = this.#rotate(healthy);
    // Advance the round-robin cursor once per request so consecutive requests
    // start from different backends even when a single request only uses one.
    if (healthy.length > 0) this.#rrIndex = (this.#rrIndex + 1) % healthy.length;

    return rotated.map((s) => s.url);
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

  // Record a failed synthesis. Soft failures only increment the counter;
  // the backend stays eligible until EDGE_TTS_FAILURES_BEFORE_DISABLE in a
  // row. `networkLikely` forces the short cooldown once the threshold is hit
  // (timeout / offline / correlated multi-backend fail).
  reportFailure(url: string, options?: { networkLikely?: boolean }): void {
    this.#ensureInit();
    const state = this.#find(url);
    if (!state) return;

    const t = now();
    state.lastFailureAt = t;
    state.consecutiveFailures += 1;

    // One-off flukes (Microsoft empty audio, brief stall) must not bench the
    // relay. Keep serving it until we have a streak of failures.
    if (state.consecutiveFailures < EDGE_TTS_FAILURES_BEFORE_DISABLE) {
      return;
    }

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

    // If this disable completed a full outage of the pool, clear immediately
    // so the next orderedCandidates() / cycle is not empty.
    if (this.allDisabled()) {
      this.resetAll();
    }
  }
}

export const edgeTTSBackends = new EdgeTTSBackendPool();
