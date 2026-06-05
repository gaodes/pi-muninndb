import { MUNINN_REST_URL } from "./vault";
import type { ActivationPush } from "./vault";
import { DEFAULT_SETTINGS } from "./settings";

/**
 * Hosts that the SSE client is allowed to connect to.
 *
 * The default MUNINN_REST_URL is hardcoded to 127.0.0.1:8475 (loopback),
 * but the constructor accepts a user-supplied restUrl, so we allowlist
 * loopback hostnames explicitly. Anything else is rejected to keep this
 * client from being used as an open SSRF proxy.
 */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Minimal MuninnDB REST client — SSE subscription only.
 * All other operations go through MCP tools.
 */
export class MuninnClient {
  private baseUrl: string;

  constructor(restUrl: string = MUNINN_REST_URL) {
    this.baseUrl = restUrl.replace(/\/+$/, "");
  }

  /**
   * Subscribe to real-time memory push events via SSE.
   *
   * MuninnDB pushes:
   * - new_write: memory stored matching the subscription threshold
   * - contradiction_detected: new memory conflicts with existing one
   * - threshold_crossed: memory's activation score crosses threshold
   *
   * Per MuninnDB's semantic triggers API, the `contexts` parameter enables
   * context-aware push: pass 1-3 strings describing the agent's current task
   * and the database fires triggers when ANY context matches above threshold.
   * Without contexts, the subscription is a generic firehose (any high-scoring write).
   *
   * Auto-reconnects with exponential backoff (5s → 5min) and is abortable
   * during the backoff sleep (the generator resolves immediately on signal).
   */
  async *subscribe(
    vault: string,
    options?: {
      /** Semantic context strings for targeted push (1-3 recommended). */
      contexts?: string[];
      /** Subscription threshold (0.0–1.0). Default: DEFAULT_SETTINGS.sse.threshold */
      threshold?: number;
    },
    signal?: AbortSignal,
    onConnected?: () => void,
    onError?: () => void,
  ): AsyncGenerator<ActivationPush> {
    let reconnectAttempts = 0;
    const threshold = options?.threshold ?? DEFAULT_SETTINGS.sse.threshold;
    const url = new URL(`${this.baseUrl}/api/subscribe`);
    url.searchParams.set("vault", vault);
    url.searchParams.set("push_on_write", "true");
    url.searchParams.set("threshold", String(threshold));

    // Append each context as a repeated query param — MuninnDB matches ANY context above threshold.
    // See upstream docs/semantic-triggers.md: "Multiple contexts are passed via repeated query params"
    if (options?.contexts?.length) {
      for (const ctx of options.contexts) {
        url.searchParams.append("context", ctx);
      }
    }

    // Defense-in-depth: reject non-loopback hosts even if the constructor
    // was passed a non-localhost URL. The fetch target is the loopback
    // MuninnDB REST server only; the URL is otherwise constructed from
    // URLSearchParams which encodes its inputs safely.
    if (!ALLOWED_HOSTNAMES.has(url.hostname)) {
      throw new Error(`Refusing SSE connect: hostname "${url.hostname}" is not loopback`);
    }

    while (!signal?.aborted) {
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "text/event-stream" },
          signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        // HTTP handshake succeeded — let callers distinguish "attempted" from "connected"
        onConnected?.();
        reconnectAttempts = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                /* skip malformed SSE data */
              }
            }
          }
        }
      } catch {
        if (signal?.aborted) break;
        onError?.();
        const retryDelay = Math.min(5000 * Math.pow(2, reconnectAttempts), 300000);
        reconnectAttempts++;
        await abortableSleep(retryDelay, signal);
      }
    }
  }
}

/**
 * Sleep for `ms` milliseconds, resolving immediately if the signal aborts.
 * The timer is cleared on abort to prevent the timeout from firing after
 * a fast abort (e.g. when the subscription is being torn down).
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}
