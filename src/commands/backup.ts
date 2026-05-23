import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName } from "../vault";
import { homedir } from "node:os";
import { join } from "node:path";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Register the /muninn-backup command.
 *
 * Wraps `muninn vault export` and `muninn backup` for point-in-time
 * vault snapshots. Exports the current (or specified) vault to a
 * `.muninn` archive and creates an offline backup of the data directory.
 */
export function registerBackupCommand(pi: ExtensionAPI): void {
  pi.registerCommand("muninn-backup", {
    description: "Backup MuninnDB vault (export archive + offline backup)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const parts = (args || "").trim().split(/\s+/);
      let vault: string | undefined;
      let outputDir: string | undefined;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--vault" && parts[i + 1]) {
          vault = parts[++i];
        } else if (parts[i] === "--output" && parts[i + 1]) {
          outputDir = parts[++i];
        }
      }

      const vaultName = vault || resolveVaultName(process.cwd());
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const backupBase = outputDir || join(homedir(), ".muninn", "backups");
      const exportPath = join(backupBase, `${vaultName}-${timestamp}.muninn`);
      const offlineDir = join(backupBase, `offline-${timestamp}`);

      // Check that muninn CLI is available
      const checkResult = (await pi.exec("which", ["muninn"], {
        cwd: process.cwd(),
      })) as ExecResult;

      if (checkResult.code !== 0) {
        ctx.ui.notify("muninn CLI not found. Run /muninn-setup to install MuninnDB.", "warning");
        return;
      }

      const notes: string[] = [];

      // Step 1: Vault export (online, server must be running)
      ctx.ui.notify(`📦 Exporting vault "${vaultName}" to ${exportPath}...`, "info");

      const exportResult = (await pi.exec("muninn", ["vault", "export", "--vault", vaultName, "-o", exportPath], {
        cwd: process.cwd(),
      })) as ExecResult;

      if (exportResult.code === 0) {
        const out = [exportResult.stdout, exportResult.stderr].filter(Boolean).join("\n").trim();
        notes.push(`✅ Vault export: ${out || exportPath}`);
      } else {
        const err = [exportResult.stdout, exportResult.stderr].filter(Boolean).join("\n").trim();
        notes.push(`❌ Vault export failed: ${err || `exit code ${exportResult.code}`}`);
      }

      // Step 2: Offline backup (server should be stopped, but try anyway)
      ctx.ui.notify(`📦 Running offline backup to ${offlineDir}...`, "info");

      const backupResult = (await pi.exec("muninn", ["backup", "--output", offlineDir], {
        cwd: process.cwd(),
      })) as ExecResult;

      if (backupResult.code === 0) {
        const out = [backupResult.stdout, backupResult.stderr].filter(Boolean).join("\n").trim();
        notes.push(`✅ Offline backup: ${out || offlineDir}`);
      } else {
        const err = [backupResult.stdout, backupResult.stderr].filter(Boolean).join("\n").trim();
        // Offline backup requires stopped server — this is expected if server is running
        if (err.toLowerCase().includes("running") || err.toLowerCase().includes("lock")) {
          notes.push(`⚠️ Offline backup skipped: server is running. Stop with 'muninn stop' and retry.`);
        } else {
          notes.push(`❌ Offline backup failed: ${err || `exit code ${backupResult.code}`}`);
        }
      }

      notes.push("", `Backup directory: ${backupBase}`);
      ctx.ui.notify(notes.join("\n"), "info");
    },
  });
}
