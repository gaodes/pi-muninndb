import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Register the /muninn-upgrade command.
 *
 * Wraps `muninn upgrade` to check for and install MuninnDB updates
 * from within Pi. Shows current version, available update, and
 * suggests restarting after a successful upgrade.
 */
export function registerUpgradeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("muninn-upgrade", {
    description: "Check for and install MuninnDB updates",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const parts = (args || "").trim().split(/\s+/);
      const checkOnly = parts.includes("--check");
      const skipConfirm = parts.includes("--yes");

      // Get current version
      const versionResult = (await pi.exec("muninn", ["version"], {
        cwd: process.cwd(),
      })) as ExecResult;

      if (versionResult.code !== 0) {
        const err = [versionResult.stdout, versionResult.stderr].filter(Boolean).join("\n").trim();
        ctx.ui.notify(
          err ? `muninn CLI error: ${err}` : "muninn CLI not found. Run /muninn-setup to install MuninnDB.",
          "warning",
        );
        return;
      }

      const currentVersion = [versionResult.stdout, versionResult.stderr].filter(Boolean).join("\n").trim();

      const notes: string[] = [`Current version: ${currentVersion || "unknown"}`];

      if (checkOnly) {
        // Only check — don't install
        notes.push("\nChecking for updates...");

        const checkResult = (await pi.exec("muninn", ["upgrade"], {
          cwd: process.cwd(),
        })) as ExecResult;

        const output = [checkResult.stdout, checkResult.stderr].filter(Boolean).join("\n").trim();

        if (checkResult.code === 0) {
          if (output.toLowerCase().includes("up to date") || output.toLowerCase().includes("latest")) {
            notes.push("✅ Already up to date.");
          } else {
            notes.push(output);
          }
        } else {
          notes.push(`Check result: ${output || `exit code ${checkResult.code}`}`);
        }

        ctx.ui.notify(notes.join("\n"), "info");
        return;
      }

      // Full upgrade flow
      if (!skipConfirm) {
        notes.push(
          "",
          "⚠️ This will upgrade MuninnDB. The server will be restarted.",
          "Run `/muninn-upgrade --check` to check only, or `/muninn-upgrade --yes` to skip this warning.",
        );
        ctx.ui.notify(notes.join("\n"), "info");
        return;
      }

      // Run upgrade
      notes.push("\n⬆️ Running upgrade...");

      const upgradeResult = (await pi.exec("muninn", ["upgrade"], {
        cwd: process.cwd(),
      })) as ExecResult;

      const output = [upgradeResult.stdout, upgradeResult.stderr].filter(Boolean).join("\n").trim();

      if (upgradeResult.code === 0) {
        // Get new version after upgrade
        const newVersionResult = (await pi.exec("muninn", ["version"], {
          cwd: process.cwd(),
        })) as ExecResult;

        const newVersion = [newVersionResult.stdout, newVersionResult.stderr].filter(Boolean).join("\n").trim();

        if (output.toLowerCase().includes("up to date") || output.toLowerCase().includes("latest")) {
          notes.push("✅ Already up to date.");
        } else {
          notes.push(`✅ ${output || "Upgrade complete."}`);
          if (newVersion && newVersion !== currentVersion) {
            notes.push(`Updated: ${currentVersion} → ${newVersion}`);
          }
        }

        notes.push("", "💡 Run `muninn restart` to apply the update.");
        ctx.ui.notify(notes.join("\n"), "info");
      } else {
        notes.push(`❌ Upgrade failed: ${output || `exit code ${upgradeResult.code}`}`);
        ctx.ui.notify(notes.join("\n"), "warning");
      }
    },
  });
}
