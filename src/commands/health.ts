import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName, MUNINN_REST_URL } from "../vault";
import { liveness } from "../liveness";

interface ServicePorts {
  rest: number | null;
  mcp: number | null;
  ui: number | null;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function parseServicePorts(statusOutput: string): ServicePorts {
  const rest = statusOutput.match(/^\s*database\s+(\d+)\s+\[[^\]]+\]/im);
  const mcp = statusOutput.match(/^\s*mcp\s+(\d+)\s+\[[^\]]+\]/im);
  const ui = statusOutput.match(/^\s*web\s+ui\s+(\d+)\s+\[[^\]]+\]/im);

  return {
    rest: rest ? Number(rest[1]) : null,
    mcp: mcp ? Number(mcp[1]) : null,
    ui: ui ? Number(ui[1]) : null,
  };
}

function formatAgo(ts: number | null): string {
  if (ts == null) return "never";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function parseTotalVaults(showVaultsOutput: string): number | null {
  const lines = showVaultsOutput.split(/\r?\n/).filter((line) => /^\s*[•*-]\s+/.test(line));
  return lines.length > 0 ? lines.length : null;
}

function getVaultMemoryCount(raw: unknown, vault: string): number | null {
  if (!raw || typeof raw !== "object") return null;

  // /api/stats returns { engram_count, vault_count, coherence: { <vault>: { total_engrams, score, ... } } }
  const stats = raw as Record<string, unknown>;

  // Try coherence map first (per-vault breakdown)
  const coherence = stats.coherence;
  if (coherence && typeof coherence === "object") {
    const vaultStats = (coherence as Record<string, unknown>)[vault];
    if (vaultStats && typeof vaultStats === "object") {
      const totalEngrams = (vaultStats as Record<string, unknown>).total_engrams;
      if (typeof totalEngrams === "number" && Number.isFinite(totalEngrams)) {
        return totalEngrams;
      }
    }
  }

  // Fallback: top-level engram_count (global total, not per-vault)
  const directKeys = ["engram_count", "memory_count", "total_memories", "count"];
  for (const key of directKeys) {
    const value = stats[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }

  return null;
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url);
  let data: unknown = null;

  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { ok: res.ok, status: res.status, data };
}

export function registerHealthCommand(pi: ExtensionAPI): void {
  pi.registerCommand("muninn-health", {
    description: "Show MuninnDB health and vault status",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const currentVault = resolveVaultName(process.cwd());
      const reportNotes: string[] = [];

      let healthOk = false;
      try {
        const health = await fetchJson(`${MUNINN_REST_URL}/api/health`);
        healthOk = health.ok;
      } catch {
        healthOk = false;
      }

      let vaultMemoryCount: number | null = null;
      let vaultCoherenceScore: number | null = null;
      if (healthOk) {
        try {
          // /api/stats returns global stats + per-vault coherence breakdown
          const stats = await fetchJson(`${MUNINN_REST_URL}/api/stats`);

          if (stats.ok && stats.data) {
            vaultMemoryCount = getVaultMemoryCount(stats.data, currentVault);

            // Extract coherence score for current vault
            const data = stats.data as Record<string, unknown>;
            const coherence = data.coherence as Record<string, unknown> | undefined;
            if (coherence) {
              const vaultStats = coherence[currentVault] as Record<string, unknown> | undefined;
              if (vaultStats && typeof vaultStats.score === "number") {
                vaultCoherenceScore = vaultStats.score;
              }
            }
          }

          if (vaultMemoryCount === null) {
            reportNotes.push("Vault memory count unavailable from stats API.");
          }
        } catch {
          reportNotes.push("Vault stats unavailable.");
        }
      } else {
        reportNotes.push("REST API is down, vault stats could not be fetched.");
      }

      const statusResult = (await pi.exec("muninn", ["status"], {
        cwd: process.cwd(),
      })) as ExecResult;

      const vaultsResult = (await pi.exec("muninn", ["show", "vaults"], {
        cwd: process.cwd(),
      })) as ExecResult;

      const statusOutput = [statusResult.stdout, statusResult.stderr].filter(Boolean).join("\n").trim();
      const vaultsOutput = [vaultsResult.stdout, vaultsResult.stderr].filter(Boolean).join("\n").trim();

      const ports = parseServicePorts(statusOutput);
      const totalVaults = parseTotalVaults(vaultsOutput);
      const serviceUp = healthOk || /\[\s*up\s*\]/i.test(statusOutput);

      if (statusResult.code !== 0 && !statusOutput) {
        reportNotes.push("`muninn status` failed — CLI may not be installed or service is stopped.");
      }

      if (vaultsResult.code !== 0 && !vaultsOutput) {
        reportNotes.push("`muninn show vaults` failed.");
      }

      const lines = [
        "MuninnDB Health Report",
        "----------------------",
        `Server: ${serviceUp ? "UP" : "DOWN"}`,
        `REST port: ${ports.rest ?? 8475}`,
        `MCP port: ${ports.mcp ?? 8750}`,
        `UI port: ${ports.ui ?? 8476}`,
        `Current vault: ${currentVault}`,
        `Vault memory count: ${vaultMemoryCount ?? "unknown"}`,
        `Vault coherence: ${vaultCoherenceScore !== null ? vaultCoherenceScore.toFixed(3) : "unknown"}`,
        `Total vaults: ${totalVaults ?? "unknown"}`,
        "",
        "Extension liveness:",
        `  SSE last subscribe attempt: ${formatAgo(liveness.sseSubscribedAt)}`,
        `  SSE last successful connect: ${formatAgo(liveness.sseConnectedAt)}`,
        `  SSE last error: ${formatAgo(liveness.sseErroredAt)}`,
        `  Last SSE push received: ${formatAgo(liveness.lastSsePushAt)}`,
        `  tool_call hook observed: ${formatAgo(liveness.toolCallObservedAt)}`,
        `  context hook observed: ${formatAgo(liveness.contextHookObservedAt)}`,
      ];

      if (reportNotes.length > 0) {
        lines.push("", "Notes:");
        for (const note of reportNotes) lines.push(`- ${note}`);
      }

      if (!serviceUp) {
        lines.push("", "MuninnDB appears to be down. Start it with `muninn start` or run `/muninn-setup`.");
      }

      ctx.ui.notify(lines.join("\n"), serviceUp ? "info" : "warning");
    },
  });
}
