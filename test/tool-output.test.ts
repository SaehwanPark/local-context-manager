import { stat, unlink, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFullOutputNotice,
  extractFullOutputPath,
  isLogOrEventStream,
  MAX_RETAINED_OUTPUT_CHARS,
  NON_EXHAUSTIVE_NOTICE,
  reduceToolOutput,
  saveRecoveryCopy,
} from "../src/tool-output.js";

function textResult(text: string, overrides: Partial<Parameters<typeof reduceToolOutput>[0]> = {}) {
  return reduceToolOutput({
    toolName: "bash",
    input: { command: "npm test" },
    content: [{ type: "text", text }],
    isError: false,
    ...overrides,
  });
}

describe("tool-output reduction", () => {
  it("keeps small output and source reads byte-for-byte", () => {
    const small = textResult("ok\n2 passed");
    expect(small.changed).toBe(false);
    expect(small.content).toEqual([{ type: "text", text: "ok\n2 passed" }]);

    const source = textResult("x\n".repeat(MAX_RETAINED_OUTPUT_CHARS), {
      input: { command: "cat src/index.ts" },
    });
    expect(source.changed).toBe(false);

    // Native read tool must never be reduced even if large
    const readTool = reduceToolOutput({
      toolName: "read",
      input: { path: "src/large-file.ts" },
      content: [{ type: "text", text: "line\n".repeat(2_000) }],
      isError: false,
    });
    expect(readTool.changed).toBe(false);
  });

  it("reduces a large build result while retaining diagnostics, tail, and non-exhaustive notice", () => {
    const output = [
      ...Array.from({ length: 400 }, (_, index) => `compile module ${index}`),
      "error TS2322: src/main.ts:42:7 type mismatch",
      ...Array.from({ length: 400 }, (_, index) => `post-build detail ${index}`),
      "Tests: 12 passed, 1 failed",
    ].join("\n");
    const reduced = textResult(output);

    expect(reduced.changed).toBe(true);
    expect(reduced.category).toBe("build");
    expect(reduced.retainedTokens).toBeLessThan(reduced.originalTokens);
    expect(reduced.compactedText).toContain("error TS2322");
    expect(reduced.compactedText).toContain("Tests: 12 passed");
    expect(reduced.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);
  });

  it("reduces a very large unknown command conservatively as generic output with non-exhaustive notice", () => {
    const reduced = textResult("ordinary output\n".repeat(2_000), {
      input: { command: "python script.py" },
    });
    expect(reduced.changed).toBe(true);
    expect(reduced.category).toBe("generic");
    expect(reduced.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);
  });

  it("prioritizes diagnostics in a failed command and includes non-exhaustive notice", () => {
    const output = [
      ...Array.from({ length: 900 }, (_, index) => `trace line ${index}`),
      "Traceback: failed at app/server.py:91:4",
      "command exited with code 2",
    ].join("\n");
    const reduced = textResult(output, { isError: true });

    expect(reduced.changed).toBe(true);
    expect(reduced.category).toBe("failure");
    expect(reduced.compactedText).toContain("app/server.py:91:4");
    expect(reduced.compactedText).toContain("Exit status: 2");
    expect(reduced.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);
  });

  it("summarizes search without claiming exhaustive matches and diff with file info", () => {
    const search = reduceToolOutput({
      toolName: "grep",
      input: { pattern: "TODO" },
      content: [{ type: "text", text: Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:${i}: TODO item`).join("\n") }],
      isError: false,
    });
    expect(search.category).toBe("search");
    expect(search.compactedText).toContain('Search query: "TODO"');
    // Must say "Sampled matching lines" rather than implying exhaustive matches
    expect(search.compactedText).toContain("Sampled matching lines:");
    expect(search.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);

    const diffText = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 123..456 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      "+new line",
      "-old line",
      ...Array.from({ length: 1_500 }, (_, i) => ` context ${i}`),
    ].join("\n");
    const diff = reduceToolOutput({
      toolName: "bash",
      input: { command: "git diff" },
      content: [{ type: "text", text: diffText }],
      isError: false,
    });
    expect(diff.category).toBe("diff");
    expect(diff.compactedText).toContain("src/a.ts (+1/-1)");
    expect(diff.compactedText).toContain("Hunks:");
    expect(diff.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);
  });

  it("preserves image blocks and adds a recoverable full-output notice", () => {
    const output = textResult("line\n".repeat(3_000), {
      content: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "line\n".repeat(3_000) },
      ],
    });
    expect(output.changed).toBe(true);
    expect(output.content[0]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });

    const withNotice = appendFullOutputNotice(output.content, "/tmp/tool-output.txt");
    expect(withNotice.at(-1)).toEqual(expect.objectContaining({ type: "text" }));
    expect(withNotice.map((block) => block.type === "text" ? block.text : "").join("\n")).toContain(
      "/tmp/tool-output.txt",
    );
    expect(extractFullOutputPath({ fullOutputPath: "/tmp/tool-output.txt" }, "")).toBe("/tmp/tool-output.txt");
    expect(extractFullOutputPath({}, "Full output: [/tmp/fake.txt]")).toBeUndefined();
  });

  it("creates recovery copies with file permissions 0600", async () => {
    const text = "confidential diagnostic logs and tool outputs";
    const path = await saveRecoveryCopy(text);
    expect(path).toBeDefined();
    if (!path) return;

    try {
      const stats = await stat(path);
      // Mode on POSIX systems: check the permission bits (0o777 mask)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await unlink(path);
      await rm(dirname(path), { recursive: true, force: true });
    }
  });

  it("detects log and event streams and preserves contiguous temporal windows", () => {
    expect(isLogOrEventStream("docker logs app")).toBe(true);
    expect(isLogOrEventStream("journalctl -u my-service")).toBe(true);
    expect(isLogOrEventStream("node app.js", [
      "2026-09-08T10:00:01 worker starting",
      "2026-09-08T10:00:02 worker connected",
      "2026-09-08T10:00:03 worker ready",
    ])).toBe(true);
    expect(isLogOrEventStream("npm test", ["passed 1", "passed 2"])).toBe(false);

    // Concurrency / race condition trace with timestamped logs
    const lines = Array.from({ length: 400 }, (_, i) => {
      if (i === 150) return `2026-09-08 10:00:${i} FATAL: race detected in lock acquisition`;
      if (i === 149) return `2026-09-08 10:00:${i} thread 2 acquiring lock`;
      if (i === 151) return `2026-09-08 10:00:${i} thread 1 panic on lock state`;
      return `2026-09-08 10:00:${i} benign heartbeat`;
    });

    const reduced = reduceToolOutput({
      toolName: "bash",
      input: { command: "docker logs service" },
      content: [{ type: "text", text: lines.join("\n") }],
      isError: true,
    });

    expect(reduced.changed).toBe(true);
    expect(reduced.compactedText).toContain("FATAL: race detected");
    // Neighboring temporal window lines around the incident should be captured
    expect(reduced.compactedText).toContain("thread 2 acquiring lock");
    expect(reduced.compactedText).toContain("thread 1 panic");
    expect(reduced.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);
  });
});

