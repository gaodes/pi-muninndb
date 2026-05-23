import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName, MUNINN_REST_URL } from "../vault";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface DreamArgs {
  dryRun: boolean;
  force: boolean;
  scope?: string;
}

function parseDreamArgs(rawArgs: string): DreamArgs {
  const parts = (rawArgs || "").trim().split(/\s+/).filter(Boolean);
  const parsed: DreamArgs = {
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < parts.length; i++) {
    const arg = parts[i];

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--scope" && parts[i + 1]) {
      parsed.scope = parts[i + 1];
      i++;
      continue;
    }

    if (arg.startsWith("--scope=")) {
      parsed.scope = arg.slice("--scope=".length);
    }
  }

  return parsed;
}

function formatOutput(result: ExecResult): string {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return combined || `muninn exited with code ${result.code}`;
}

async function isMuninnServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${MUNINN_REST_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function isCliMissingError(resultOrError: ExecResult | unknown): boolean {
  if (resultOrError && typeof resultOrError === "object" && "stderr" in resultOrError) {
    const result = resultOrError as ExecResult;
    const output = [result.stdout, result.stderr].join("\n").toLowerCase();
    return output.includes("command not found") || output.includes("enoent") || output.includes("not found");
  }

  const message =
    resultOrError instanceof Error ? resultOrError.message.toLowerCase() : String(resultOrError).toLowerCase();
  return message.includes("enoent") || message.includes("not found") || message.includes("spawn");
}

export function registerDreamCommand(pi: ExtensionAPI): void {
  pi.registerCommand("muninn-dream", {
    description: "Run muninn dream (dry-run preview + optional execution)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const parsed = parseDreamArgs(args || "");
      const vault = parsed.scope || resolveVaultName(process.cwd());
      const baseArgs = ["dream", "--scope", vault];
      if (parsed.force) baseArgs.push("--force");

      const serverRunning = await isMuninnServerRunning();
      if (serverRunning) {
        ctx.ui.notify(
          "⚠️ MuninnDB server appears to be running. `muninn dream` requires the server to be stopped.",
          "warning",
        );
      }

      await ctx.waitForIdle();
      let dryRunResult: ExecResult;
      try {
        dryRunResult = (await pi.exec("muninn", [...baseArgs, "--dry-run"], {
          cwd: process.cwd(),
        })) as ExecResult;
      } catch (error) {
        if (isCliMissingError(error)) {
          ctx.ui.notify("muninn CLI not found. Run /muninn-setup or install MuninnDB CLI.", "warning");
          return;
        }
        ctx.ui.notify(`Failed to run dry-run: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return;
      }

      if (isCliMissingError(dryRunResult)) {
        ctx.ui.notify("muninn CLI not found. Run /muninn-setup or install MuninnDB CLI.", "warning");
        return;
      }

      const dryRunOutput = formatOutput(dryRunResult);
      ctx.ui.notify(
        [`🧠 muninn dream dry-run (vault: ${vault})`, dryRunOutput].join("\n\n"),
        dryRunResult.code === 0 ? "info" : "warning",
      );

      if (dryRunResult.code !== 0) {
        if (serverRunning) {
          ctx.ui.notify("Dry-run failed while server is running. Stop MuninnDB and try again.", "warning");
        }
        return;
      }

      if (parsed.dryRun) return;

      const proceed = await ctx.ui.confirm(
        "Run muninn dream for real?",
        `Dry-run succeeded for vault "${vault}". Continue with live execution?`,
      );

      if (!proceed) {
        ctx.ui.notify("Cancelled. No memories were written.", "info");
        return;
      }

      await ctx.waitForIdle();
      let runResult: ExecResult;
      try {
        runResult = (await pi.exec("muninn", baseArgs, {
          cwd: process.cwd(),
        })) as ExecResult;
      } catch (error) {
        if (isCliMissingError(error)) {
          ctx.ui.notify("muninn CLI not found. Run /muninn-setup or install MuninnDB CLI.", "warning");
          return;
        }
        ctx.ui.notify(
          `Failed to run muninn dream: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return;
      }

      const finalOutput = formatOutput(runResult);
      if (runResult.code !== 0 && serverRunning) {
        ctx.ui.notify("muninn dream failed and the server is running. Stop MuninnDB, then retry.", "warning");
      }

      ctx.ui.notify(
        [`🧠 muninn dream result (vault: ${vault})`, finalOutput].join("\n\n"),
        runResult.code === 0 ? "info" : "warning",
      );
    },
  });
}
