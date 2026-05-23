# @gaodes/pi-muninndb

Persistent memory for [Pi](https://pi.dev) via [MuninnDB](https://github.com/scrypster/muninndb).

Gives Pi semantic memory across sessions — decisions, preferences, facts, procedures — that survives restarts. Uses an MCP-first architecture: all 39 MuninnDB tools are exposed through `pi-mcp-adapter`, and the extension provides only what MCP cannot (SSE push, context injection, setup automation).

> **Fork of** [`@kuyavinny/pi-muninn-mem`](https://www.npmjs.com/package/@kuyavinny/pi-muninn-mem) v1.1.0 — published under PrimeCodex as `@gaodes/pi-muninndb`.

## Install

```bash
pi install npm:pi-mcp-adapter        # required dependency
pi install npm:@gaodes/pi-muninndb
```

Then reload Pi and run:

```
/muninn-setup
```

This single command handles everything:

1. Checks that `pi-mcp-adapter` is installed
2. Downloads and installs MuninnDB binary (with SHA-256 verification) if not found
3. Starts MuninnDB
4. Writes MCP config to `~/.config/mcp/mcp.json`
5. Adds MuninnDB instructions to `~/.pi/agent/AGENTS.md` (non-destructive)
6. Verifies the setup

If MuninnDB isn't running when Pi starts, you'll see:

```
⚠️ MuninnDB is not running. Run /muninn-setup to install and configure it.
```

## Commands

| Command                       | Description                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| `/muninn-setup`               | Install MuninnDB, configure MCP + AGENTS.md                    |
| `/muninn-remove`              | Unregister extension, remove MCP config, clean AGENTS.md       |
| `/muninn-vault status`        | Show current vault and mapping                                 |
| `/muninn-vault create [name]` | Link current directory to a named vault                        |
| `/muninn-vault unlink`        | Remove vault mapping for current directory                     |
| `/muninn-dream`               | Run dream protocol: consolidate, evolve, enrich memories       |
| `/muninn-test`                | Fast smoke test — 16 REST API tests in ~120ms                  |
| `/muninn-test full`           | Full smoke test — 49 tests covering all 39 MCP tools in ~380ms |

## How It Works

### Extension Hooks

| Hook                 | What it does                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `session_start`      | Health-check MuninnDB, start SSE subscription, notify user                                            |
| `before_agent_start` | On first turn: tell LLM to call `muninndb_muninn_where_left_off`                                      |
| `context`            | Push contradiction alerts, memory updates, and activation signals via SSE                             |
| `session_shutdown`   | Clean up SSE connection                                                                               |
| `tool_call`          | Auto-inject `vault` parameter, `annotate: true` on recall, batch nudge, and feedback hint on recall   |

### MCP Tools (via MuninnDB on port 8750)

The LLM calls these directly through the `mcp` gateway. All 39 tools are available:

| Tool                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `muninndb_muninn_where_left_off` | Restore context from last session — **call this first** |
| `muninndb_muninn_remember`       | Store a fact, decision, preference, or observation      |
| `muninndb_muninn_recall`         | Semantic search for relevant memories                   |
| `muninndb_muninn_read`           | Read a single memory by ID                              |
| `muninndb_muninn_forget`         | Soft-delete a memory                                    |
| `muninndb_muninn_restore`        | Recover a soft-deleted memory                           |
| `muninndb_muninn_evolve`         | Update a memory with new information                    |
| `muninndb_muninn_consolidate`    | Merge related memories                                  |
| `muninndb_muninn_decide`         | Record a decision with rationale and evidence           |
| `muninndb_muninn_remember_batch` | Store multiple memories at once (max 50)                |
| `muninndb_muninn_state`          | Set lifecycle state (active, completed, paused, etc.)   |
| `muninndb_muninn_link`           | Create association between two memories                 |
| `muninndb_muninn_traverse`       | Explore the memory graph by following associations      |
| `muninndb_muninn_explain`        | Show why a memory was returned for a query              |
| `muninndb_muninn_entities`       | List all known entities in the vault                    |
| `muninndb_muninn_entity`         | Full detail for a named entity                          |
| `muninndb_muninn_remember_tree`  | Store a nested hierarchy (project plan, task tree)      |
| `muninndb_muninn_recall_tree`    | Retrieve a complete hierarchy                           |
| `muninndb_muninn_export_graph`   | Export entity graph as JSON-LD or GraphML               |
| `muninndb_muninn_contradictions` | Check for known contradictions                          |
| `muninndb_muninn_guide`          | Get vault-specific usage instructions                   |

Plus 18 more — call `muninndb_muninn_guide` for the full list.

### Architecture

```
┌──────────────────────────────────────────────┐
│              Pi Extension                    │
│                                              │
│  session_start  → Health check, start SSE   │
│  before_agent_start (1st turn) → Inject     │
│  context        → Push contradictions       │
│  session_shutdown → Clean up SSE            │
│  tool_call      → Vault, annotate, nudge      │
│  /muninn-setup  → Install + configure        │
│  /muninn-remove → Uninstall                  │
│  /muninn-test   → Smoke test (REST + MCP)    │
│  /muninn-dream  → Dream protocol             │
│  /muninn-vault  → Vault management            │
└──────────────┬───────────────────┬───────────┘
               │                   │
          SSE subscription     MCP tools
          (REST :8475)      (:8750/mcp)
               │                   │
               └───────┬───────────┘
                       ▼
                    MuninnDB
```

### Extension Behaviors

The extension adds several automatic behaviors on top of the MCP tools:

| Behavior | Description |
| -------- | ----------- |
| **Vault auto-injection** | All 39 `muninndb_muninn_*` tool calls receive the resolved vault name automatically. No need to pass `vault` manually. |
| **Recall annotations** | `muninn_recall` calls automatically get `annotate: true`, so results include staleness, conflict, and trust metadata. |
| **Feedback hint** | After each `muninn_recall`, a subtle context hint reminds the agent that `muninn_feedback` exists for quality scoring. |
| **Batch nudge** | After 2+ individual `muninn_remember` calls in one turn, the extension nudges toward `muninn_remember_batch`. |
| **SSE: contradictions** | When a new memory conflicts with an existing one, the agent receives a `[⚠️ Contradiction detected]` context push. |
| **SSE: threshold crossed** | When a memory's activation score crosses the subscription threshold, the agent receives an `[📈 Activation signal]` context push. |
| **SSE: new writes** | High-scoring new memories (≥0.7) are pushed to the agent's context in real time. |

All LLM operations go through MCP. The extension only provides SSE subscription (which MCP cannot do), context injection, setup automation, and diagnostics.

## Smoke Testing

### Fast Mode (REST only)

```
/muninn-test
```

Runs 16 REST API tests against `http://127.0.0.1:8475` in ~120ms:

| Suite               | Tests                                                |
| ------------------- | ---------------------------------------------------- |
| Health & Connection | health, vaults, guide                                |
| CRUD                | create, read, recall, forget, list-deleted, recreate |
| Batch & Advanced    | batch write, evolve, lifecycle state, decide         |
| Query               | filter by tag, contradictions, session activity      |

### Full Mode (REST + MCP)

```
/muninn-test full
```

Runs 49 tests covering all 39 MCP tools via HTTP JSON-RPC on port 8750 in ~380ms:

| Suite                   | Tests | Tools covered                                                        |
| ----------------------- | ----- | -------------------------------------------------------------------- |
| MCP Connection          | 3     | initialize, status, where_left_off                                   |
| Entity Operations       | 7     | entities, entity, find_by_entity, timeline, state, clusters, similar |
| Graph & Link            | 6     | remember, link, traverse, explain, export_graph                      |
| Memory Operations       | 7     | read, recall, evolve, consolidate, state, decide                     |
| Tree Operations         | 3     | remember_tree, recall_tree, add_child                                |
| Enrichment & Provenance | 4     | provenance, enrichment candidates, trust, feedback                   |
| Delete & Restore        | 2     | forget + restore, list_deleted                                       |
| Batch                   | 1     | remember_batch                                                       |

All test artifacts are tagged `__pi_test__` and cleaned up automatically.

## Development

| Script            | Command                                                    |
| ----------------- | ---------------------------------------------------------- |
| Build (all)       | `npm run build`                                            |
| Build extension   | `npm run build:extension`                                  |
| Build dream CLI   | `npm run build:dream`                                      |
| Build test CLI    | `npm run build:test`                                       |
| Type check        | `npm run check`                                            |
| Lint              | `npm run lint`                                             |
| Fix lint          | `npm run lint:fix`                                         |
| Format            | `npm run format`                                           |
| Check format      | `npm run format:check`                                     |
| Test (unit)       | `npm test`                                                 |
| Smoke test (fast) | `node dist/muninn-test.mjs --vault default`                |
| Smoke test (full) | `node dist/muninn-test.mjs full --vault default --verbose` |

## Embedding Configuration

MuninnDB ships with a **bundled ONNX embedder** (all-MiniLM-L6-v2, 384-dim) that works offline with zero configuration. This is the default.

For better embeddings, edit `~/.muninn/muninn.env` and restart MuninnDB:

| Provider                 | Config                                                        | Quality                |
| ------------------------ | ------------------------------------------------------------- | ---------------------- |
| **Ollama** (recommended) | `MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text` | 768-dim, free, local   |
| LM Studio                | `MUNINN_OPENAI_URL=http://localhost:1234/v1`                  | Any model              |
| OpenAI                   | `MUNINN_OPENAI_KEY=sk-...`                                    | text-embedding-3-small |
| Voyage AI                | `MUNINN_VOYAGE_KEY=pa-...`                                    | voyage-3               |

For **enrichment** (summaries, entities, contradiction detection):

```bash
MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b
MUNINN_ENRICH_TIMEOUT=120s
```

Models are never auto-pulled — you must install them explicitly.

## Security

- Downloaded binaries are verified with SHA-256 checksums before execution
- Docker/Podman ports bound to `127.0.0.1` only (no network exposure)
- Docker image pinned to `v0.5.1` (no `:latest`)
- MuninnDB initialized with a generated authentication token
- MCP config URLs validated as localhost-only with known ports
- File writes are atomic (temp + rename)
- All command execution uses argument arrays (no shell interpolation)
- SSE reconnection uses exponential backoff (5s → 5min cap)
- Tool calls validated against an allowlist of known MuninnDB tools
- Vault names sanitized and length-limited (64 chars)

## Uninstall

```
/muninn-remove
```

This removes the MCP config, AGENTS.md section, and Pi extension registration. MuninnDB data (`~/.muninn/`) is preserved — delete it manually if desired.

## Configuration Files

| File                              | Purpose                                         |
| --------------------------------- | ----------------------------------------------- |
| `~/.config/mcp/mcp.json`          | MCP server URL for MuninnDB                     |
| `~/.pi/agent/AGENTS.md`           | LLM instructions for MuninnDB (non-destructive) |
| `~/.pi/agent/prime-settings.json` | Extension configuration                         |
| `~/.muninn/muninn.env`            | MuninnDB embedder/enricher settings             |
| `~/.muninn/data/`                 | MuninnDB data (Pebble DB)                       |

## Provenance

| Field         | Value                                                       |
| ------------- | ----------------------------------------------------------- |
| Forked from   | `@kuyavinny/pi-muninn-mem` v1.1.0                           |
| Upstream repo | `https://github.com/kuyavinny/pi-muninn-mem`                |
| Relationship  | Fork                                                        |
| Inspiration   | `muninndb` server (`https://github.com/scrypster/muninndb`) |
| License       | MIT                                                         |

See `.upstream.json` for full provenance tracking.

## License

MIT
