import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
import { setupMuninnDB, uninstallMuninnDB } from "./src/setup";
import {
  resolveVaultName,
  readVaultMapping,
  writeVaultMapping,
  isProjectDirectory,
  PROJECT_MARKERS,
} from "./src/vault";
import { registerBackupCommand } from "./src/commands/backup";
import { registerHealthCommand } from "./src/commands/health";
import { registerDreamCommand } from "./src/commands/dream";
import { registerImportCommand } from "./src/commands/import";
import { registerUpgradeCommand } from "./src/commands/upgrade";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * MuninnDB Memory Extension for Pi.
 *
 * Commands:
 *   /muninn-setup    — Install, configure, and verify MuninnDB integration
 *   /muninn-remove   — Remove MuninnDB integration (keeps MuninnDB data)
 *   /muninn-vault    — Manage vaults: status, create, unlink
 *   /muninn-dream    — Run dream protocol via CLI (dry-run preview + execution)
 *   /muninn-test     — Run smoke tests against MuninnDB REST API
 *   /muninn-backup   — Export vault archive + offline data backup
 *   /muninn-health   — Show server status, vault stats, service ports
 *   /muninn-import   — Import a .muninn backup archive into a vault
 *   /muninn-upgrade  — Check for and install MuninnDB updates
 */
export default function (pi: ExtensionAPI) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);

  // New CLI-wrapped commands
  registerBackupCommand(pi);
  registerHealthCommand(pi);
  registerDreamCommand(pi);
  registerImportCommand(pi);
  registerUpgradeCommand(pi);

  pi.registerCommand("muninn-setup", {
    description: "Setup MuninnDB memory integration (install, configure, verify)",
    handler: async (_args, ctx) => {
      await setupMuninnDB(ctx);
    },
  });

  pi.registerCommand("muninn-remove", {
    description: "Remove MuninnDB integration (keeps MuninnDB data)",
    handler: async (_args, ctx) => {
      await uninstallMuninnDB(ctx);
    },
  });

  pi.registerCommand("muninn-vault", {
    description: "Manage MuninnDB vaults (status, create, unlink)",
    handler: async (args, ctx) => {
      const cwd = process.cwd();
      const subcommand = args?.trim().split(/\s+/)[0] || "status";
      const name = args?.trim().split(/\s+/).slice(1).join(" ");

      const mapping = readVaultMapping();
      const currentVault = resolveVaultName(cwd);
      const isProject = isProjectDirectory(cwd);

      switch (subcommand) {
        case "create": {
          const vaultName = name || cwd.split("/").filter(Boolean).pop() || "default";
          const sanitized = vaultName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/^-+|-+$/g, "")
            .substring(0, 64);

          if (!sanitized || sanitized === "default") {
            ctx.ui.notify('Cannot create a vault named "default". Choose a project-specific name.', "warning");
            return;
          }

          mapping[cwd] = sanitized;
          writeVaultMapping(mapping);

          ctx.ui.notify(
            `✓ Linked ${cwd} → vault "${sanitized}"\n` +
              `  Memories in this directory will use vault "${sanitized}".\n` +
              `  The vault will be created on first write.`,
            "info",
          );
          break;
        }

        case "unlink": {
          if (!mapping[cwd]) {
            ctx.ui.notify("This directory is not explicitly linked to a vault.", "info");
            return;
          }

          const removed = mapping[cwd];
          delete mapping[cwd];
          writeVaultMapping(mapping);

          const fallback = isProject ? cwd.split("/").filter(Boolean).pop()?.toLowerCase() : "default";
          ctx.ui.notify(
            `✓ Unlinked ${cwd} from vault "${removed}".\n` + `  This directory will now use vault "${fallback}".`,
            "info",
          );
          break;
        }

        case "status":
        default: {
          const lines = [
            `Directory: ${cwd}`,
            `Vault: ${currentVault}`,
            `Resolution: ${mapping[cwd] ? "explicit (vaults.json)" : isProject ? "auto-detected (project marker)" : "default (non-project dir)"}`,
          ];

          if (isProject) {
            const markers = PROJECT_MARKERS.filter((m) => existsSync(join(cwd, m)));
            if (markers.length > 0) lines.push(`Project markers: ${markers.join(", ")}`);
          }

          const entries = Object.entries(mapping);
          if (entries.length > 0) {
            lines.push(`\nLinked vaults (${entries.length}):`);
            for (const [dir, vault] of entries) {
              lines.push(`  ${vault.padEnd(20)} ${dir}${dir === cwd ? " ← current" : ""}`);
            }
          }

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
      }
    },
  });

  // NOTE: /muninn-dream is now registered by registerDreamCommand() above,
  // which wraps the CLI `muninn dream` instead of the old custom dream.ts script.
  // The old dream.ts remains available as the `muninn-dream` bin in package.json.

  pi.registerCommand("muninn-test", {
    description: "Run smoke tests: /muninn-test (fast, REST) or /muninn-test full (REST + MCP)",
    handler: async (args, ctx) => {
      const vault = resolveVaultName(process.cwd());
      const testBin = fileURLToPath(new URL("./dist/muninn-test.mjs", import.meta.url));
      const mode = args?.trim() === "full" ? "full" : undefined;
      const modeLabel = mode ? "FULL (REST + MCP)" : "FAST (REST only)";

      ctx.ui.notify(`🧪 Running muninn-test ${modeLabel} (vault: "${vault}")`, "info");
      await ctx.waitForIdle();

      const execArgs = [testBin];
      if (mode) execArgs.push(mode);
      execArgs.push("--vault", vault, "--verbose");

      const result = await pi.exec(process.execPath, execArgs, {
        cwd: process.cwd(),
      });

      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      ctx.ui.notify(
        result.code === 0 ? output || "muninn-test completed" : output || `muninn-test exited with code ${result.code}`,
        result.code === 0 ? "info" : "warning",
      );
    },
  });
}
