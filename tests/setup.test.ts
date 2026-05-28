import { describe, it } from "node:test";
import assert from "node:assert";
import { validateMcpUrl, removeMuninnSection } from "../src/setup.js";

describe("validateMcpUrl", () => {
  it("accepts localhost with known port", () => {
    assert.strictEqual(validateMcpUrl("http://127.0.0.1:8750/mcp"), true);
    assert.strictEqual(validateMcpUrl("http://localhost:8475"), true);
  });

  it("rejects non-localhost hostnames", () => {
    assert.strictEqual(validateMcpUrl("http://example.com:8750/mcp"), false);
  });

  it("rejects unknown ports", () => {
    assert.strictEqual(validateMcpUrl("http://127.0.0.1:9999/mcp"), false);
  });

  it("rejects malformed URLs", () => {
    assert.strictEqual(validateMcpUrl("not-a-url"), false);
  });
});

describe("removeMuninnSection", () => {
  it("removes the MuninnDB section from AGENTS.md", () => {
    const content = "# Agent Instructions\n\n# Memory: MuninnDB\nSome content here.\n\n# Other Section\nMore text.";
    const result = removeMuninnSection(content);
    assert.ok(!result.includes("Memory: MuninnDB"));
    assert.ok(result.includes("Agent Instructions"));
    assert.ok(result.includes("Other Section"));
  });

  it("returns content unchanged if marker absent", () => {
    const content = "Just some text.";
    assert.strictEqual(removeMuninnSection(content), content);
  });
});
