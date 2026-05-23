import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName } from "../vault";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function registerImportCommand(pi: ExtensionAPI): void {
  pi.registerCommand("muninn-import", {
    description: "Import a .muninn backup into a vault",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const parts = (args || "").trim().split(/\s+/).filter(Boolean);

      if (parts[0] === "list") {
        const backupDir = join(homedir(), ".muninn", "backups");

        if (!existsSync(backupDir)) {
          ctx.ui.notify(`Backup directory not found: ${backupDir}`, "warning");
          return;
        }

        const files = readdirSync(backupDir)
          .filter((name) => name.endsWith(".muninn"))
          .map((name) => {
            const fullPath = join(backupDir, name);
            const stats = statSync(fullPath);
            return {
              name,
              size: stats.size,
              modified: stats.mtime,
            };
          })
          .sort((a, b) => b.modified.getTime() - a.modified.getTime());

        if (files.length === 0) {
          ctx.ui.notify(`No .muninn backup files found in ${backupDir}`, "info");
          return;
        }

        const lines = ["Available .muninn backups:", `Directory: ${backupDir}`, ""];
        for (const file of files) {
          lines.push(`- ${file.name}`);
          lines.push(`  size: ${formatBytes(file.size)}`);
          lines.push(`  modified: ${file.modified.toISOString()}`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (parts.length === 0) {
        ctx.ui.notify("Usage: /muninn-import <file> [--vault <name>] or /muninn-import list", "warning");
        return;
      }

      const filePath = parts[0];
      let vault = resolveVaultName(process.cwd());

      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "--vault" && parts[i + 1]) {
          vault = parts[++i];
        }
      }

      if (!existsSync(filePath)) {
        ctx.ui.notify(`Import file not found: ${filePath}`, "warning");
        return;
      }

      ctx.ui.notify(
        [
          "Muninn import plan:",
          `- File: ${filePath}`,
          `- Vault: ${vault}`,
          "",
          "Waiting for idle before starting import...",
        ].join("\n"),
        "info",
      );

      await ctx.waitForIdle();

      const result = (await pi.exec("muninn", ["vault", "import", filePath, "--vault", vault], {
        cwd: process.cwd(),
      })) as ExecResult;

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

      if (result.code === 0) {
        ctx.ui.notify(output || `Import completed: ${filePath} -> vault "${vault}"`, "info");
        return;
      }

      const text = output.toLowerCase();
      if (text.includes("vault") && (text.includes("not found") || text.includes("does not exist"))) {
        ctx.ui.notify(`Vault not found: "${vault}"\n${output}`, "warning");
        return;
      }

      ctx.ui.notify(output || `Import failed with exit code ${result.code}`, "warning");
    },
  });
}
