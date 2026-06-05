# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-06-05

### Added

- **Real `prime-settings.json` config engine** — self-contained zero-dependency settings module (`src/settings.ts`) reads the `muninndb` key from `~/.pi/agent/prime-settings.json` (global) with optional project override at `.pi/prime-settings.json`, auto-seeds defaults on first load, and exposes typed getters. Configurable: `sse.enabled`, `sse.threshold`, `sse.newWriteScoreGate`, `prefetchLimit`, `checkpointTools`.
- **Context-aware semantic triggers** — SSE subscription now passes the agent's working context (current prompt, recent memory concepts, vault name) as repeated `context=...` query params. This turns the subscription from a generic vault firehose into a targeted semantic trigger that surfaces only task-relevant memories.
- **Session-evolving subscription context** — `before_agent_start` recomputes subscription context on every turn and re-subscribes when the context set changes, so triggers track the live task instead of going stale.
- **Surface `muninndb_muninn_guide` on first connect** — session-start injection now reminds the agent to call `muninndb_muninn_guide` to learn vault-specific behavior, enrichment state, and behavior mode.
- **Health self-check for hook liveness** — new `src/liveness.ts` tracks whether the SSE subscription, `tool_call` hook, and `context` hook are actually firing. `/muninn-health` reports these timestamps so a silent integration breakage becomes visible.

### Changed

- **Prompt framing adopts the mindset mantra** — session-start injection and the AGENTS.md section written by `/muninn-setup` now lead with "Saving is a mindset, not a checklist — when in doubt, save it." (per upstream `agent-prompting.md` best practice).
- **README documents configuration + new behaviors** — added Configuration section with `muninndb` settings schema, expanded Extension Behaviors table with context-aware triggers, guide surfacing, and health liveness.

## [1.4.5] - 2026-06-05

### Fixed

- **Vault resolution now walks up to the project root** — `resolveVaultName` only inspected the exact launch directory, so Pi sessions started from any sub-directory without a project marker (e.g. `repo/src`, `repo/src/commands`) silently fell back to the `default` vault. Memories from real project work leaked into `default` (363 memories accumulated there, the largest vault). `resolveVaultName` now:
  - Walks up from the launch directory to the nearest ancestor containing a project marker (`findProjectRootByMarkers`), stopping at the home directory or filesystem root.
  - Falls back to `git rev-parse --show-toplevel` (`findGitToplevel`) for git repos missed by the marker walk; handles worktrees and submodules.
  - Preserves the homedir guard so cross-cutting work launched from `~` still resolves to `default` rather than a personal-name vault.
  - Honors `~/.muninn/vaults.json` mappings for both the launch directory and the resolved project root.
- The shared sanitizer is now exported as `sanitizeVaultName` from `src/vault.ts`.

## [1.4.4] - 2026-05-31

### Fixed

- **`muninn-cli` skill — post-review improvements**: description adds "consolidation" paraphrase, MCP-connection trigger, and explicit "Do not use for" boundary; added "Prefer Pi commands" preference rule; added "Destructive operations — backup first" callout with `--yes` confirmation rule; per-workflow `Verify:` lines added to all four patterns; "Reporting results" section added; init/Pi statement reconciled; MCP-not-connecting troubleshooting pattern added; version-pin made actionable

### Changed

- **`skills/` added to `package.json` `files`** — the `skills/muninn-cli/` directory was absent from the npm tarball in v1.4.3; added `"skills/"` to `files` so the skill ships to consumers

## [1.4.3] - 2026-05-31

### Added

- **`muninn-cli` skill** — in-package Pi skill covering the full `muninn` CLI (v0.6.1). Includes server lifecycle, vault management, API key management, `exec` one-shot operations, dream protocol, backup/restore, upgrade, cluster, configuration (`~/.muninn/muninn.env`), port reference, data directory layout, 4 common workflow patterns, and a troubleshooting section. Registered via `resources_discover` event handler so Pi loads it automatically.

## [1.4.2] - 2026-05-31

### Fixed

- **`.primecodex.json` populated** — added `kind`, `source`, `description`, `topic`, `npm`, and `integrationStatus` fields; previously all strings were empty, breaking catalog discoverability
- **`repository.url` corrected** — changed from GitLab SSH to `https://github.com/gaodes/pi-muninndb` so npm's package page links to the public mirror
- **`peerDependenciesMeta` added** — `@earendil-works/pi-coding-agent` and `pi-mcp-adapter` now marked `optional: true` to suppress spurious npm peer dependency warnings
- **Empty `[1.4.0]` changelog entry removed** — that version had no content; `[1.4.1]` immediately followed with the real changes
- **Undocumented Pi event hook casts annotated** — added explanatory comments for `pi.on("context" as any)` and `(pi as any).on("tool_call")` noting version risk
- **`homedir()` usage justified** — added file-level comment in `src/vault.ts` explaining why direct `~/.muninn/` path access is correct for a MuninnDB service integration

## [1.4.1] - 2026-05-29

### Fixed

- **Injected AGENTS.md section rewritten** — The section pi-muninndb writes into `~/.pi/agent/AGENTS.md` during `/muninn-setup` now accurately reflects the current extension behavior:
  - Session start is now described as **automatic** (extension pre-fetches via MCP at startup; no manual `where_left_off` call needed)
  - **Vault auto-injection** documented: the `tool_call` hook injects the resolved vault on every `muninndb_muninn_*` call; users must not pass `vault` manually
  - **Lifecycle checkpoints** documented: extension injects a checkpoint reminder after `git_commit_execute`, `git_push`, and `git_tag`
  - Tool call format corrected: tools are available directly as `muninndb_muninn_*` — no `mcp()` wrapper needed
  - `/muninn-test` note added: pass `--vault default` (or any vault without an API key) for integration tests to pass
  - Dream protocol updated to match `/muninn-dream` CLI wrapper behavior

### Added

- **Auto session-start context injection** — `before_agent_start` now pre-fetches recent memories via a direct MCP HTTP call to `http://127.0.0.1:8750/mcp` using `muninn_where_left_off`. The fetched memories are formatted as numbered context lines and injected automatically, giving the agent session continuity without requiring an explicit `where_left_off` call. Falls back to the previous instruction-only message when MCP is unavailable or the vault is empty.
- **`MUNINN_MCP_URL` constant** exported from `src/vault.ts` (`http://127.0.0.1:8750/mcp`) for direct MCP HTTP calls within the extension.
- **Post-commit checkpoint hint** — the `tool_call` hook now emits a hidden checkpoint reminder after `git_commit_execute`, `git_push`, and `git_tag` calls, prompting the agent to save relevant memories with `muninndb_muninn_remember_batch`. Fires best-effort: active only if Pi's `tool_call` hook covers Pi-native (non-MCP) tools.

## [1.3.0] - 2026-05-29

### Added

- **5 new CLI-wrapped commands** — backup, health, dream, import, and upgrade commands now wrap the `muninn` CLI directly instead of custom reimplementations
  - `/muninn-backup` — export vault archive + offline data backup via `muninn vault export` and `muninn backup`
  - `/muninn-health` — server status, vault stats, service ports via REST API + `muninn status` + `muninn show vaults`
  - `/muninn-dream` — rewritten to wrap `muninn dream` CLI with dry-run preview + confirmation flow
  - `/muninn-import` — import `.muninn` backup archives via `muninn vault import` + `list` subcommand
  - `/muninn-upgrade` — check for and install MuninnDB updates via `muninn version` + `muninn upgrade`
- **Dream Protocol documentation** — new "Dream Protocol" section in README covering offline constraint, command flow, CLI flags, manual alternative, and practical guidance
- **Auto-inject `annotate: true` on recall** — `muninn_recall` calls now always request retrieval annotations (staleness, conflict, trust metadata) so agents get richer context without needing to remember the flag
- **`threshold_crossed` SSE trigger handling** — the SSE subscription now surfaces activation score signals when memories cross the subscription threshold, alongside existing `new_write` and `contradiction_detected` events
- **Post-recall feedback hint** — after each `muninn_recall` call, a subtle hint reminds agents that `muninn_feedback` exists for quality scoring

### Changed

- **Setup now uses official MuninnDB install script** instead of direct binary download + Docker/Podman fallback:
  - macOS/Linux: downloads and runs `https://muninndb.com/install.sh`
  - Windows: downloads and runs `https://muninndb.com/install.ps1`
  - Binary search now includes `~/.local/bin/muninn` (the official install location)
  - Removed container port checks (8575/8850), SHA-256 verification, `BIN_DIR`, `getPlatformBinary`, `hasContainerRuntime`, `verifyChecksum`

### Fixed

- **Health command vault stats** — `/muninn-health` now uses `/api/stats` endpoint (returns per-vault `total_engrams` and `coherence.score`) instead of the non-existent `/api/vaults/<name>/stats` that 404'd on MuninnDB v0.6.0
- **MUNINN_TOOLS allowlist expanded to all 39 tools** — vault auto-injection now works for every MuninnDB MCP tool, not just the original 18. Previously, tools like `muninn_trust`, `muninn_feedback`, `muninn_entity`, `muninn_traverse`, `muninn_remember_tree`, and 16 others were callable but didn't receive automatic vault resolution

## [1.2.0] - 2026-05-23

### Added

- **`/muninn-test` command** — smoke test MuninnDB connectivity from any Pi session
  - Fast mode (`/muninn-test`): 16 REST API tests in ~120ms
  - Full mode (`/muninn-test full`): 49 tests covering all 39 MCP tools via HTTP JSON-RPC in ~380ms
  - Automatic cleanup of all test artifacts (tagged `__pi_test__`)
  - CLI flags: `--vault NAME`, `--verbose`, `--dry-run`
- **`/muninn-dream` command fix** — loads `~/.muninn/muninn.env` before running the dream protocol, matching the server's configured embedder and enricher providers
- **MCP over HTTP test infrastructure** — `src/test.ts` includes a full JSON-RPC client for MuninnDB's MCP endpoint on port 8750, enabling complete tool coverage without subprocess spawning or Python dependencies
- `.primecodex.json` — PrimeCodex resource metadata for catalog integration
- `.upstream.json` — provenance tracking including `muninndb` server repo as inspiration

### Changed

- Forked from `@kuyavinny/pi-muninn-mem` v1.1.0 as `@gaodes/pi-muninndb`
- Renamed package to `@gaodes/pi-muninndb` under PrimeCodex
- Updated repository URLs to GitLab canonical + GitHub mirror
- Updated `src/dream.ts` to load MuninnDB environment before execution
- Build pipeline now produces three binaries: `dist/index.mjs` (extension), `dist/muninn-dream.mjs` (dream CLI), `dist/muninn-test.mjs` (test CLI)

### Test Coverage

| Mode              | Tests | Suites                                             | Time   |
| ----------------- | ----- | -------------------------------------------------- | ------ |
| Fast (REST only)  | 16    | Health, CRUD, Batch, Query                         | ~120ms |
| Full (REST + MCP) | 49    | + Entity, Graph, Tree, Memory, Enrichment, Restore | ~380ms |

MCP test suites (full mode only):

- **MCP Connection** — initialize, status, where_left_off
- **Entity Operations** — entities, entity, find_by_entity, entity_timeline, entity_state, entity_clusters, similar_entities
- **Graph & Link** — remember, link, traverse, explain, export_graph
- **Memory Operations** — read, recall, evolve, consolidate, state, decide
- **Tree Operations** — remember_tree, recall_tree, add_child
- **Enrichment & Provenance** — provenance, get_enrichment_candidates, trust, feedback
- **Delete & Restore** — forget, restore, list_deleted
- **Batch Recall** — remember_batch

## [1.1.0] - 2026-05-23

### Changed

- Forked from `@kuyavinny/pi-muninn-mem` v1.1.0 as `@gaodes/pi-muninndb`
- Renamed package to `@gaodes/pi-muninndb` under PrimeCodex
- Updated repository URLs to GitLab canonical + GitHub mirror
- Added PrimeCodex standards: `.upstream.json`, `.primecodex.json`, `CHANGELOG.md`
