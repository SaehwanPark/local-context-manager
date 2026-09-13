import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFullOutputNotice,
  appendPrunedOutputNotice,
  cleanupRecoveryStorage,
  extractFullOutputPath,
  isLogOrEventStream,
  MAX_RETAINED_OUTPUT_CHARS,
  NON_EXHAUSTIVE_NOTICE,
  reduceToolOutput,
  saveRecoveryCopy,
  SessionRecoveryStorage,
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
    expect(reduced.compactedText).toContain("Exit status: non-zero");
    expect(reduced.compactedText).toContain('Code-like text in output: "code 2"');
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
    expect(diff.compactedText).toContain("Hunk headers:");
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

  it("creates recovery copies with file permissions 0600 and directory 0700", async () => {
    const text = "confidential diagnostic logs and tool outputs";
    const path = await saveRecoveryCopy(text, "test-tool");
    expect(path).toBeDefined();
    if (!path) return;

    try {
      const stats = await stat(path);
      if (process.platform !== "win32") {
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);

        const dirStats = await stat(dirname(path));
        const dirMode = dirStats.mode & 0o777;
        expect(dirMode).toBe(0o700);
      } else {
        // Windows: mode bits are not an access-control mechanism here;
        // NTFS ACLs govern permissions.
        expect(stats.isFile()).toBe(true);
      }
    } finally {
      await cleanupRecoveryStorage();
    }
  });

  it("bounds recovery storage by file count and bytes, and cleans up completely", async () => {
    const storage = new SessionRecoveryStorage({ maxFiles: 3, maxBytes: 10_000 });
    const p1 = await storage.save("file 1 content", "bash");
    await storage.save("file 2 content", "bash");
    await storage.save("file 3 content", "bash");
    expect(storage.activeFilesCount).toBe(3);

    // Saving a 4th file should prune the oldest (p1)
    const p4 = await storage.save("file 4 content", "bash");
    expect(storage.activeFilesCount).toBe(3);
    if (p1) {
      const p1Exists = await stat(p1).then(() => true).catch(() => false);
      expect(p1Exists).toBe(false);
    }
    if (p4) {
      const p4Exists = await stat(p4).then(() => true).catch(() => false);
      expect(p4Exists).toBe(true);
    }

    const dir = await storage.getDirectory();
    expect(await stat(dir).then(() => true).catch(() => false)).toBe(true);
    await storage.cleanup();
    expect(await stat(dir).then(() => true).catch(() => false)).toBe(false);
    expect(storage.activeFilesCount).toBe(0);
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

  it("bounds large diff reduction to the retained-output budget and notes truncated files", () => {
    const diffLines: string[] = [];
    for (let i = 0; i < 500; i++) {
      diffLines.push(
        `diff --git a/src/file_${i}.ts b/src/file_${i}.ts`,
        `index 1111111..2222222 100644`,
        `--- a/src/file_${i}.ts`,
        `+++ b/src/file_${i}.ts`,
        `@@ -1,5 +1,6 @@`,
        `+added line in file ${i}`,
        `-deleted line in file ${i}`,
        ` unchanged context line`,
      );
    }
    const reduced = reduceToolOutput({
      toolName: "bash",
      input: { command: "git diff main" },
      content: [{ type: "text", text: diffLines.join("\n") }],
      isError: false,
    });

    expect(reduced.changed).toBe(true);
    expect(reduced.category).toBe("diff");
    expect(reduced.compactedText.length).toBeLessThanOrEqual(MAX_RETAINED_OUTPUT_CHARS);
    expect(reduced.compactedText).toContain("Files changed: 500");
    expect(reduced.compactedText).toContain("per-file details truncated for");
    expect(reduced.compactedText).toContain("Hunk headers");
    expect(reduced.compactedText).toContain(NON_EXHAUSTIVE_NOTICE);
  });

  it("does not fabricate exit status 404 when stdout contains http status: 404", () => {
    const output = [
      "GET /api/v1/resource HTTP/1.1",
      "http status: 404 not found",
      "error: server responded with status 404",
      ...Array.from({ length: 800 }, (_, i) => `log detail line ${i}`),
    ].join("\n");

    const reduced = textResult(output, { isError: true });
    expect(reduced.category).toBe("failure");
    expect(reduced.compactedText).not.toContain("Exit status: 404");
    expect(reduced.compactedText).toContain("Exit status: non-zero");
    expect(reduced.compactedText).toContain("Code-like text in output:");
  });

  it("tracks recent references so LRU access keeps cited recovery copies alive through prune", async () => {
    const storage = new SessionRecoveryStorage({ maxFiles: 3, maxBytes: 10_000 });
    const p1 = await storage.save("file 1 content", "bash");
    const p2 = await storage.save("file 2 content", "bash");
    const p3 = await storage.save("file 3 content", "bash");
    expect(p1 && p2 && p3).toBeTruthy();

    // Access p1 so it becomes most recently used
    storage.noteReferences({ command: `cat ${p1}` });

    // Saving 4th file should now evict p2 instead of p1
    const p4 = await storage.save("file 4 content", "bash");
    expect(p4).toBeTruthy();

    const p1Exists = await stat(p1!).then(() => true).catch(() => false);
    const p2Exists = await stat(p2!).then(() => true).catch(() => false);
    expect(p1Exists).toBe(true);
    expect(p2Exists).toBe(false);

    // Finding pruned references
    const pruned = storage.findPrunedReferences({ command: `cat ${p2}` });
    expect(pruned).toContain(p2);

    await storage.cleanup();
  });

  it("appends an explicit expiration note when a tool input references a pruned recovery copy", () => {
    const content = [{ type: "text" as const, text: "Error: ENOENT: no such file or directory" }];
    const withPrunedNotice = appendPrunedOutputNotice(content, ["/tmp/pi-lcm-recovery-test/output-1.txt"]);
    expect((withPrunedNotice[0] as { type: "text"; text: string }).text).toContain(
      "was pruned by this session; the full output is no longer available",
    );
  });

  it("does not classify commands as build or search when keywords appear inside quoted arguments", () => {
    // 15 000 chars would trigger "build" if keywords in quotes matched, but should be null here
    const commitResult = textResult("detail line\n".repeat(1_200), {
      input: { command: "git commit -m 'find root cause of test failures'" },
      isError: false,
    });
    expect(commitResult.category).not.toBe("build");
    expect(commitResult.category).not.toBe("search");

    const echoResult = textResult("detail line\n".repeat(1_200), {
      input: { command: "echo cargo build failed" },
      isError: false,
    });
    expect(echoResult.category).not.toBe("build");

    const gitLogResult = textResult("detail line\n".repeat(1_200), {
      input: { command: "git log --oneline --grep=find" },
      isError: false,
    });
    expect(gitLogResult.category).not.toBe("search");

    // Very large output (> 2 * MAX_RETAINED_OUTPUT_CHARS) becomes generic, never build or search
    const largeCommit = textResult("detail line\n".repeat(2_500), {
      input: { command: "git commit -m 'find root cause of test failures'" },
      isError: false,
    });
    expect(largeCommit.category).toBe("generic");
  });

  it("recovers from external directory deletion by clearing tracked files from accounting", async () => {
    const storage = new SessionRecoveryStorage({ maxFiles: 5, maxBytes: 10_000 });
    await storage.save("file 1", "bash");
    await storage.save("file 2", "bash");
    expect(storage.activeFilesCount).toBe(2);

    const dir = await storage.getDirectory();
    // Simulate external removal of the directory
    await rm(dir, { recursive: true, force: true });

    // getDirectory() detects removal, clears dead entries, and allocates a new dir
    const newDir = await storage.getDirectory();
    expect(newDir).not.toBe(dir);
    expect(storage.activeFilesCount).toBe(0);

    await storage.cleanup();
  });
});

