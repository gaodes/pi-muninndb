// Types and utilities for MuninnDB vault management
//
// Vault resolution uses a hybrid strategy:
// 1. Explicit mapping in ~/.muninn/vaults.json (highest priority)
// 2. Project marker detection (.git, package.json, etc.)
// 3. Fallback to "default" for non-project directories
//
// The SSE client connects directly to the MuninnDB REST API on port 8475.
// No port calculation needed — these are fixed by MuninnDB.
//
// NOTE: homedir() is used throughout this file and the commands layer to
// construct paths under ~/.muninn/ — the MuninnDB data directory. This is
// not an arbitrary config path: ~/.muninn/ is the documented install location
// for MuninnDB binaries, env files, and vault data. Pi config APIs are not
// appropriate here because this data belongs to MuninnDB, not to Pi.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";

// ─── Constants ───────────────────────────────────────────────────────

export const DEFAULT_VAULT = "default";
export const MUNINN_REST_URL = "http://127.0.0.1:8475";
export const MUNINN_MCP_URL = "http://127.0.0.1:8750/mcp";
export const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

// ─── Vault mapping ───────────────────────────────────────────────────

export interface VaultMapping {
  [directoryPath: string]: string;
}

/** Read the vault mapping file. Returns empty object if not found. */
export function readVaultMapping(): VaultMapping {
  try {
    const path = join(homedir(), ".muninn", "vaults.json");
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Write the vault mapping file atomically. Creates ~/.muninn/ if needed. */
export function writeVaultMapping(mapping: VaultMapping): void {
  const dir = join(homedir(), ".muninn");
  const path = join(dir, "vaults.json");
  mkdirSync(dir, { recursive: true });
  const tmpFile = join(dir, `.vaults-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpFile, JSON.stringify(mapping, null, 2) + "\n");
  renameSync(tmpFile, path);
}

/** Check if a directory contains project markers. */
export function isProjectDirectory(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/** Sanitize an arbitrary string into a safe vault name, or "" if empty. */
export function sanitizeVaultName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
}

/**
 * Walk up from `startDir` to the nearest ancestor that contains a project
 * marker, stopping at the home directory or filesystem root. Returns the
 * marker directory, or null if none is found before the boundary.
 *
 * This is the fix for sub-directory launches: resolving from
 * `~/repo/pkg/src` now finds `~/repo/pkg` instead of falling to "default".
 */
export function findProjectRootByMarkers(startDir: string): string | null {
  const home = homedir();
  let dir = startDir;
  while (dir && dir !== "/" && dir !== home) {
    if (isProjectDirectory(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the git repository root for `startDir` via
 * `git rev-parse --show-toplevel`. Returns null when not in a git repo, on
 * any error, or when the toplevel resolves to the home directory or root
 * (which would yield a meaningless vault name). Handles worktrees and
 * submodules correctly since git reports the true working-tree root.
 */
export function findGitToplevel(startDir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    if (!out || out === homedir() || out === "/") return null;
    return out;
  } catch {
    return null;
  }
}

// ─── Vault Resolution ───────────────────────────────────────────────

/**
 * Resolves the vault name using a hybrid strategy:
 *
 * 1. Explicit mapping in ~/.muninn/vaults.json (highest priority) — checked
 *    for the launch directory and for the resolved project root.
 * 2. Project marker detection, walking up to the nearest ancestor marker
 *    (.git, package.json, etc.) — fixes sub-directory launches.
 * 3. Git toplevel fallback (`git rev-parse --show-toplevel`) for git repos
 *    whose root is not caught by the marker walk.
 * 4. Fallback to "default" for non-project directories.
 *
 * The home directory and filesystem root always resolve to "default" so
 * cross-cutting work launched from ~ does not leak into a personal-name vault.
 */
export function resolveVaultName(cwd?: string): string {
  const dir = cwd || process.cwd() || "/";

  if (dir === homedir() || dir === "/") return DEFAULT_VAULT;

  const mapping = readVaultMapping();
  if (mapping[dir]) return mapping[dir];

  // 2. Walk up to the nearest project marker (handles src/ and deeper launches).
  const markerRoot = findProjectRootByMarkers(dir);
  if (markerRoot) {
    if (mapping[markerRoot]) return mapping[markerRoot];
    return sanitizeVaultName(basename(markerRoot)) || DEFAULT_VAULT;
  }

  // 3. Git toplevel fallback for git repos missed by the marker walk.
  const gitRoot = findGitToplevel(dir);
  if (gitRoot) {
    if (mapping[gitRoot]) return mapping[gitRoot];
    return sanitizeVaultName(basename(gitRoot)) || DEFAULT_VAULT;
  }

  return DEFAULT_VAULT;
}

// ─── SSE Push Event ─────────────────────────────────────────────────

export interface ActivationPush {
  trigger: "new_write" | "threshold_crossed" | "contradiction_detected";
  engram_id?: string;
  score?: number;
  engram?: { id: string; concept: string; content: string; type: string; score: number };
  why?: string;
}
