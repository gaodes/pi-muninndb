# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
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
