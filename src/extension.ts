import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MuninnClient } from "./client";
import { resolveVaultName, MUNINN_REST_URL, MUNINN_MCP_URL } from "./vault";
import type { ActivationPush } from "./vault";

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
async function fetchWhereLeftOff(vault: string, limit = 8): Promise<RecentMemory[]> {
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

// ─── SSE subscription filter ──────────────────────────────────────────

function startSSESubscription(vault: string, signal: AbortSignal, onPush: (push: ActivationPush) => void): void {
  (async () => {
    try {
      for await (const push of client.subscribe(vault, signal)) {
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (push.trigger === "threshold_crossed" && push.engram && push.score != null) {
          onPush(push);
        } else if (push.trigger === "new_write" && push.engram && push.score != null && push.score >= 0.7) {
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

  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    isFirstTurn = true;

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

    sseAbort = new AbortController();
    startSSESubscription(currentVault, sseAbort.signal, (push) => pendingPushes.push(push));
  });

  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
    isFirstTurn = true;
  });

  pi.on("before_agent_start", async () => {
    if (!muninnUp || !isFirstTurn) return;
    isFirstTurn = false;

    // Attempt to pre-fetch recent memories directly so session context
    // is available without requiring the LLM to call where_left_off first.
    const memories = await fetchWhereLeftOff(currentVault);

    if (memories.length === 0) {
      // MCP unavailable or vault is empty — fall back to instruction
      return {
        message: {
          customType: "muninn_session_start",
          content:
            `MuninnDB memory connected (vault: "${currentVault}"). ` +
            `Call muninndb_muninn_where_left_off to restore context from your last session, ` +
            `then muninndb_muninn_recall for topic-specific searches.`,
          display: false,
        },
      };
    }

    // Format memories as compact numbered context lines
    const lines = memories
      .slice(0, 8)
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
          `\n\nUse muninndb_muninn_recall for topic-specific searches throughout this session. ` +
          `After significant work (commits, decisions, releases), ` +
          `save with muninndb_muninn_remember_batch.`,
        display: false,
      },
    };
  });

  // NOTE: "context" is an undocumented Pi extension event not in the public
  // type definitions. It fires before each LLM context assembly, allowing
  // injection of additional context messages. If Pi removes or renames this
  // event in a future version, SSE push notifications will silently stop.
  pi.on("context" as any, async () => {
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
