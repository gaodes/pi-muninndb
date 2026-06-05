/**
 * Interactive setup for MuninnDB + Pi extension.
 *
 * Handles: MuninnDB installation via official install script,
 * auto-start, Ollama detection, MCP configuration,
 * AGENTS.md setup, vault creation, health verification.
 *
 * Security design:
 * - All command execution uses argument arrays (no shell interpolation)
 * - MCP config URLs validated as localhost-only
 * - Atomic file writes for configuration (temp file + rename)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  rmSync,
  renameSync,
  accessSync,
  constants,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// Pi extension context (subset of ExtensionCommandContext)
interface NotifyFn {
  (message: string, type?: "info" | "warning" | "error"): void;
}
interface ExtensionContext {
  ui: { notify: NotifyFn };
}

// ─── Paths ────────────────────────────────────────────────────────
const HOME = homedir();
const MCP_CONFIG_PATH = join(HOME, ".config/mcp/mcp.json");
const AGENTS_MD_PATH = join(HOME, ".pi/agent/AGENTS.md");
const SETTINGS_PATH = join(HOME, ".pi/agent/settings.json");
// ─── Allowed localhost hostnames for MCP URLs ─────────────────────
const LOCALHOST_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
const ALLOWED_PORTS = new Set([8474, 8475, 8476, 8477, 8750]);

// ─── AGENTS.md Content (additive section) ────────────────────────
const AGENTS_MD_SECTION = `# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively — never rely on local or session-only memory.

## Session Start — Automatic

The pi-muninndb extension **automatically pre-fetches recent memories at session start** and injects them as context before your first turn. You do not need to call \`muninndb_muninn_where_left_off\` manually on every session — the extension handles it.

On first connect, also call \`muninndb_muninn_guide\` to learn vault-specific behavior (enrichment state, behavior mode, and any vault-level notes).

If you need to search by topic, use \`muninndb_muninn_recall\` with relevant context phrases.

## Vault: Automatic Resolution

The vault is resolved automatically from the working directory:

- Project directory (.git, package.json, etc.) → vault named after the directory basename
- Non-project directory → \`default\` vault
- Explicit mapping → \`/muninn-vault create [name]\`

**Do not pass a \`vault\` parameter.** The \`tool_call\` hook auto-injects the resolved vault on every \`muninndb_muninn_*\` call. Run \`/muninn-vault status\` to inspect the current vault and resolution method.

## Save Protocol

**Saving is a mindset, not a checklist — when in doubt, save it.**
Anything the user shares or that emerges from the work should be saved immediately.
Do not evaluate whether it is "important enough". The practical flow:

1. **ASSESS** — Before saving, review the exchange and identify all memories worth saving.
2. **CHOOSE** — Based on count:
   - 1 memory → \`muninndb_muninn_remember\`
   - 2+ memories → \`muninndb_muninn_remember_batch\`
3. **SAVE** — Execute once. Never make two consecutive \`muninndb_muninn_remember\` calls.

If you catch yourself about to make a second \`muninndb_muninn_remember\` call, stop and use \`muninndb_muninn_remember_batch\` instead.

### What to Save

- **Decisions**: "We chose X because Y" → type=decision
- **Preferences**: "I prefer tabs over spaces" → type=preference
- **Issues**: "Service X fails on port 8080" → type=issue
- **Procedures**: "To deploy, run these steps..." → type=procedure
- **Facts**: "The API returns 429 on rate limits" → type=fact
- **Release events**: published packages, migrations, audits → type=event

### What NOT to Save

- Greetings, acknowledgments, "let me check", "I'll do that"
- Raw tool output (bash, read, edit, write)
- Meta-discussion about the conversation itself
- Information you are not confident about

## Lifecycle Checkpoints

After significant events, save memories immediately — do not wait until end of session:

- After a **git commit** → save commit intent and what changed
- After an **npm publish** → save the release event with version and what shipped
- After a **significant decision** → save the decision, rationale, and alternatives
- After **resolving a blocker** → save the issue closed and how it was fixed

The extension injects a checkpoint reminder after \`git_commit_execute\`, \`git_push\`, and \`git_tag\` calls.

## Tools Available

39 MuninnDB tools are available directly as \`muninndb_muninn_*\` — no \`mcp()\` wrapper needed.

| Tool | Purpose |
|------|---------|
| \`muninndb_muninn_where_left_off\` | Fetch most recently accessed memories |
| \`muninndb_muninn_recall\` | Semantic search for relevant memories |
| \`muninndb_muninn_remember\` | Store a single fact, decision, preference, or issue |
| \`muninndb_muninn_remember_batch\` | Store multiple memories at once (preferred for 2+) |
| \`muninndb_muninn_decide\` | Record a decision with rationale and evidence |
| \`muninndb_muninn_evolve\` | Update a memory with new information |
| \`muninndb_muninn_consolidate\` | Merge related memories |
| \`muninndb_muninn_contradictions\` | Check for known contradictions |
| \`muninndb_muninn_guide\` | Get vault-specific usage instructions |

## Contradiction Detection

When you see a \`[⚠️ Contradiction detected]\` message, use \`muninndb_muninn_evolve\` to update the older memory, or \`muninndb_muninn_consolidate\` to merge them.

## Dream Protocol

Run \`/muninn-dream\` before ending a long session to consolidate memories offline via the MuninnDB CLI:

1. Finds and resolves contradictions
2. Consolidates overlapping memories
3. Enriches memories missing summaries or entities
4. Reviews and evolves outdated facts

## Testing and Health

- \`/muninn-health\` — Server status, vault stats, service ports
- \`/muninn-test\` — Fast REST smoke tests (use \`/muninn-test full\` for REST + all 39 MCP tools)
  - **Note**: pass \`--vault default\` (or any vault without an API key) for the tests to pass
- \`/muninn-backup\` — Export vault archive
- \`/muninn-upgrade\` — Check for and install MuninnDB updates

`;

// ─── Setup Function ────────────────────────────────────────────────
export async function setupMuninnDB(ctx: ExtensionContext): Promise<void> {
  const log = (msg: string) => ctx.ui.notify(msg, "info");
  const warn = (msg: string) => ctx.ui.notify(msg, "warning");
  const error = (msg: string) => ctx.ui.notify(msg, "error");

  log("╔═══ MuninnDB Setup ═══╗\n");

  // ─── Step 0: Check dependencies ─────────────────────────────────
  if (!(await checkMcpAdapter())) {
    error("pi-mcp-adapter is not installed.");
    log("  MuninnDB tools are exposed via MCP. Without pi-mcp-adapter, Pi cannot see them.");
    log("  Install it with:");
    log("    pi install npm:pi-mcp-adapter");
    log("");
    log("  Then re-run: /muninn-setup\n");
    return;
  } else {
    log("  ✓ pi-mcp-adapter is installed");
  }

  // ─── Step 1: Ensure MuninnDB is running ───────────────────────────
  log("\nStep 1: Checking MuninnDB...");

  let restPort = 8475;
  let mcpPort = 8750;
  let muninnRunning = false;

  // Check CLI instance (default ports)
  if (await checkHealth(8475)) {
    muninnRunning = true;
    log("  ✓ MuninnDB running (ports 8475/8750)");
  }

  if (!muninnRunning) {
    // Try to start existing binary
    const existingBin = findMuninnBinary();
    if (existingBin) {
      log("  MuninnDB found but not running. Starting...");
      try {
        execFileSync(existingBin, ["start"], { timeout: 15000, stdio: "pipe" });
      } catch {
        /* some versions print to stderr */
      }
      for (let i = 0; i < 15; i++) {
        if (await checkHealth(8475)) {
          muninnRunning = true;
          log("  ✓ MuninnDB started (ports 8475/8750)");
          break;
        }
        await sleep(1000);
      }
    }

    // Binary not found or didn't start — install it
    if (!muninnRunning) {
      muninnRunning = await installMuninnDB(log, warn, error);
      if (!muninnRunning) {
        error("Could not install or start MuninnDB.");
        log("  Please install manually: https://github.com/scrypster/muninndb");
        log("  Then re-run: /muninn-setup\n");
        return;
      }
      restPort = 8475;
      mcpPort = 8750;
    }
  }

  // ─── Step 2: Embedding info ────────────────────────────────────────
  log("\nStep 2: Embedding configuration...");
  log("  Default: Bundled ONNX embedder (all-MiniLM-L6-v2, 384-dim)");
  log("           Works without any external service. No API key needed.");

  const ollamaRunning = await checkOllama();
  if (ollamaRunning) {
    log("  ✓ Ollama detected — optional upgrades available:");
    log("    Embedding:  ollama pull nomic-embed-text      (768-dim, better quality)");
    log("    Embedding:  ollama pull qwen3-embedding:0.6b   (fast, good quality)");
    log("    Enrichment: ollama pull llama3.2:1b            (summaries, contradictions)");
    log("  To enable, edit ~/.muninn/muninn.env:");
    log("    MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text");
    log("    MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b");
  } else {
    log("  ℹ Ollama not found. Bundled embedder works offline.");
    log("  For better quality, install Ollama: https://ollama.com");
  }

  // ─── Step 3: Vault configuration ─────────────────────────────────
  log("\nStep 3: Vault configuration...");
  log("  Vaults are created automatically on first write.");
  log("  Use /muninn-vault create [name] to link a project directory to a vault.");
  log("  Use /muninn-vault status to see the current vault mapping.");
  log("  Default vault: 'default' (used when not in a project directory).");

  // ─── Step 4: Configure MCP ──────────────────────────────────────────
  log("\nStep 4: Configuring MCP...");
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await writeMcpConfig(mcpUrl);
  log(`  ✓ MCP configured: ${mcpUrl}`);

  // ─── Step 5: Configure AGENTS.md (non-destructive) ────────────────
  log("\nStep 5: Configuring AGENTS.md...");
  await writeAgentsMd();
  log("  ✓ AGENTS.md configured");

  // ─── Step 6: Verify ────────────────────────────────────────────────
  log("\n╔═══ Setup Summary ═══╗");

  if (await checkHealth(restPort)) {
    log(`  ✓ MuninnDB: REST :${restPort}, MCP :${mcpPort}`);
  } else {
    error(`  ✗ MuninnDB: not responding on :${restPort}`);
  }
  log(`  ✓ MCP config: ${MCP_CONFIG_PATH}`);
  log(`  ✓ AGENTS.md: ${AGENTS_MD_PATH}`);
  log(`  ✓ Embedding: ${ollamaRunning ? "Ollama available (optional)" : "Bundled ONNX (default)"}`);

  log("\nNext steps:");
  log("  1. Restart Pi to load the extension and MCP config");
  log("  2. First turn: call muninndb_muninn_where_left_off (via mcp)\n");
}

// ─── Install MuninnDB ────────────────────────────────────────────
async function installMuninnDB(
  log: (msg: string) => void,
  warn: (msg: string) => void,
  error: (msg: string) => void,
): Promise<boolean> {
  log("  MuninnDB not found. Installing...");

  const p = platform();

  // Strategy: Official install script
  if (p === "darwin" || p === "linux") {
    log("  Installing MuninnDB via official script (https://muninndb.com/install.sh)...");
    try {
      const tmpDir = mkdtempSync(join(tmpdir(), "muninn-setup-"));
      const scriptPath = join(tmpDir, "install.sh");

      // Download script
      const response = await fetch("https://muninndb.com/install.sh");
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const script = Buffer.from(await response.arrayBuffer());
      writeFileSync(scriptPath, script);
      chmodSync(scriptPath, 0o755);

      // Run installer
      execFileSync("sh", [scriptPath], { stdio: "pipe", timeout: 120_000 });
      rmSync(tmpDir, { recursive: true });

      log("  ✓ Install script completed");
    } catch (e: any) {
      const msg = (e?.message || "unknown").substring(0, 200);
      error(`  Install script failed: ${msg}`);
      log("\n  Manual install options:");
      log("    macOS/Linux: curl -sSL https://muninndb.com/install.sh | sh");
      log("    Windows:     irm https://muninndb.com/install.ps1 | iex");
      log("    Then run:    muninn start\n");
      return false;
    }
  } else if (p === "win32") {
    log("  Installing MuninnDB via official PowerShell script...");
    try {
      const tmpDir = mkdtempSync(join(tmpdir(), "muninn-setup-"));
      const scriptPath = join(tmpDir, "install.ps1");

      const response = await fetch("https://muninndb.com/install.ps1");
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const script = Buffer.from(await response.arrayBuffer());
      writeFileSync(scriptPath, script);

      execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        stdio: "pipe",
        timeout: 120_000,
      });
      rmSync(tmpDir, { recursive: true });

      log("  ✓ Install script completed");
    } catch (e: any) {
      const msg = (e?.message || "unknown").substring(0, 200);
      error(`  Install script failed: ${msg}`);
      log("\n  Manual install options:");
      log("    macOS/Linux: curl -sSL https://muninndb.com/install.sh | sh");
      log("    Windows:     irm https://muninndb.com/install.ps1 | iex");
      log("    Then run:    muninn start\n");
      return false;
    }
  } else {
    error(`  Unsupported platform: ${p}-${arch()}`);
    log("\n  Manual install options:");
    log("    macOS/Linux: curl -sSL https://muninndb.com/install.sh | sh");
    log("    Windows:     irm https://muninndb.com/install.ps1 | iex");
    log("    Then run:    muninn start\n");
    return false;
  }

  // Find newly installed binary and start it
  const muninnBin = findMuninnBinary();
  if (!muninnBin) {
    error("  MuninnDB installed but binary not found in PATH.");
    log("  The install script usually places it in ~/.local/bin/muninn");
    log("  Ensure ~/.local/bin is in your PATH, then re-run /muninn-setup.");
    return false;
  }

  log("  Starting MuninnDB...");
  try {
    execFileSync(muninnBin, ["start"], { stdio: "pipe", timeout: 15000 });
  } catch {
    /* some versions print to stderr */
  }

  // Wait for health
  for (let i = 0; i < 20; i++) {
    if (await checkHealth(8475)) {
      log("  ✓ MuninnDB started (ports 8475/8750)");
      return true;
    }
    await sleep(1000);
  }

  warn("  MuninnDB installed but not responding on :8475");
  warn("  It may need a moment to initialize. Try /muninn-setup again in a few seconds.");
  return false;
}

// ─── Uninstall ────────────────────────────────────────────────────
export async function uninstallMuninnDB(ctx: ExtensionContext): Promise<void> {
  const log = (msg: string) => ctx.ui.notify(msg, "info");

  log("╔═══ MuninnDB Uninstall ═══╗\n");

  // Stop MuninnDB if running
  const muninnBin = findMuninnBinary();
  if (muninnBin) {
    try {
      execFileSync(muninnBin, ["stop"], { timeout: 10000, stdio: "pipe" });
      log("  ✓ MuninnDB stopped");
    } catch {
      /* not running */
    }
  }

  // Remove extension from settings.json
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      const original = pkgs.length;
      data.packages = pkgs.filter((p: string) => !p.includes("muninn-mem"));
      if (data.packages.length < original) {
        atomicWriteFile(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
        log("  ✓ Removed from Pi settings");
      }
    }
  } catch {
    /* ignore */
  }

  // Remove muninndb from MCP config
  try {
    if (existsSync(MCP_CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
      if (data.mcpServers?.muninndb) {
        delete data.mcpServers.muninndb;
        atomicWriteFile(MCP_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n");
        log("  ✓ Removed muninndb from MCP config");
      }
    }
  } catch {
    /* ignore */
  }

  // Remove MuninnDB section from AGENTS.md
  try {
    if (existsSync(AGENTS_MD_PATH)) {
      const content = readFileSync(AGENTS_MD_PATH, "utf-8");
      const result = removeMuninnSection(content);
      if (result.trim() !== content.trim()) {
        atomicWriteFile(AGENTS_MD_PATH, result.trim() + "\n");
        log("  ✓ Removed MuninnDB section from AGENTS.md");
      }
    }
  } catch {
    /* ignore */
  }

  log("\nRestart Pi to apply changes.");
  log("To remove MuninnDB data:  rm -rf ~/.muninn");
  log("To remove MuninnDB binary: rm $(which muninn)\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Atomic file write: write to temp file, then rename (avoids corruption). */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const tmpFile = join(dir, `.muninn-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpFile, content);
  renameSync(tmpFile, filePath);
}

/** Validate that an MCP URL points to localhost with a known port. */
export function validateMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!LOCALHOST_HOSTS.includes(parsed.hostname)) return false;
    const port = parseInt(parsed.port);
    if (!ALLOWED_PORTS.has(port)) return false;
    return true;
  } catch {
    return false;
  }
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    return res.ok;
  } catch {
    return false;
  }
}

async function checkMcpAdapter(): Promise<boolean> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const pkgs: string[] = data.packages || [];
      return pkgs.some((p) => p.includes("pi-mcp-adapter"));
    }
  } catch {
    /* fall through */
  }
  return false;
}

function findMuninnBinary(): string | null {
  const { PATH = "" } = process.env;
  const candidates = [
    ...PATH.split(":").map((d) => join(d, "muninn")),
    join(homedir(), ".local/bin/muninn"),
    join(homedir(), "bin/muninn"),
    "/usr/local/bin/muninn",
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeMcpConfig(mcpUrl: string): Promise<void> {
  if (!validateMcpUrl(mcpUrl)) {
    throw new Error(`Invalid MCP URL: ${mcpUrl} — must be localhost with a known port`);
  }

  let config: any = { mcpServers: {} };
  if (existsSync(MCP_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
    } catch {
      /* use empty config */
    }
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.muninndb = {
    url: mcpUrl,
    lifecycle: "keep-alive",
    directTools: true,
  };

  atomicWriteFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

async function writeAgentsMd(): Promise<void> {
  if (!existsSync(AGENTS_MD_PATH)) {
    atomicWriteFile(AGENTS_MD_PATH, AGENTS_MD_SECTION + "\n");
    return;
  }

  const content = readFileSync(AGENTS_MD_PATH, "utf-8");
  if (content.includes("# Memory: MuninnDB")) {
    const updated = removeMuninnSection(content);
    atomicWriteFile(AGENTS_MD_PATH, updated.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  } else {
    atomicWriteFile(AGENTS_MD_PATH, content.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  }
}

export function removeMuninnSection(content: string): string {
  const marker = "# Memory: MuninnDB";
  const start = content.indexOf(marker);
  if (start === -1) return content;

  const afterStart = content.indexOf("\n# ", start + marker.length);
  if (afterStart === -1) {
    return content.substring(0, start).trimEnd();
  }

  return (content.substring(0, start) + content.substring(afterStart)).replace(/\n{3,}/g, "\n\n").trimEnd();
}
