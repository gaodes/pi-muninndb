/**
 * muninn-test — Pi-side smoke test for MuninnDB integration.
 *
 * Tests the MuninnDB REST API directly (fast, no MCP overhead).
 * Called via `/muninn-test` Pi command or standalone:
 *   node dist/muninn-test.mjs [--vault NAME] [--verbose]
 *
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
const TEST_TAG = "__pi_test__";
const TEST_PREFIX = `__pi_test_${Date.now().toString(36)}__`;

let vault = "default";
let verbose = false;
let dryRun = false;

// ─── Test runner ───────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
  ms: number;
}

const results: TestResult[] = [];
const createdIds: string[] = [];

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

// ─── HTTP helpers ──────────────────────────────────────────────────

async function get(path: string): Promise<{ status: number; body: unknown }> {
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

async function post(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
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

async function put(path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
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

async function del(path: string): Promise<{ status: number; body: unknown }> {
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

// ─── Assertions ────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(arr: unknown[], item: unknown, label: string): void {
  if (!arr.includes(item)) throw new Error(`${label}: expected array to include ${JSON.stringify(item)}, got ${JSON.stringify(arr)}`);
}

function getField(obj: unknown, field: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[field];
}

// ─── Test suites ───────────────────────────────────────────────────

async function testHealthAndConnection(): Promise<void> {
  console.log("\n📡 Test 1: Health & Connection");

  await runTest("GET /api/health", async () => {
    const { status, body } = await get("api/health");
    assertEq(status, 200, "status");
    assertEq(getField(body, "status"), "ok", "health status");
  });

  await runTest("GET /api/vaults", async () => {
    const { status, body } = await get("api/vaults");
    assertEq(status, 200, "status");
    assert(Array.isArray(body), "vaults should be an array");
    assert((body as string[]).includes(vault), `vault "${vault}" should exist`);
  });

  await runTest("GET /api/guide", async () => {
    const { status, body } = await get("api/guide");
    assertEq(status, 200, "status");
    assert(typeof getField(body, "guide") === "string", "guide should be a string");
  });
}

async function testCRUD(): Promise<void> {
  console.log("\n📝 Test 2: CRUD Operations");

  let testId = "";

  await runTest("POST /api/engrams — create", async () => {
    const { status, body } = await post("api/engrams", {
      concept: `${TEST_PREFIX}crud_test`,
      content: "Test memory for CRUD verification",
      tags: [TEST_TAG],
      type: "fact",
      entities: [
        { name: "MuninnTest", type: "test_entity" },
      ],
    });
    assertEq(status, 201, "status");
    const id = getField(body, "id") as string;
    assert(typeof id === "string" && id.length > 0, "should return an ID");
    testId = id;
    createdIds.push(id);
  });

  await runTest("GET /api/engrams/{id} — read", async () => {
    const { status, body } = await get(`api/engrams/${testId}`);
    assertEq(status, 200, "status");
    assertEq(getField(body, "concept"), `${TEST_PREFIX}crud_test`, "concept");
    assertEq(getField(body, "content"), "Test memory for CRUD verification", "content");
    const tags = getField(body, "tags") as string[];
    assertIncludes(tags, TEST_TAG, "tags");
  });

  await runTest("POST /api/activate — recall (semantic search)", async () => {
    const { status, body } = await post("api/activate", {
      context: ["MuninnTest CRUD test"],
      limit: 5,
    });
    assertEq(status, 200, "status");
    const activations = getField(body, "activations");
    assert(Array.isArray(activations), "activations should be an array");
    // Our test memory may or may not appear (embedding takes a moment)
  });

  await runTest("DELETE /api/engrams/{id} — forget", async () => {
    const { status, body } = await del(`api/engrams/${testId}`);
    assertEq(status, 200, "status");
    assertEq(getField(body, "ok"), true, "ok");
    // Remove from createdIds since it's deleted
    const idx = createdIds.indexOf(testId);
    if (idx >= 0) createdIds.splice(idx, 1);
  });

  await runTest("GET /api/deleted — list soft-deleted", async () => {
    const { status, body } = await get("api/deleted");
    assertEq(status, 200, "status");
    // Response is { deleted: [...], count: N }
    const deleted = getField(body, "deleted");
    assert(Array.isArray(deleted), "deleted should be an array");
  });

  // Note: restore endpoint not available via REST (MCP only)
  // Recreate for subsequent tests
  await runTest("POST /api/engrams — recreate for further tests", async () => {
    const { status, body } = await post("api/engrams", {
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
    const { status, body } = await post("api/engrams/batch", {
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
    // Batch write returns 201 on success
    assert(status === 200 || status === 201, `batch write should return 200 or 201, got ${status}`);
    const batchResults = getField(body, "results") as Array<{ id?: string; status?: string }>;
    assert(Array.isArray(batchResults), "results should be an array");
    assertEq(batchResults.length, 2, "batch count");
    for (const r of batchResults) {
      if (r.id) createdIds.push(r.id);
    }
  });

  // Wait briefly for embedding
  await new Promise((r) => setTimeout(r, 500));

  await runTest("POST /api/engrams/{id}/evolve — evolve", async () => {
    if (createdIds.length === 0) throw new Error("No test IDs available");
    const id = createdIds[0];
    const { status, body } = await post(`api/engrams/${id}/evolve`, {
      new_content: "Evolved test content — updated by test suite",
      reason: "Automated test: verify evolve endpoint",
    });
    assertEq(status, 200, "status");
    // Evolve creates a new ID, archive the old one
    const newId = getField(body, "id") as string;
    if (newId) {
      createdIds.push(newId);
      // The old ID is now archived, remove from cleanup list
      const idx = createdIds.indexOf(id);
      if (idx >= 0) createdIds.splice(idx, 1);
    }
  });

  await runTest("PUT /api/engrams/{id}/state — lifecycle state", async () => {
    if (createdIds.length === 0) throw new Error("No test IDs available");
    const id = createdIds[createdIds.length - 1];
    const { status, body } = await put(`api/engrams/${id}/state`, {
      state: "completed",
      reason: "Automated test",
    });
    assertEq(status, 200, "status");
    assertEq(getField(body, "state"), "completed", "state");
  });

  await runTest("POST /api/decide — record decision", async () => {
    const { status, body } = await post("api/decide", {
      decision: `${TEST_PREFIX}test_decision`,
      rationale: "Automated test decision to verify the decide endpoint",
      alternatives: ["skip", "defer"],
      tags: [TEST_TAG],
    });
    // Decide returns 201 on success
    assert(status === 200 || status === 201, `decide should return 200 or 201, got ${status}`);
  });
}

async function testQueryOperations(): Promise<void> {
  console.log("\n🔍 Test 4: Query Operations");

  await runTest("GET /api/engrams?tags=... — filter by tag", async () => {
    const { status, body } = await get(`api/engrams?tags=${TEST_TAG}&limit=50`);
    assertEq(status, 200, "status");
    const engrams = getField(body, "engrams") as Array<{ concept?: string }>;
    assert(Array.isArray(engrams), "engrams should be an array");
    // At least our test memories should be there
    const testEngrams = engrams.filter((e) => e.concept?.startsWith(TEST_PREFIX));
    assert(testEngrams.length > 0, `should find test memories (found ${testEngrams.length})`);
  });

  await runTest("GET /api/contradictions — check contradictions", async () => {
    const { status, body } = await get("api/contradictions");
    assertEq(status, 200, "status");
    // Response is { contradictions: [...], count: N }
    const contradictions = getField(body, "contradictions");
    assert(Array.isArray(contradictions), "contradictions should be an array");
  });

  await runTest("GET /api/session — session activity", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { status, body } = await get(`api/session?since=${encodeURIComponent(since)}`);
    assertEq(status, 200, "status");
    assert(Array.isArray(getField(body, "entries") as unknown), "entries should be an array");
  });
}

async function cleanup(): Promise<void> {
  console.log("\n🧹 Cleanup");

  // Forget all test engrams
  let cleaned = 0;
  let failed = 0;
  for (const id of createdIds) {
    try {
      const { status } = await del(`api/engrams/${id}`);
      if (status === 200) cleaned++;
      else failed++;
    } catch {
      failed++;
    }
  }

  // Also try to clean up any stale test memories from previous runs
  try {
    const { body } = await get(`api/engrams?tags=${TEST_TAG}&limit=100`);
    const engrams = (getField(body, "engrams") as Array<{ id?: string; concept?: string }>) || [];
    for (const e of engrams) {
      if (e.id && e.concept?.startsWith("__pi_test_")) {
        try {
          await del(`api/engrams/${e.id}`);
          cleaned++;
        } catch {
          failed++;
        }
      }
    }
  } catch {
    // Best effort
  }

  if (verbose || failed > 0) {
    console.log(`  Cleaned ${cleaned} test memories${failed > 0 ? `, ${failed} failed` : ""}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────

function printReport(): void {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const total = results.length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  console.log("\n" + "═".repeat(60));
  console.log(`  MuninnDB Test Report — vault "${vault}"`);
  console.log("═".repeat(60));

  // Group by suite (by looking at the console.log headers printed during run)
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
        console.log("Usage: muninn-test [--vault NAME] [--verbose] [--dry-run]");
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

  console.log(`🧪 MuninnDB Smoke Test — ${REST_URL} (vault: ${vault})`);

  if (dryRun) {
    console.log("\n  Would test: health, CRUD, batch, evolve, state, decide, query, cleanup");
    console.log("  Run without --dry-run to execute.");
    return;
  }

  try {
    await testHealthAndConnection();
    await testCRUD();
    await testBatchAndAdvanced();
    await testQueryOperations();
  } catch (err) {
    console.error(`\n💥 Fatal error: ${err instanceof Error ? err.message : err}`);
  } finally {
    await cleanup();
    printReport();
  }
}

// Run when executed directly
const isDirect = process.argv[1]?.endsWith("muninn-test.mjs") ||
  process.argv[1]?.endsWith("muninn-test.ts");
if (isDirect) {
  runTestSuite().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
