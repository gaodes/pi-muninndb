/**
 * Liveness tracking for Pi extension hooks.
 *
 * The extension relies on `context` and `tool_call` events that are present
 * in ExtensionAPI but were historically treated as internal/undocumented.
 * If a Pi update stops firing them, SSE pushes and vault injection would
 * silently break. This module exposes observable timestamps so
 * `/muninn-health` can surface integration health visibly.
 *
 * `sseSubscribedAt` marks the last SUBSCRIBE ATTEMPT (may be in backoff).
 * `sseConnectedAt` marks the last successful SSE connection (post-handshake).
 * `sseErroredAt` marks the last SSE connection error.
 */

export interface LivenessState {
  /** When the SSE subscription was last (re)started. Null if never started. */
  sseSubscribedAt: number | null;
  /** When the SSE connection last completed its HTTP handshake. Null if never connected. */
  sseConnectedAt: number | null;
  /** When the last SSE connection error occurred. Null if no error yet. */
  sseErroredAt: number | null;
  /** When the last SSE push was received. Null if no push yet. */
  lastSsePushAt: number | null;
  /** When the tool_call hook last fired for a MuninnDB tool. */
  toolCallObservedAt: number | null;
  /** When the context hook last fired. */
  contextHookObservedAt: number | null;
}

export const liveness: LivenessState = {
  sseSubscribedAt: null,
  sseConnectedAt: null,
  sseErroredAt: null,
  lastSsePushAt: null,
  toolCallObservedAt: null,
  contextHookObservedAt: null,
};

/** Mark that an SSE subscription was (re)attempted right now. */
export function markSseSubscribed(): void {
  liveness.sseSubscribedAt = Date.now();
}

/** Mark that an SSE HTTP handshake completed successfully right now. */
export function markSseConnected(): void {
  liveness.sseConnectedAt = Date.now();
}

/** Mark that an SSE connection errored right now. */
export function markSseErrored(): void {
  liveness.sseErroredAt = Date.now();
}

/** Mark that an SSE push was delivered. */
export function markSsePushReceived(): void {
  liveness.lastSsePushAt = Date.now();
}

/** Mark that the tool_call hook fired for a MuninnDB tool. */
export function markToolCallObserved(): void {
  liveness.toolCallObservedAt = Date.now();
}

/** Mark that the context hook fired. */
export function markContextHookObserved(): void {
  liveness.contextHookObservedAt = Date.now();
}

/** Reset all liveness state (e.g. on session shutdown). */
export function resetLiveness(): void {
  liveness.sseSubscribedAt = null;
  liveness.sseConnectedAt = null;
  liveness.sseErroredAt = null;
  liveness.lastSsePushAt = null;
  liveness.toolCallObservedAt = null;
  liveness.contextHookObservedAt = null;
}
