import { EDGE_TTS_WS_PATH } from '@/services/environment';

// How long to keep an endpoint out of rotation after repeated failures.
const DISABLE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

// Consecutive failures required before an endpoint is disabled for 10 min.
// A single transient drop (brief network blip, proxy restart) does NOT
// immediately pull a server out of rotation — the higher-level retry in
// EdgeTTSClient already handles one-off failures with backoff. Only truly
// unreachable endpoints accumulate enough failures to be disabled.
const FAILURE_THRESHOLD = 2;

interface Endpoint {
  host: string;
  disabledUntil: number; // epoch ms; 0 = healthy / in-rotation
  consecutiveFailures: number; // resets to 0 on any success or after cooldown
}

// The two self-hosted Edge-TTS relay servers to load-balance across.
const SELF_HOSTED_HOSTS = ['47.112.207.44:57880', '175.178.236.127:57880'];

/**
 * Returns true for errors that indicate the text payload itself cannot be
 * synthesised, rather than a problem with the server or network connection.
 * These errors must NOT penalise the endpoint and must propagate immediately
 * so the caller's skip path kicks in (same logic as isNoAudioSynthesisError
 * in EdgeTTSClient, kept here to avoid coupling the network layer to ssml.ts).
 */
const isContentError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes('no audio data received') || m.includes('no audio was received');
};

export class TtsWsLoadBalancer {
  private readonly endpoints: Endpoint[];
  // Cursor advances each call so requests naturally alternate across endpoints.
  private cursor = 0;

  constructor(hosts: string[] = SELF_HOSTED_HOSTS) {
    this.endpoints = hosts.map((host) => ({
      host,
      disabledUntil: 0,
      consecutiveFailures: 0,
    }));
  }

  /**
   * Re-enable endpoints whose cooldown has elapsed and reset their failure
   * counters so they start fresh after the grace period.
   */
  private refreshEndpoints(): void {
    const now = Date.now();
    for (const ep of this.endpoints) {
      if (ep.disabledUntil > 0 && now >= ep.disabledUntil) {
        ep.disabledUntil = 0;
        ep.consecutiveFailures = 0;
        console.info(`[TTS] Endpoint ${ep.host} re-enabled after cooldown.`);
      }
    }
  }

  private buildUrl(host: string): string {
    return `ws://${host}${EDGE_TTS_WS_PATH}`;
  }

  /**
   * Execute `fetchFn` against the next available endpoint (round-robin).
   *
   * Failure handling:
   * - AbortError → propagates immediately, no endpoint penalised.
   * - Content/synthesis error ("no audio data received") → propagates
   *   immediately without penalising the endpoint (the server is fine; the
   *   specific text just cannot be synthesised).
   * - Connection/network error → consecutive-failure counter incremented; the
   *   next available endpoint is tried in the same call. Once an endpoint
   *   reaches FAILURE_THRESHOLD consecutive failures it is disabled for
   *   DISABLE_DURATION_MS (10 min). Counter resets to 0 on any success or
   *   when the cooldown expires and the endpoint re-enters rotation.
   *
   * Throws only when all currently-available endpoints have been tried and
   * failed, or when every endpoint is already disabled.
   */
  async fetch<T>(fetchFn: (url: string) => Promise<T>): Promise<T> {
    this.refreshEndpoints();

    // Build a round-robin–ordered slice of currently healthy endpoints.
    const total = this.endpoints.length;
    const ordered: Endpoint[] = [];
    for (let offset = 0; offset < total; offset++) {
      const ep = this.endpoints[(this.cursor + offset) % total]!;
      if (ep.disabledUntil === 0) ordered.push(ep);
    }

    if (ordered.length === 0) {
      // Report how long until the earliest endpoint comes back.
      const soonest = Math.min(
        ...this.endpoints.map((ep) => ep.disabledUntil).filter((t) => t > 0),
      );
      const waitSec = isFinite(soonest) ? Math.ceil((soonest - Date.now()) / 1000) : '?';
      throw new Error(
        `[TTS] All endpoints are currently unavailable. Please try again in ~${waitSec}s.`,
      );
    }

    // Advance cursor so the next independent call starts from the next slot.
    this.cursor = (this.cursor + 1) % total;

    let lastError: unknown;
    for (const ep of ordered) {
      const url = this.buildUrl(ep.host);
      try {
        const result = await fetchFn(url);
        // Success — clear any accumulated failure streak for this endpoint.
        ep.consecutiveFailures = 0;
        return result;
      } catch (err) {
        // User-initiated abort: not a server fault; propagate without penalty.
        if (err instanceof DOMException && err.name === 'AbortError') throw err;

        // Synthesis / content error: the server responded correctly but the
        // payload cannot produce audio. Do not blame the endpoint; rethrow so
        // the caller's skip path handles it immediately instead of wasting a
        // failover attempt on an identical payload.
        if (isContentError(err)) throw err;

        // Connection / network error: penalise the endpoint.
        lastError = err;
        ep.consecutiveFailures++;

        if (ep.consecutiveFailures >= FAILURE_THRESHOLD) {
          ep.disabledUntil = Date.now() + DISABLE_DURATION_MS;
          ep.consecutiveFailures = 0;
          console.warn(
            `[TTS] Endpoint ${ep.host} disabled for ${DISABLE_DURATION_MS / 60_000} min ` +
              `after ${FAILURE_THRESHOLD} consecutive failures.`,
            err,
          );
        } else {
          console.warn(
            `[TTS] Endpoint ${ep.host} failed ` +
              `(${ep.consecutiveFailures}/${FAILURE_THRESHOLD}), trying next.`,
            err,
          );
        }
      }
    }

    throw lastError ?? new Error('[TTS] All available endpoints failed for this request.');
  }
}

/** Module-level singleton shared across all EdgeSpeechTTS instances. */
export const ttsWsLoadBalancer = new TtsWsLoadBalancer();
