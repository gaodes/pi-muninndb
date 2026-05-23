/**
 * muninn-test — Pi-side smoke test for MuninnDB integration.
 *
 * Modes:
 *   node dist/muninn-test.mjs [--vault NAME] [--verbose]
 *     → fast mode: REST API only (16 tests, ~120ms)
 *   node dist/muninn-test.mjs full [--vault NAME] [--verbose]
 *     → full mode: REST + MCP over HTTP (39 tools, ~3s)
 *
 * Called via `/muninn-test` Pi command.
 * All test artifacts are tagged `__pi_test__` and cleaned up at the end.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Env loading (same as dream.ts) ────────────────────────────────

function loadMuninnEnv(): void {
  const envPath = join(process.env.HOME || "", ".muninn", "muninn.env");
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    /* ignore */
  }
}
loadMuninnEnv();

// ─── Config ────────────────────────────────────────────────────────

const REST_URL = (process.env.MUNINN_REST_URL || "http://127.0.0.1:8475").replace(/\/+$/, "");
const MCP_URL = (process.env.MUNINN_MCP_URL || "http://127.0.0.1:8750/mcp").replace(/\/+$/, "");
const TEST_TAG = "__pi_test__";
const TEST_PREFIX = `__pi_test_${Date.now().toString(36)}__`;

let vault = "default";
let verbose = false;
let dryRun = false;
let fullMode = false;

// ─── Test runner ───────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
  ms: number;
}

const results: TestResult[] = [];
const createdIds: string[] = [];
let mcpIdCounter = 0;

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = performance.now();
  try {
    await fn();
    const ms = Math.round(performance.now() - start);
    results.push({ name, status: "pass", ms });
    if (verbose) console.log(`  ✅ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "fail", detail: msg, ms });
    console.log(`  ❌ ${name} (${ms}ms): ${msg}`);
  }
}

// ─── REST HTTP helpers ─────────────────────────────────────────────

async function restGet(path: string): Promise<{ status: number; body: unknown }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${REST_URL}/${path}${sep}vault=${encodeURIComponent(vault)}`;
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function restPost(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${REST_URL}/${path}${sep}vault=${encodeURIComponent(vault)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function restPut(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${REST_URL}/${path}${sep}vault=${encodeURIComponent(vault)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function restDel(path: string): Promise<{ status: number; body: unknown }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${REST_URL}/${path}${sep}vault=${encodeURIComponent(vault)}`;
  const res = await fetch(url, { method: "DELETE" });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ─── MCP HTTP helpers ──────────────────────────────────────────────

/**
 * Call a MuninnDB MCP tool over HTTP.
 * The server is at port 8750/mcp and speaks JSON-RPC.
 */
async function mcpCall(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++mcpIdCounter;
  // Inject vault if not provided
  if (!("vault" in args)) args.vault = vault;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: args },
      id,
    }),
  });
  const json = (await res.json()) as {
    result?: { content?: Array<{ text?: string; type?: string }> };
    error?: { message?: string; code?: number };
  };

  if (json.error) {
    throw new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  const content = json.result?.content;
  if (!content || !Array.isArray(content) || content.length === 0) {
    throw new Error("MCP: empty response content");
  }

  // Parse the text field from the first content block
  const text = content[0].text;
  if (text === undefined || text === null) {
    throw new Error("MCP: no text in response");
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Initialize the MCP session (protocol handshake).
 */
async function mcpInitialize(): Promise<void> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "muninn-test", version: "1.0.0" },
      },
      id: 0,
    }),
  });
  const json = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
  if (!json.result?.serverInfo?.name) {
    throw new Error("MCP initialize failed");
  }
}

// ─── Assertions ────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(arr: unknown[], item: unknown, label: string): void {
  if (!arr.includes(item))
    throw new Error(`${label}: expected array to include ${JSON.stringify(item)}, got ${JSON.stringify(arr)}`);
}

function getField(obj: unknown, field: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[field];
}

// ═══════════════════════════════════════════════════════════════════
// FAST MODE — REST API Tests (16 tests)
// ═══════════════════════════════════════════════════════════════════

async function testHealthAndConnection(): Promise<void> {
  console.log("\n📡 Test 1: Health & Connection");

  await runTest("GET /api/health", async () => {
    const { status, body } = await restGet("api/health");
    assertEq(status, 200, "status");
    assertEq(getField(body, "status"), "ok", "health status");
  });

  await runTest("GET /api/vaults", async () => {
    const { status, body } = await restGet("api/vaults");
    assertEq(status, 200, "status");
    assert(Array.isArray(body), "vaults should be an array");
    assert((body as string[]).includes(vault), `vault "${vault}" should exist`);
  });

  await runTest("GET /api/guide", async () => {
    const { status, body } = await restGet("api/guide");
    assertEq(status, 200, "status");
    assert(typeof getField(body, "guide") === "string", "guide should be a string");
  });
}

async function testCRUD(): Promise<void> {
  console.log("\n📝 Test 2: CRUD Operations");

  let testId = "";

  await runTest("POST /api/engrams — create", async () => {
    const { status, body } = await restPost("api/engrams", {
      concept: `${TEST_PREFIX}crud_test`,
      content: "Test memory for CRUD verification",
      tags: [TEST_TAG],
      type: "fact",
      entities: [{ name: "MuninnTest", type: "test_entity" }],
    });
    assertEq(status, 201, "status");
    const id = getField(body, "id") as string;
    assert(typeof id === "string" && id.length > 0, "should return an ID");
    testId = id;
    createdIds.push(id);
  });

  await runTest("GET /api/engrams/{id} — read", async () => {
    const { status, body } = await restGet(`api/engrams/${testId}`);
    assertEq(status, 200, "status");
    assertEq(getField(body, "concept"), `${TEST_PREFIX}crud_test`, "concept");
    assertEq(getField(body, "content"), "Test memory for CRUD verification", "content");
    const tags = getField(body, "tags") as string[];
    assertIncludes(tags, TEST_TAG, "tags");
  });

  await runTest("POST /api/activate — recall (semantic search)", async () => {
    const { status, body } = await restPost("api/activate", {
      context: ["MuninnTest CRUD test"],
      limit: 5,
    });
    assertEq(status, 200, "status");
    const activations = getField(body, "activations");
    assert(Array.isArray(activations), "activations should be an array");
  });

  await runTest("DELETE /api/engrams/{id} — forget", async () => {
    const { status, body } = await restDel(`api/engrams/${testId}`);
    assertEq(status, 200, "status");
    assertEq(getField(body, "ok"), true, "ok");
    const idx = createdIds.indexOf(testId);
    if (idx >= 0) createdIds.splice(idx, 1);
  });

  await runTest("GET /api/deleted — list soft-deleted", async () => {
    const { status, body } = await restGet("api/deleted");
    assertEq(status, 200, "status");
    const deleted = getField(body, "deleted");
    assert(Array.isArray(deleted), "deleted should be an array");
  });

  // Recreate for subsequent tests
  await runTest("POST /api/engrams — recreate for further tests", async () => {
    const { status, body } = await restPost("api/engrams", {
      concept: `${TEST_PREFIX}persist`,
      content: "Persistent test memory for advanced operation tests",
      tags: [TEST_TAG],
      type: "fact",
      entities: [
        { name: "MuninnTest", type: "test_entity" },
        { name: "MuninnTestTarget", type: "test_entity" },
      ],
    });
    assertEq(status, 201, "status");
    const id = getField(body, "id") as string;
    testId = id;
    createdIds.push(id);
  });
}

async function testBatchAndAdvanced(): Promise<void> {
  console.log("\n⚡ Test 3: Batch & Advanced Operations");

  await runTest("POST /api/engrams/batch — batch write", async () => {
    const { status, body } = await restPost("api/engrams/batch", {
      engrams: [
        {
          concept: `${TEST_PREFIX}batch_1`,
          content: "First batch test memory",
          tags: [TEST_TAG],
          type: "fact",
        },
        {
          concept: `${TEST_PREFIX}batch_2`,
          content: "Second batch test memory",
          tags: [TEST_TAG],
          type: "fact",
        },
      ],
    });
    assert(status === 200 || status === 201, `batch write should return 200 or 201, got ${status}`);
    const batchResults = getField(body, "results") as Array<{ id?: string; status?: string }>;
    assert(Array.isArray(batchResults), "results should be an array");
    assertEq(batchResults.length, 2, "batch count");
    for (const r of batchResults) {
      if (r.id) createdIds.push(r.id);
    }
  });

  await new Promise((r) => setTimeout(r, 500));

  await runTest("POST /api/engrams/{id}/evolve — evolve", async () => {
    if (createdIds.length === 0) throw new Error("No test IDs available");
    const id = createdIds[0];
    const { status, body } = await restPost(`api/engrams/${id}/evolve`, {
      new_content: "Evolved test content — updated by test suite",
      reason: "Automated test: verify evolve endpoint",
    });
    assertEq(status, 200, "status");
    const newId = getField(body, "id") as string;
    if (newId) {
      createdIds.push(newId);
      const idx = createdIds.indexOf(id);
      if (idx >= 0) createdIds.splice(idx, 1);
    }
  });

  await runTest("PUT /api/engrams/{id}/state — lifecycle state", async () => {
    if (createdIds.length === 0) throw new Error("No test IDs available");
    const id = createdIds[createdIds.length - 1];
    const { status, body } = await restPut(`api/engrams/${id}/state`, {
      state: "completed",
      reason: "Automated test",
    });
    assertEq(status, 200, "status");
    assertEq(getField(body, "state"), "completed", "state");
  });

  await runTest("POST /api/decide — record decision", async () => {
    const { status } = await restPost("api/decide", {
      decision: `${TEST_PREFIX}test_decision`,
      rationale: "Automated test decision to verify the decide endpoint",
      alternatives: ["skip", "defer"],
      tags: [TEST_TAG],
    });
    assert(status === 200 || status === 201, `decide should return 200 or 201`);
  });
}

async function testQueryOperations(): Promise<void> {
  console.log("\n🔍 Test 4: Query Operations");

  await runTest("GET /api/engrams?tags=... — filter by tag", async () => {
    const { status, body } = await restGet(`api/engrams?tags=${TEST_TAG}&limit=50`);
    assertEq(status, 200, "status");
    const engrams = getField(body, "engrams") as Array<{ concept?: string }>;
    assert(Array.isArray(engrams), "engrams should be an array");
    const testEngrams = engrams.filter((e) => e.concept?.startsWith(TEST_PREFIX));
    assert(testEngrams.length > 0, `should find test memories (found ${testEngrams.length})`);
  });

  await runTest("GET /api/contradictions — check contradictions", async () => {
    const { status, body } = await restGet("api/contradictions");
    assertEq(status, 200, "status");
    const contradictions = getField(body, "contradictions");
    assert(Array.isArray(contradictions), "contradictions should be an array");
  });

  await runTest("GET /api/session — session activity", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { status, body } = await restGet(`api/session?since=${encodeURIComponent(since)}`);
    assertEq(status, 200, "status");
    assert(Array.isArray(getField(body, "entries") as unknown), "entries should be an array");
  });
}

// ═══════════════════════════════════════════════════════════════════
// FULL MODE — MCP over HTTP Tests (23 additional tests)
// ═══════════════════════════════════════════════════════════════════

/** MCP-created engram IDs to track for cleanup */
const mcpCreatedIds: string[] = [];

async function testMcpConnection(): Promise<void> {
  console.log("\n🔌 Test 5: MCP Connection");

  await runTest("MCP initialize — protocol handshake", async () => {
    await mcpInitialize();
  });

  await runTest("MCP muninn_status — vault health", async () => {
    const result = (await mcpCall("muninn_status")) as Record<string, unknown>;
    assertEq(getField(result, "health"), "good", "health");
    assert(typeof getField(result, "total_memories") === "number", "total_memories should be a number");
  });

  await runTest("MCP muninn_where_left_off — session context", async () => {
    const result = (await mcpCall("muninn_where_left_off", { limit: 3 })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
    assert(Array.isArray(getField(result, "memories")), "memories should be an array");
  });
}

async function testMcpEntityOperations(): Promise<void> {
  console.log("\n🏷️ Test 6: Entity Operations");

  await runTest("MCP muninn_entities — list entities", async () => {
    const result = (await mcpCall("muninn_entities", { limit: 5 })) as Record<string, unknown>;
    assert(typeof getField(result, "count") === "number", "count should be a number");
    assert(Array.isArray(getField(result, "entities")), "entities should be an array");
  });

  await runTest("MCP muninn_entity — single entity detail", async () => {
    const result = (await mcpCall("muninn_entity", { name: "MuninnTest", limit: 3 })) as Record<string, unknown>;
    // Entity may or may not exist yet (depends on REST test ordering)
    // Just verify the call succeeds and returns structured data
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_find_by_entity — search by entity", async () => {
    const result = (await mcpCall("muninn_find_by_entity", { entity_name: "MuninnTest", limit: 5 })) as Record<
      string,
      unknown
    >;
    assert(typeof result === "object", "should return an object");
    assert(Array.isArray(getField(result, "engrams")), "engrams should be an array");
  });

  await runTest("MCP muninn_entity_timeline — entity history", async () => {
    const result = (await mcpCall("muninn_entity_timeline", { entity_name: "MuninnTest", limit: 5 })) as Record<
      string,
      unknown
    >;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_entity_state — set entity state", async () => {
    const result = (await mcpCall("muninn_entity_state", {
      entity_name: "MuninnTest",
      state: "active",
      type: "test_entity",
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_entity_clusters — co-occurrence pairs", async () => {
    const result = (await mcpCall("muninn_entity_clusters", { top_n: 5 })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_similar_entities — duplicate detection", async () => {
    const result = (await mcpCall("muninn_similar_entities", { top_n: 5 })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });
}

async function testMcpGraphOperations(): Promise<void> {
  console.log("\n🔗 Test 7: Graph & Link Operations");

  // First create two engrams via MCP to link them
  let idA = "";
  let idB = "";

  await runTest("MCP muninn_remember — create engram A for linking", async () => {
    const result = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}link_src`,
      content: "Source engram for link test",
      tags: [TEST_TAG],
      type: "fact",
      entities: [{ name: "MuninnTestLinkSrc", type: "test_entity" }],
    })) as Record<string, unknown>;
    idA = getField(result, "id") as string;
    assert(typeof idA === "string" && idA.length > 0, "should return an ID");
    mcpCreatedIds.push(idA);
  });

  await runTest("MCP muninn_remember — create engram B for linking", async () => {
    const result = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}link_dst`,
      content: "Target engram for link test",
      tags: [TEST_TAG],
      type: "fact",
      entities: [{ name: "MuninnTestLinkDst", type: "test_entity" }],
    })) as Record<string, unknown>;
    idB = getField(result, "id") as string;
    assert(typeof idB === "string" && idB.length > 0, "should return an ID");
    mcpCreatedIds.push(idB);
  });

  await runTest("MCP muninn_link — create association", async () => {
    const result = (await mcpCall("muninn_link", {
      source_id: idA,
      target_id: idB,
      relation: "supports",
      weight: 0.8,
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
  });

  await runTest("MCP muninn_traverse — graph traversal from engram", async () => {
    const result = (await mcpCall("muninn_traverse", {
      start_id: idA,
      max_hops: 2,
      max_nodes: 10,
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_explain — score explanation", async () => {
    const result = (await mcpCall("muninn_explain", {
      engram_id: idA,
      query: ["MuninnTest link"],
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_export_graph — graph export", async () => {
    const result = (await mcpCall("muninn_export_graph", {
      format: "json-ld",
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });
}

async function testMcpMemoryOperations(): Promise<void> {
  console.log("\n🧠 Test 8: Memory Operations (MCP-only)");

  let testId = "";

  await runTest("MCP muninn_remember — create test engram", async () => {
    const result = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}mcp_ops`,
      content: "Test engram for MCP-only operations",
      tags: [TEST_TAG],
      type: "fact",
      entities: [{ name: "MuninnTestOps", type: "test_entity" }],
    })) as Record<string, unknown>;
    testId = getField(result, "id") as string;
    assert(typeof testId === "string" && testId.length > 0, "should return an ID");
    mcpCreatedIds.push(testId);
  });

  await runTest("MCP muninn_read — read by ID", async () => {
    const result = (await mcpCall("muninn_read", { id: testId })) as Record<string, unknown>;
    assertEq(getField(result, "id"), testId, "id");
    assertEq(getField(result, "concept"), `${TEST_PREFIX}mcp_ops`, "concept");
  });

  await runTest("MCP muninn_recall — semantic search", async () => {
    const result = (await mcpCall("muninn_recall", {
      context: ["MuninnTestOps test"],
      limit: 5,
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
  });

  await runTest("MCP muninn_evolve — update content", async () => {
    const result = (await mcpCall("muninn_evolve", {
      id: testId,
      new_content: "Evolved content via MCP test",
      reason: "Automated MCP test",
    })) as Record<string, unknown>;
    const newId = getField(result, "id") as string;
    if (newId) {
      mcpCreatedIds.push(newId);
      const idx = mcpCreatedIds.indexOf(testId);
      if (idx >= 0) mcpCreatedIds.splice(idx, 1);
      testId = newId;
    }
  });

  await runTest("MCP muninn_consolidate — merge memories", async () => {
    // Create two memories to merge
    const r1 = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}merge_a`,
      content: "First memory to merge",
      tags: [TEST_TAG],
      type: "fact",
    })) as Record<string, unknown>;
    const r2 = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}merge_b`,
      content: "Second memory to merge",
      tags: [TEST_TAG],
      type: "fact",
    })) as Record<string, unknown>;
    const id1 = getField(r1, "id") as string;
    const id2 = getField(r2, "id") as string;
    mcpCreatedIds.push(id1, id2);

    const result = (await mcpCall("muninn_consolidate", {
      ids: [id1, id2],
      merged_content: "Consolidated: both merge test memories combined",
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
    // Consolidated creates new, archives originals
    const mergedId = getField(result, "id") as string;
    if (mergedId) mcpCreatedIds.push(mergedId);
    // Remove archived originals
    for (const oldId of [id1, id2]) {
      const idx = mcpCreatedIds.indexOf(oldId);
      if (idx >= 0) mcpCreatedIds.splice(idx, 1);
    }
  });

  await runTest("MCP muninn_state — lifecycle state change", async () => {
    const result = (await mcpCall("muninn_state", {
      id: testId,
      state: "active",
      reason: "MCP test state change",
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
  });

  await runTest("MCP muninn_decide — record decision via MCP", async () => {
    const result = (await mcpCall("muninn_decide", {
      decision: `${TEST_PREFIX}mcp_decision`,
      rationale: "MCP test decision",
      alternatives: ["skip"],
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
    const id = getField(result, "id") as string;
    if (id) mcpCreatedIds.push(id);
  });
}

async function testMcpTreeOperations(): Promise<void> {
  console.log("\n🌳 Test 9: Tree Operations");

  let rootId = "";

  await runTest("MCP muninn_remember_tree — create hierarchy", async () => {
    const result = (await mcpCall("muninn_remember_tree", {
      root: {
        concept: `${TEST_PREFIX}tree_root`,
        content: "Root node of test tree",
        tags: [TEST_TAG],
        type: "goal",
        children: [
          { concept: `${TEST_PREFIX}tree_child_1`, content: "First child", type: "task" },
          { concept: `${TEST_PREFIX}tree_child_2`, content: "Second child", type: "task" },
        ],
      },
    })) as Record<string, unknown>;
    rootId = getField(result, "root_id") as string;
    assert(typeof rootId === "string" && rootId.length > 0, "should return root_id");
    mcpCreatedIds.push(rootId);
    // Track child IDs from node_map
    const nodeMap = getField(result, "node_map") as Record<string, string>;
    if (nodeMap) {
      for (const id of Object.values(nodeMap)) {
        if (id !== rootId) mcpCreatedIds.push(id);
      }
    }
  });

  await runTest("MCP muninn_recall_tree — retrieve hierarchy", async () => {
    if (!rootId) throw new Error("No root ID from tree creation");
    const result = (await mcpCall("muninn_recall_tree", {
      root_id: rootId,
      max_depth: 3,
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_add_child — add node to tree", async () => {
    if (!rootId) throw new Error("No root ID for add_child");
    const result = (await mcpCall("muninn_add_child", {
      parent_id: rootId,
      concept: `${TEST_PREFIX}tree_child_appended`,
      content: "Appended child node",
      type: "task",
    })) as Record<string, unknown>;
    const childId = getField(result, "id") as string;
    if (childId) mcpCreatedIds.push(childId);
    assert(typeof result === "object", "should return a result");
  });
}

async function testMcpEnrichmentAndProvenance(): Promise<void> {
  console.log("\n📜 Test 10: Enrichment & Provenance");

  // Find a test engram to use
  let testId = mcpCreatedIds.length > 0 ? mcpCreatedIds[0] : "";

  // If no MCP-created ID, create one
  if (!testId) {
    const r = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}enrich_test`,
      content: "Enrichment test engram",
      tags: [TEST_TAG],
      type: "fact",
    })) as Record<string, unknown>;
    testId = getField(r, "id") as string;
    mcpCreatedIds.push(testId);
  }

  await runTest("MCP muninn_provenance — audit trail", async () => {
    const result = (await mcpCall("muninn_provenance", { id: testId })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_get_enrichment_candidates — pending enrichments", async () => {
    const result = (await mcpCall("muninn_get_enrichment_candidates", { limit: 5 })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });

  await runTest("MCP muninn_trust — set trust level", async () => {
    const result = (await mcpCall("muninn_trust", {
      id: testId,
      trust: "inferred",
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
  });

  await runTest("MCP muninn_feedback — record feedback", async () => {
    const result = (await mcpCall("muninn_feedback", {
      engram_id: testId,
      useful: true,
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
  });
}

async function testMcpListDeletedAndRestore(): Promise<void> {
  console.log("\n♻️ Test 11: Delete & Restore (MCP-only)");

  // Create, forget, then restore
  let testId = "";

  await runTest("MCP muninn_forget + muninn_restore — soft-delete and recover", async () => {
    // Create
    const createResult = (await mcpCall("muninn_remember", {
      concept: `${TEST_PREFIX}restore_test`,
      content: "Memory to be forgotten and restored",
      tags: [TEST_TAG],
      type: "fact",
    })) as Record<string, unknown>;
    testId = getField(createResult, "id") as string;
    assert(typeof testId === "string", "should create an engram");

    // Forget
    const forgetResult = (await mcpCall("muninn_forget", { id: testId })) as Record<string, unknown>;
    assert(typeof forgetResult === "object", "forget should return a result");

    // Restore
    const restoreResult = (await mcpCall("muninn_restore", { id: testId })) as Record<string, unknown>;
    assert(typeof restoreResult === "object", "restore should return a result");

    // Now it's active again, track for cleanup
    mcpCreatedIds.push(testId);
  });

  await runTest("MCP muninn_list_deleted — list soft-deleted", async () => {
    const result = (await mcpCall("muninn_list_deleted", { limit: 5 })) as Record<string, unknown>;
    assert(typeof result === "object", "should return an object");
  });
}

async function testMcpBatchRecall(): Promise<void> {
  console.log("\n📚 Test 12: Batch & Recall (MCP)");

  await runTest("MCP muninn_remember_batch — batch create", async () => {
    const result = (await mcpCall("muninn_remember_batch", {
      memories: [
        {
          concept: `${TEST_PREFIX}batch_mcp_1`,
          content: "First MCP batch memory",
          tags: [TEST_TAG],
          type: "fact",
        },
        {
          concept: `${TEST_PREFIX}batch_mcp_2`,
          content: "Second MCP batch memory",
          tags: [TEST_TAG],
          type: "fact",
        },
      ],
    })) as Record<string, unknown>;
    assert(typeof result === "object", "should return a result");
    const batchResults = getField(result, "results") as Array<{ id?: string }>;
    if (Array.isArray(batchResults)) {
      for (const r of batchResults) {
        if (r.id) mcpCreatedIds.push(r.id);
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════════

async function cleanup(): Promise<void> {
  console.log("\n🧹 Cleanup");

  let cleaned = 0;
  let failed = 0;

  // Clean REST-created IDs
  for (const id of createdIds) {
    try {
      const { status } = await restDel(`api/engrams/${id}`);
      if (status === 200) cleaned++;
      else failed++;
    } catch {
      failed++;
    }
  }

  // Clean MCP-created IDs via MCP
  for (const id of mcpCreatedIds) {
    try {
      await mcpCall("muninn_forget", { id });
      cleaned++;
    } catch {
      failed++;
    }
  }

  // Also clean stale test memories from previous runs
  try {
    const { body } = await restGet(`api/engrams?tags=${TEST_TAG}&limit=100`);
    const engrams = (getField(body, "engrams") as Array<{ id?: string; concept?: string }>) || [];
    for (const e of engrams) {
      if (e.id && e.concept?.startsWith("__pi_test_")) {
        try {
          await restDel(`api/engrams/${e.id}`);
          cleaned++;
        } catch {
          failed++;
        }
      }
    }
  } catch {
    /* best effort */
  }

  if (verbose || failed > 0) {
    console.log(`  Cleaned ${cleaned} test memories${failed > 0 ? `, ${failed} failed` : ""}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Report & Main
// ═══════════════════════════════════════════════════════════════════

function printReport(): void {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const total = results.length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  console.log("\n" + "═".repeat(60));
  console.log(`  MuninnDB Test Report — vault "${vault}" — ${fullMode ? "FULL" : "FAST"}`);
  console.log("═".repeat(60));

  for (const r of results) {
    const icon = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : "⏭️";
    const detail = r.detail ? ` — ${r.detail}` : "";
    console.log(`  ${icon} ${r.name} (${r.ms}ms)${detail}`);
  }

  console.log("─".repeat(60));
  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped} | Time: ${totalMs}ms`);
  console.log("═".repeat(60));

  if (failed > 0) {
    console.log(`\n⚠️  ${failed} test(s) failed. Check the MuninnDB server logs for details.`);
    process.exit(1);
  } else {
    console.log(`\n✅ All ${passed} tests passed.`);
  }
}

function parseArgs(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "full":
        fullMode = true;
        break;
      case "--vault":
        vault = argv[++i] || "default";
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log("Usage: muninn-test [full] [--vault NAME] [--verbose] [--dry-run]");
        console.log("");
        console.log("Modes:");
        console.log("  (default)     Fast mode — REST API only (16 tests, ~120ms)");
        console.log("  full          Full mode — REST + MCP over HTTP (39 tools, ~3s)");
        console.log("");
        console.log("Options:");
        console.log("  --vault NAME    Vault to test (default: auto-detected)");
        console.log("  --verbose, -v   Show per-test output as it runs");
        console.log("  --dry-run       Show what would be tested without making changes");
        process.exit(0);
    }
  }
}

export async function runTestSuite(argv = process.argv.slice(2)): Promise<void> {
  parseArgs(argv);

  const modeLabel = fullMode ? "FULL (REST + MCP)" : "FAST (REST only)";
  console.log(`🧪 MuninnDB Test — ${modeLabel} — vault: ${vault}`);

  if (dryRun) {
    if (fullMode) {
      console.log("\n  Would test: health, CRUD, batch, evolve, state, decide, query,");
      console.log("  plus MCP: entity ops, graph, link, tree, enrichment, provenance, restore");
    } else {
      console.log("\n  Would test: health, CRUD, batch, evolve, state, decide, query, cleanup");
    }
    console.log("  Run without --dry-run to execute.");
    return;
  }

  try {
    // Fast mode: REST API tests (always run)
    await testHealthAndConnection();
    await testCRUD();
    await testBatchAndAdvanced();
    await testQueryOperations();

    // Full mode: MCP over HTTP tests
    if (fullMode) {
      await testMcpConnection();
      await testMcpEntityOperations();
      await testMcpGraphOperations();
      await testMcpMemoryOperations();
      await testMcpTreeOperations();
      await testMcpEnrichmentAndProvenance();
      await testMcpListDeletedAndRestore();
      await testMcpBatchRecall();
    }
  } catch (err) {
    console.error(`\n💥 Fatal error: ${err instanceof Error ? err.message : err}`);
  } finally {
    await cleanup();
    printReport();
  }
}

// Run when executed directly
const isDirect = process.argv[1]?.endsWith("muninn-test.mjs") || process.argv[1]?.endsWith("muninn-test.ts");
if (isDirect) {
  runTestSuite().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
