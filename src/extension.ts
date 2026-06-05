import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { MuninnClient } from "./client";
import { resolveVaultName, MUNINN_REST_URL, MUNINN_MCP_URL } from "./vault";
import type { ActivationPush } from "./vault";
import { loadSettings } from "./settings";
import {
  markSseSubscribed,
  markSseConnected,
  markSseErrored,
  markSsePushReceived,
  markContextHookObserved,
  resetLiveness,
} from "./liveness";

// ─── Shared client singleton ──────────────────────────────────────────

const client = new MuninnClient(MUNINN_REST_URL);

// ─── Session-start pre-fetch ─────────────────────────────────────────

interface RecentMemory {
  id?: string;
  concept?: string;
  summary?: string;
  content?: string;
  last_access?: string;
}

/**
 * Pre-fetch recent memories via direct MCP HTTP call at session start.
 * Uses the raw MuninnDB tool name (no muninndb_ prefix — that prefix is
 * added by Pi's MCP adapter for namespacing, not by MuninnDB itself).
 * Returns empty array on any error for graceful degradation.
 */
async function fetchWhereLeftOff(vault: string, limit: number = 8): Promise<RecentMemory[]> {
  try {
    const res = await fetch(MUNINN_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "muninn_where_left_off", arguments: { vault, limit } },
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };

    if (json.error || !json.result?.content?.[0]?.text) return [];

    const data = JSON.parse(json.result.content[0].text) as {
      memories?: RecentMemory[];
      count?: number;
    };
    return Array.isArray(data?.memories) ? data.memories : [];
  } catch {
    return [];
  }
}

// ─── Subscription context derivation ──────────────────────────────────

/**
 * Derive 1-3 semantic context strings for SSE subscription.
 *
 * Best available signal: the user's prompt text from BeforeAgentStartEvent.
 * Falls back to prefetched memory concepts + vault name if no prompt yet.
 * Degrades gracefully to no contexts (vault-only firehose) if nothing available.
 */
function deriveSubscriptionContexts(prompt: string | undefined, vault: string, memories: RecentMemory[]): string[] {
  const contexts: string[] = [];

  // Primary: user's current prompt/task
  if (prompt && prompt.trim().length > 0) {
    // Truncate to 200 chars — long contexts waste embedding compute
    const truncated = prompt.trim().substring(0, 200);
    contexts.push(truncated);
  }

  // Secondary: concepts from recent memories (what the agent was working on)
  if (contexts.length < 2 && memories.length > 0) {
    const concepts = memories
      .slice(0, 3)
      .map((m) => m.concept)
      .filter((c): c is string => !!c && c.length > 0)
      .join("; ");
    if (concepts.length > 0) {
      contexts.push(concepts.substring(0, 200));
    }
  }

  // Tertiary: vault name as a broad signal for project-relevant triggers
  if (vault !== "default" && contexts.length < 3) {
    contexts.push(`project: ${vault}`);
  }

  return contexts;
}

// ─── SSE subscription management ──────────────────────────────────────

function startSSESubscription(
  vault: string,
  contexts: string[],
  threshold: number,
  signal: AbortSignal,
  onPush: (push: ActivationPush) => void,
  scoreGate: number,
): void {
  markSseSubscribed();
  (async () => {
    try {
      for await (const push of client.subscribe(
        vault,
        { contexts: contexts.length > 0 ? contexts : undefined, threshold },
        signal,
        markSseConnected,
        markSseErrored,
      )) {
        markSsePushReceived();
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (push.trigger === "threshold_crossed" && push.engram && push.score != null) {
          onPush(push);
        } else if (push.trigger === "new_write" && push.engram && push.score != null && push.score >= scoreGate) {
          onPush(push);
        }
      }
    } catch {
      /* subscription ended */
    }
  })();
}

// ─── Lifecycle hooks ──────────────────────────────────────────────────

export default function registerLifecycleHooks(pi: ExtensionAPI) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes: ActivationPush[] = [];
  let sseAbort: AbortController | null = null;
  let isFirstTurn = true;
  let muninnUp = false;

  // Track the current subscription contexts to detect changes
  let activeContexts: string[] = [];

  /** (Re)start the SSE subscription with the given contexts. */
  function restartSubscription(contexts: string[]): void {
    const settings = loadSettings();
    if (!settings.sse.enabled) return;

    // Only re-subscribe when the context set materially changed
    const changed = contexts.length !== activeContexts.length || contexts.some((c, i) => c !== activeContexts[i]);
    if (!changed && sseAbort) return;

    // Tear down existing subscription
    sseAbort?.abort();
    pendingPushes = [];
    activeContexts = contexts;

    sseAbort = new AbortController();
    startSSESubscription(
      currentVault,
      activeContexts,
      settings.sse.threshold,
      sseAbort.signal,
      (push) => pendingPushes.push(push),
      settings.sse.newWriteScoreGate,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    isFirstTurn = true;
    activeContexts = [];
    const settings = loadSettings();

    try {
      const res = await fetch(`${MUNINN_REST_URL}/api/health`);
      muninnUp = res.ok;
    } catch {
      muninnUp = false;
    }

    if (!muninnUp) {
      ctx.ui.notify("MuninnDB is not running. Run /muninn-setup to install and configure it.", "warning");
      return;
    }

    ctx.ui.notify(`MuninnDB: vault "${currentVault}"`, "info");

    // Start SSE with vault-only context (no prompt yet); will evolve on before_agent_start
    if (settings.sse.enabled) {
      restartSubscription([]);
    }
  });

  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
    isFirstTurn = true;
    activeContexts = [];
    resetLiveness();
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    // Always evolve subscription context on each turn (Issue #2)
    const prompt = (event as BeforeAgentStartEvent).prompt;
    const settings = loadSettings();
    const firstTurn = isFirstTurn;
    isFirstTurn = false;

    // Fetch recent memories ONCE on the first turn and reuse for both
    // context derivation (subscription semantics) and the session-start
    // injection below. Avoids the double MCP round-trip from earlier.
    const memories = firstTurn && muninnUp ? await fetchWhereLeftOff(currentVault, settings.prefetchLimit) : [];

    if (muninnUp && settings.sse.enabled) {
      // Derive context from current prompt + vault + recent memories
      const newContexts = deriveSubscriptionContexts(prompt, currentVault, memories);
      restartSubscription(newContexts);
    }

    // First-turn session context injection (existing behavior)
    if (!muninnUp || !firstTurn) return;

    if (memories.length === 0) {
      // MCP unavailable or vault is empty — fall back to instruction
      return {
        message: {
          customType: "muninn_session_start",
          content:
            `MuninnDB memory connected (vault: "${currentVault}"). ` +
            `Saving is a mindset, not a checklist — when in doubt, save it. ` +
            `Call muninndb_muninn_where_left_off to restore context from your last session, ` +
            `muninndb_muninn_recall for topic-specific searches, ` +
            `and muninndb_muninn_guide to learn vault-specific behavior.`,
          display: false,
        },
      };
    }

    // Format memories as compact numbered context lines
    const lines = memories
      .slice(0, settings.prefetchLimit)
      .map((m, i) => {
        const label = m.concept ?? "Memory";
        const detail = m.summary ?? (m.content ? m.content.substring(0, 120) : "");
        return `${i + 1}. ${label}${detail ? ` — ${detail}` : ""}`;
      })
      .join("\n");

    return {
      message: {
        customType: "muninn_session_start",
        content:
          `🌊 Session context restored (vault: "${currentVault}", ${memories.length} recent memories):\n\n` +
          lines +
          `\n\nSaving is a mindset, not a checklist — when in doubt, save it. ` +
          `Use muninndb_muninn_recall for topic-specific searches, ` +
          `muninndb_muninn_guide to learn vault-specific behavior, ` +
          `and muninndb_muninn_remember_batch after significant work (commits, decisions, releases).`,
        display: false,
      },
    };
  });

  // NOTE: "context" is a Pi extension event that fires before each LLM context
  // assembly, allowing injection of additional context messages. Liveness is
  // tracked in `src/liveness.ts` so `/muninn-health` can surface integration
  // health if this hook ever stops firing.
  pi.on("context" as any, async () => {
    markContextHookObserved();
    if (pendingPushes.length === 0) return;

    const relevant = pendingPushes
      .filter(
        (p) => p.trigger === "new_write" || p.trigger === "contradiction_detected" || p.trigger === "threshold_crossed",
      )
      .slice(0, 3);
    if (relevant.length === 0) return;

    const content = relevant
      .map((p) => {
        if (p.trigger === "contradiction_detected" && p.engram) {
          return (
            `[⚠️ Contradiction detected]: "${p.engram.concept}" — ` +
            `${p.why ?? "New information conflicts with existing memory"}. ` +
            `Use muninndb_muninn_evolve(id="${p.engram.id}", ...) to update it, ` +
            `or muninndb_muninn_consolidate to merge.`
          );
        }
        if (p.trigger === "threshold_crossed" && p.engram) {
          return (
            `[📈 Activation signal]: "${p.engram.concept}" (score: ${p.score?.toFixed(2)}) — ` +
            `this memory's activation score crossed the subscription threshold. `
          );
        }
        return `[Memory Update]: ${p.engram?.concept}: ${p.engram?.content}`;
      })
      .join("\n");

    pendingPushes = [];
    return { message: { customType: "muninn_memory", content, display: true } };
  });
}
