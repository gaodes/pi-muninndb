import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName } from "./vault";
import { loadSettings } from "./settings";
import { markToolCallObserved } from "./liveness";

// ============================================================
// MCP Bridge — Vault Injection + Batch Nudge for MuninnDB Tools
//
// Pi's native MCP adapter (pi-mcp-adapter) handles tool discovery
// and call proxying for all 39 muninn_* tools. This module:
//
// 1. Injects the per-project vault parameter into muninn_* tool calls
// 2. Counts individual muninn_remember calls per turn and nudges
//    toward muninn_remember_batch when 2+ consecutive calls are made
// ============================================================

// All 39 MuninnDB MCP tools (prefixed with muninndb_muninn_ via pi-mcp-adapter).
// Keep in sync with upstream's internal/mcp/context.go registration list.
const MUNINN_TOOLS = new Set([
  // Core read/write
  "muninndb_muninn_remember",
  "muninndb_muninn_remember_batch",
  "muninndb_muninn_recall",
  "muninndb_muninn_read",
  "muninndb_muninn_forget",
  "muninndb_muninn_restore",
  "muninndb_muninn_where_left_off",
  // Evolution & consolidation
  "muninndb_muninn_evolve",
  "muninndb_muninn_consolidate",
  "muninndb_muninn_decide",
  "muninndb_muninn_state",
  // Linking & traversal
  "muninndb_muninn_link",
  "muninndb_muninn_traverse",
  "muninndb_muninn_explain",
  // Trees
  "muninndb_muninn_remember_tree",
  "muninndb_muninn_recall_tree",
  "muninndb_muninn_add_child",
  // Entities
  "muninndb_muninn_entity",
  "muninndb_muninn_entities",
  "muninndb_muninn_find_by_entity",
  "muninndb_muninn_entity_state",
  "muninndb_muninn_entity_state_batch",
  "muninndb_muninn_entity_timeline",
  "muninndb_muninn_entity_clusters",
  "muninndb_muninn_similar_entities",
  "muninndb_muninn_merge_entity",
  "muninndb_muninn_export_graph",
  // Enrichment
  "muninndb_muninn_retry_enrich",
  "muninndb_muninn_get_enrichment_candidates",
  "muninndb_muninn_apply_enrichment",
  "muninndb_muninn_replay_enrichment",
  // Quality & trust
  "muninndb_muninn_contradictions",
  "muninndb_muninn_feedback",
  "muninndb_muninn_trust",
  "muninndb_muninn_provenance",
  "muninndb_muninn_list_deleted",
  // Session & meta
  "muninndb_muninn_status",
  "muninndb_muninn_session",
  "muninndb_muninn_guide",
]);

// Track individual muninn_remember calls per turn for batch nudge
let individualRememberCount = 0;

// Tools that indicate significant "save-worthy" work just completed.
// The tool_call hook fires for all Pi tools, not only MCP tools.
// Loaded from settings so users can customize the checkpoint tool list.

/**
 * Registers tool_call hooks for MuninnDB MCP tools:
 * 1. Vault injection — adds per-project vault to tool calls
 * 2. Batch nudge — reminds the LLM to use remember_batch after 2+
 *    consecutive individual remember calls
 */
export function registerVaultInjection(pi: ExtensionAPI): void {
  // Reset counter at start of each turn
  pi.on("before_agent_start", async () => {
    individualRememberCount = 0;
  });

  // NOTE: "tool_call" is a Pi extension event that fires before each tool call,
  // allowing param injection and side-channel messages. The cast to `any` is a
  // compatibility shim. Liveness is tracked so `/muninn-health` can surface
  // integration health if this hook ever stops firing.
  (pi as any).on("tool_call", async (event: any, _ctx: any) => {
    // Post-commit/push checkpoint: remind the LLM to save memories after
    // significant git operations. Fires best-effort — only if tool_call
    // hook fires for Pi native tools (not just MCP tools).
    const checkpointTools = new Set(loadSettings().checkpointTools);
    if (checkpointTools.has(event.toolName)) {
      const vault = resolveVaultName(process.cwd());
      return {
        message: {
          customType: "muninn_checkpoint_hint",
          content:
            `Checkpoint (${event.toolName}): if this operation involved meaningful decisions, ` +
            `discoveries, or changes, save them now with ` +
            `muninndb_muninn_remember_batch(vault="${vault}", memories=[...]).`,
          display: false,
        },
      };
    }

    // Only intercept known MuninnDB MCP tools (allowlist, not prefix match)
    if (!MUNINN_TOOLS.has(event.toolName)) return;
    if (!event.input) return;

    markToolCallObserved();

    const input = event.input as Record<string, unknown>;

    // Inject vault from cwd if the caller didn't specify one
    if (!input.vault) {
      event.input = { ...input, vault: resolveVaultName(process.cwd()) };
    }

    // Auto-inject annotate: true on recall calls so agents get
    // staleness/conflict/trust metadata without remembering the flag
    // Also inject a feedback hint — recall is the main retrieval path
    // and agents should know about muninn_feedback for quality scoring.
    if (event.toolName === "muninndb_muninn_recall" && input.annotate !== true) {
      event.input = { ...event.input, annotate: true };
      return {
        message: {
          customType: "muninn_recall_hint",
          content:
            "💡 After using recall results, consider sending muninndb_muninn_feedback " +
            "with useful=true/false to help the vault learn better scoring weights.",
          display: false,
        },
      };
    }

    // Batch nudge: count individual muninn_remember calls
    if (event.toolName === "muninndb_muninn_remember") {
      individualRememberCount++;
      if (individualRememberCount === 2) {
        // Inject a nudge after the second individual remember call
        return {
          message: {
            customType: "muninn_batch_nudge",
            content:
              "💡 You've made 2 individual muninn_remember calls this turn. " +
              "Use muninndb_muninn_remember_batch for related memories instead of " +
              "multiple individual calls. Assess all memories first, then batch save.",
            display: true,
          },
        };
      }
    }

    // Reset counter on batch call — using batch correctly
    if (event.toolName === "muninndb_muninn_remember_batch") {
      individualRememberCount = 0;
    }
  });
}
