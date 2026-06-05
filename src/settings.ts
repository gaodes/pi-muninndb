/**
 * Settings engine for @gaodes/pi-muninndb.
 *
 * Reads the `muninndb` key from `~/.pi/agent/prime-settings.json` (global),
 * with optional project override at `<projectRoot>/.pi/prime-settings.json`
 * (project root resolved via the same marker-walk + git-toplevel strategy
 * as vault resolution, so sub-directory launches honor the project file).
 * Auto-seeds default values into the global file on first load if the key
 * is missing (atomic temp + rename, matching vault.ts writeVaultMapping).
 *
 * Resilient: any read/parse error returns safe defaults — never throws.
 * Bounded: numeric values are validated; thresholds clamped to 0..1,
 * prefetchLimit required as a positive integer with a sane cap.
 *
 * NOTE: homedir() is used to construct ~/.pi/agent/ — the Pi agent root
 * directory. This is the documented location for prime-settings.json.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { findProjectRootByMarkers, findGitToplevel } from "./vault";

// ─── Settings shape ──────────────────────────────────────────────────

export interface MuninnSSESettings {
  /** Master switch for SSE subscription. Default: true */
  enabled: boolean;
  /** Subscription threshold (0.0–1.0). Default: 0.7 */
  threshold: number;
  /** Min score to surface new_write pushes. Default: 0.7 */
  newWriteScoreGate: number;
}

export interface MuninnSettings {
  sse: MuninnSSESettings;
  /** Where_left_off prefetch count. Default: 8 */
  prefetchLimit: number;
  /** Tools that trigger checkpoint hints. */
  checkpointTools: string[];
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: MuninnSettings = {
  sse: {
    enabled: true,
    threshold: 0.7,
    newWriteScoreGate: 0.7,
  },
  prefetchLimit: 8,
  checkpointTools: ["git_commit_execute", "git_push", "git_tag"],
};

const SETTINGS_KEY = "muninndb";
const MAX_PREFETCH_LIMIT = 100;

// ─── File paths ──────────────────────────────────────────────────────

function globalSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "prime-settings.json");
}

function projectSettingsPath(cwd?: string): string {
  const dir = cwd || process.cwd();
  return join(dir, ".pi", "prime-settings.json");
}

/**
 * Resolve the project root for a given cwd using the same logic as
 * `resolveVaultName`: walk up to find a project marker, fall back to
 * `git rev-parse --show-toplevel`, fall back to the cwd itself.
 */
function resolveProjectRoot(cwd?: string): string {
  const dir = cwd || process.cwd() || "/";
  return findProjectRootByMarkers(dir) ?? findGitToplevel(dir) ?? dir;
}

// ─── Validation ──────────────────────────────────────────────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampThreshold(v: unknown, fallback: number): number {
  if (!isFiniteNumber(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function validatePrefetchLimit(v: unknown, fallback: number): number {
  if (!isFiniteNumber(v)) return fallback;
  const i = Math.trunc(v);
  if (i < 1) return fallback;
  return Math.min(i, MAX_PREFETCH_LIMIT);
}

function validateCheckpointTools(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v) || v.length === 0) return fallback;
  if (!v.every((t) => typeof t === "string" && t.length > 0)) return fallback;
  return v as string[];
}

// ─── Read + merge ────────────────────────────────────────────────────

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Deep-merge a partial object into a full defaults object.
 * Only handles plain objects and primitives (no arrays — arrays replace wholesale).
 * Validates and bounds-checks each numeric value.
 */
function mergeWithDefaults(defaults: MuninnSettings, partial: Record<string, unknown>): MuninnSettings {
  const result: MuninnSettings = JSON.parse(JSON.stringify(defaults));

  if (typeof partial.sse === "object" && partial.sse !== null) {
    const sse = partial.sse as Record<string, unknown>;
    if (typeof sse.enabled === "boolean") result.sse.enabled = sse.enabled;
    if (isFiniteNumber(sse.threshold)) result.sse.threshold = clampThreshold(sse.threshold, defaults.sse.threshold);
    if (isFiniteNumber(sse.newWriteScoreGate)) {
      result.sse.newWriteScoreGate = clampThreshold(sse.newWriteScoreGate, defaults.sse.newWriteScoreGate);
    }
  }

  if (isFiniteNumber(partial.prefetchLimit)) {
    result.prefetchLimit = validatePrefetchLimit(partial.prefetchLimit, defaults.prefetchLimit);
  }

  if (Array.isArray(partial.checkpointTools)) {
    result.checkpointTools = validateCheckpointTools(partial.checkpointTools, defaults.checkpointTools);
  }

  return result;
}

// ─── Auto-seed ───────────────────────────────────────────────────────

/**
 * Auto-seed the `muninndb` key into the global prime-settings.json
 * if it's missing. Uses atomic temp + rename to avoid corruption.
 */
function autoSeedDefaults(): void {
  const path = globalSettingsPath();
  let existing: Record<string, unknown> = {};

  try {
    if (existsSync(path)) {
      existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    // Corrupted or unreadable — don't auto-seed to avoid data loss
    return;
  }

  // Already has our key — nothing to do
  if (SETTINGS_KEY in existing) return;

  // Merge our defaults in and write
  existing[SETTINGS_KEY] = DEFAULT_SETTINGS;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmpFile = join(dir, `.prime-settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(tmpFile, JSON.stringify(existing, null, 2) + "\n");
    renameSync(tmpFile, path);
  } catch {
    // Best-effort — don't block startup on write failure
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile);
      }
    } catch {
      /* ignore cleanup failure */
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────

// Cache keyed by resolved project root so a process that loads from
// multiple cwds (rare but possible) gets correct results for each.
const settingsCache = new Map<string, MuninnSettings>();

/**
 * Load and return the merged settings.
 *
 * Resolution order:
 * 1. Resolve project root from cwd (marker walk → git toplevel → cwd).
 * 2. Global: ~/.pi/agent/prime-settings.json → `muninndb` key
 * 3. Project: <projectRoot>/.pi/prime-settings.json → `muninndb` key (overrides global)
 *
 * Auto-seeds defaults into the global file on first call if the key is missing.
 * Cached per resolved project root for the session.
 */
export function loadSettings(cwd?: string): MuninnSettings {
  // Auto-seed once (idempotent — early-returns if key already present)
  try {
    autoSeedDefaults();
  } catch {
    /* best effort */
  }

  const projectRoot = resolveProjectRoot(cwd);
  const cached = settingsCache.get(projectRoot);
  if (cached) return cached;

  // Start with defaults
  let settings = DEFAULT_SETTINGS;

  // Layer global settings
  const globalFile = readJsonFile(globalSettingsPath());
  if (globalFile && typeof globalFile[SETTINGS_KEY] === "object" && globalFile[SETTINGS_KEY] !== null) {
    settings = mergeWithDefaults(settings, globalFile[SETTINGS_KEY] as Record<string, unknown>);
  }

  // Layer project settings (project wins on conflict)
  const projectFile = readJsonFile(projectSettingsPath(projectRoot));
  if (projectFile && typeof projectFile[SETTINGS_KEY] === "object" && projectFile[SETTINGS_KEY] !== null) {
    settings = mergeWithDefaults(settings, projectFile[SETTINGS_KEY] as Record<string, unknown>);
  }

  settingsCache.set(projectRoot, settings);
  return settings;
}

/**
 * Clear the settings cache. Useful for testing or after settings file changes.
 */
export function clearSettingsCache(): void {
  settingsCache.clear();
}
