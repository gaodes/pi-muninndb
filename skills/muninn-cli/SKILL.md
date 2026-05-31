---
name: muninn-cli
description: >
  Manage the MuninnDB server and vaults using the muninn CLI. Use when the
  user asks to start, stop, restart, or check MuninnDB; manage vaults (create,
  delete, clone, export, import, list); manage API keys; run the dream protocol
  (memory consolidation); back up or restore data; upgrade MuninnDB; or
  configure embedders and LLM enrichment. Also use for any question about
  ports, data directory layout, service health, the muninn.env configuration
  file, or when Pi's MuninnDB memory tools fail to connect. Do not use for
  storing or recalling memories (use the MuninnDB MCP tools directly) or for
  editing the pi-muninndb extension's prime-settings.json keys.
---

# muninn CLI — MuninnDB Server Management

**Version documented:** v0.6.1 — if `muninn --version` differs, treat flag spellings as suggestions and run `muninn <subcommand> --help` to confirm.  
**Binary location:** `~/.local/bin/muninn` (installed via `curl -sSL https://muninndb.com/install.sh | sh`)  
**Data directory:** `~/.muninn/data/`  
**Config file:** `~/.muninn/muninn.env`

## Mental Model

MuninnDB is a single-binary cognitive memory server. The `muninn` CLI manages three things:

1. **The server** — start/stop/restart the background daemon
2. **Vaults** — isolated memory namespaces, one per project or agent
3. **Data lifecycle** — backup, restore, dream consolidation, upgrades

The server exposes four ports:

| Port | Protocol | Purpose |
|------|----------|---------|
| 8474 | MBP binary | Internal binary protocol |
| 8475 | REST JSON | Direct API, health, stats |
| 8476 | Web UI | Browser dashboard |
| 8750 | MCP | AI tool integration (Pi, Claude, Cursor) |

Everything the Pi extension does (vault injection, SSE, MCP tools) flows through these ports. The CLI is how you operate the server itself.

## Pi Extension Commands

**Preference rule:** In a Pi session, prefer the `/muninn-*` slash commands over raw CLI. They handle confirmation prompts, vault marker files, and `prime-settings.json` updates. Fall back to raw `muninn` CLI only when (1) the slash command is not available, (2) the user explicitly asks for the raw command, or (3) you need a flag the slash command does not expose.

| Pi command | Underlying operation |
|-----------|---------------------|
| `/muninn-setup` | Interactive install + `muninn init` (tool discovery and config-file scaffolding) |
| `/muninn-remove` | Remove MuninnDB integration |
| `/muninn-vault` | `muninn vault list/create/unlink` |
| `/muninn-dream` | `muninn dream --dry-run` then confirm |
| `/muninn-backup` | `muninn vault export` + `muninn backup` |
| `/muninn-health` | REST health check + `muninn status` |
| `/muninn-import` | `muninn vault import` |
| `/muninn-upgrade` | `muninn version` + `muninn upgrade` |
| `/muninn-test` | Direct MCP HTTP tests (no CLI) |

## Core Operations

### Server lifecycle

```bash
muninn start          # Start all services in background
muninn stop           # Stop the server
muninn restart        # Stop + start
muninn status         # Show which services are up + ports
muninn logs           # Tail logs (last 25 lines + follow)
muninn logs 50        # Tail last 50 lines
muninn logs --no-follow   # Print recent lines and exit
```

### First-time setup

```bash
muninn init           # Interactive wizard — connects AI tools automatically
muninn init --tool claude,cursor --yes   # Non-interactive, specific tools
muninn init --tool manual --no-token    # Manual config, no MCP token
```

`muninn init` auto-detects and configures Claude Desktop, Cursor, Windsurf, VS Code, OpenClaw, and Codex. For Pi, the MCP endpoint (`http://127.0.0.1:8750/mcp`) is wired by `pi-mcp-adapter`; `muninn init` is still run by `/muninn-setup` for tool discovery and config-file scaffolding.

### Vault management

```bash
muninn vault list                          # List all vaults
muninn vault list --pattern 'pi-*'        # Glob filter
muninn vault create myproject             # Create locked vault (requires API key)
muninn vault create public-notes --public  # Create open vault (no key needed)
muninn vault delete old-project --yes     # Delete vault + all memories
muninn vault clear myproject --yes        # Remove all memories, keep vault
muninn vault clone production staging     # Clone vault to new name
muninn vault merge source target          # Merge source into target
muninn vault export --vault mydata -o backup.muninn   # Export archive
muninn vault export-markdown --vault mydata -o notes.tgz  # Export as markdown
muninn vault import backup.muninn --vault restored  # Import archive
muninn vault reindex-fts myvault          # Rebuild full-text search index
```

Admin flags available on vault commands: `-u <user>`, `-p` or `-p<password>`, `-h <host:port>`.

### ⚠️ Destructive operations — back up first

Always run `muninn vault export --vault <name> -o <archive>.muninn` **before** any of:

- `muninn vault delete --yes`
- `muninn vault clear --yes`
- `muninn vault merge <src> <dst>`
- `muninn dream` (real run — not `--dry-run`)
- `muninn upgrade` (server data layout can shift across major versions)

Confirm with the user before running any of the above. Never pass `--yes` without an explicit user confirmation in the same turn.

### API key management

```bash
muninn api-key create --vault default --label my-agent         # Create key (shown once)
muninn api-key create --vault default --mode observe --expires 90d  # Read-only, 90d expiry
muninn api-key list                        # List all keys (no token values)
muninn api-key list --vault default        # Keys for one vault
muninn api-key revoke A1B2C3D4             # Revoke a key immediately
```

Access modes: `full` (default — read/write) or `observe` (read-only). No other modes in v0.6.1.

### One-shot operations without daemon

```bash
# No server needed — direct data directory access
muninn exec remember --concept "standup" --content "Fixed the auth bug"
muninn exec recall --query "auth bug" --limit 5
muninn exec read --id 01ARZ3NDEKTSV4RRFFQ69G5FAV
muninn exec forget --id 01ARZ3NDEKTSV4RRFFQ69G5FAV

# Custom data directory or vault
muninn exec recall --query "payments" --vault work --data-dir /mnt/backup
```

⚠️ `exec` requires exclusive lock on `--data-dir`. It fails if the daemon is running on the same directory.

### Dream protocol (memory consolidation)

```bash
# Server MUST be stopped first
muninn stop
muninn dream --dry-run           # Preview what would be consolidated
muninn dream --scope myproject   # Consolidate one vault
muninn dream --force             # Bypass trigger gates
```

Dream uses LLM enrichment to consolidate, link, and prune memories. Requires `MUNINN_ENRICH_URL` to be configured in `~/.muninn/muninn.env`. When using `/muninn-dream` from Pi, the extension handles the dry-run confirmation flow.

### Backup and restore

```bash
# Offline backup — server must be stopped
muninn stop
muninn backup --output ~/.muninn/backups/snapshot-$(date +%Y%m%d)

# Export single vault (server can be running)
muninn vault export --vault myproject -o myproject-backup.muninn

# Restore vault from archive
muninn vault import myproject-backup.muninn --vault restored-project
```

### Upgrade

```bash
muninn upgrade           # Check and install updates (restarts server)
muninn upgrade --check   # Check only, don't install
```

### Shell completions

```bash
muninn completion zsh >> ~/.zshrc
muninn completion bash >> ~/.bashrc
muninn completion fish > ~/.config/fish/completions/muninn.fish
```

### MCP stdio proxy

```bash
muninn mcp    # stdio→HTTP MCP proxy for OpenClaw or tools that need stdio MCP
# Override endpoint:
MUNINN_MCP_URL=https://remote:8750/mcp muninn mcp
```

### Cluster management

```bash
muninn cluster info        # Topology and node status
muninn cluster status      # Health + replication lag
muninn cluster enable      # Enable cluster mode
muninn cluster disable     # Disable cluster mode
muninn cluster failover    # Manual leader failover
muninn cluster add-node    # Show add-node instructions
muninn cluster remove-node # Remove a node
```

## Configuration

MuninnDB reads `~/.muninn/muninn.env` at server start. Edit this file to configure embedders and enrichment.

```bash
# ~/.muninn/muninn.env — auto-generated by muninn init

# MCP bearer token (required for authenticated vaults)
MUNINN_TOKEN=<hex-token>

# Embedder (pick one — Ollama is local and free)
MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text
# MUNINN_OPENAI_KEY=sk-...
# MUNINN_VOYAGE_KEY=pa-...
# MUNINN_COHERE_KEY=...
# MUNINN_GOOGLE_KEY=...
# MUNINN_JINA_KEY=...
# MUNINN_MISTRAL_KEY=...

# LLM enrichment (auto-extracts entities, summaries on every write)
MUNINN_ENRICH_URL=ollama://localhost:11434/gemma3:4b
# MUNINN_ENRICH_URL=openai://gpt-4o-mini
# MUNINN_ENRICH_API_KEY=sk-...
# MUNINN_ENRICH_URL=anthropic://claude-haiku-4-5-20251001
# MUNINN_ANTHROPIC_KEY=sk-ant-...

# Optional overrides
# MUNINNDB_DATA=/path/to/custom/data
# MUNINN_MEM_LIMIT_GB=4
# MUNINN_ENRICH_TIMEOUT=120s
```

After editing `muninn.env`, restart for changes to take effect:
```bash
muninn restart
```

## Common Workflows

### Pattern 1: New project setup

```bash
# 1. Server already running? Check:
muninn status

# 2. Create a vault for the project
muninn vault create my-project

# 3. Create an API key for Pi to use
muninn api-key create --vault my-project --label pi-agent
# Copy the token — shown once

# 4. Map the project directory to the vault (in Pi)
# /muninn-vault create my-project
```

**Verify:** `muninn vault list` shows `my-project`; `muninn api-key list --vault my-project` shows the new key label.

### Pattern 2: Scheduled dream run

```bash
# Export vault first (backup before destructive op)
muninn vault export --vault my-project -o ~/Desktop/my-project-predream.muninn

# Stop server, run dream, restart
muninn stop
muninn dream --dry-run --scope my-project   # review first
muninn dream --scope my-project             # run for real
muninn start
```

**Verify:** `muninn start` then `muninn status` shows all four ports listening; `curl -sf http://127.0.0.1:8475/api/health` returns 200.

### Pattern 3: Export vault for migration

```bash
# Export
muninn vault export --vault my-project -o ~/Desktop/my-project-$(date +%Y%m%d).muninn

# On new machine: import
muninn vault import ~/Desktop/my-project-20260531.muninn --vault my-project
```

**Verify:** `muninn vault list` on the target machine shows the imported vault; check the expected memory count via the web UI (`http://127.0.0.1:8476`).

### Pattern 4: Diagnose a failing connection

```bash
muninn status            # Is the server up?
muninn logs --no-follow  # Any errors in recent logs?

# Check all ports respond
curl -sf http://127.0.0.1:8475/api/health && echo "REST OK"
curl -sf http://127.0.0.1:8750/mcp -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
  | head -c 200
```

**Verify:** REST check returns `{"status":"ok"}` or similar; MCP call returns a JSON-RPC result object with `protocolVersion` in the response.

## Data Directory Layout

```
~/.muninn/
├── muninn.env          # Configuration (embedder, enrichment, token)
├── data/
│   ├── pebble/         # Storage engine (Pebble/LevelDB)
│   ├── wal/            # Write-ahead log
│   ├── models/         # Local embedding model
│   ├── plugin_config.json  # Active embedder/enricher config
│   ├── muninn.addrs    # Live port bindings (JSON)
│   ├── muninn.pid      # Server process ID
│   ├── muninn.log      # Server log
│   └── audit.log       # Auth audit trail
└── backups/            # Archives from /muninn-backup
```

## Troubleshooting

**Server won't start after edit to muninn.env:**
```bash
muninn logs --no-follow   # Check for config parse errors
```

**`muninn exec` fails with lock error:**
```bash
muninn stop    # Daemon holds exclusive lock — stop it first
muninn exec recall --query "..."
muninn start   # Restart after exec
```

**Dream fails silently:**
```bash
# Verify MUNINN_ENRICH_URL is set:
cat ~/.muninn/muninn.env | grep ENRICH
# Verify server is stopped:
muninn status
# Check logs after run:
muninn logs --no-follow | tail -50
```

**Port conflict (another process on 8475/8750):**
```bash
lsof -i :8475 -i :8750    # See what's using the ports
# Start with custom addresses:
muninn start --mcp-addr :9750
```

**Vault API key lost:**
```bash
muninn api-key list --vault my-project    # Keys are listed (tokens not shown)
muninn api-key revoke <key-id>            # Revoke old key
muninn api-key create --vault my-project --label replacement  # New key
```

**Pi MCP tools not connecting (e.g. `muninndb_muninn_recall` failing):**
```bash
muninn status             # Check server is up; all ports should show [up]
muninn logs --no-follow   # Look for auth errors or TLS mismatches
# Verify the Pi extension has the correct token:
# /muninn-health (shows server status + vault stats from Pi)
# /muninn-setup  (re-runs muninn init if wiring is broken)
```

## Reporting results

When you run a `muninn` command, report back with:

1. **Action taken** — the exact command (one line).
2. **Outcome** — succeeded / failed / partial, with relevant numbers (vault count, port list, error code).
3. **Side effects** — what changed on disk or in the running server (e.g., "server restarted", "vault `foo` deleted", "API key `A1B2...` revoked").
4. **Next step (if any)** — required follow-up (e.g., "restart server for muninn.env changes to apply").

Prefer compact tables for `vault list`, `api-key list`, and `status` output. Trim log output to relevant lines only.
