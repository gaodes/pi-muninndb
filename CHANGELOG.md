# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

| Mode | Tests | Suites | Time |
|------|-------|--------|------|
| Fast (REST only) | 16 | Health, CRUD, Batch, Query | ~120ms |
| Full (REST + MCP) | 49 | + Entity, Graph, Tree, Memory, Enrichment, Restore | ~380ms |

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
