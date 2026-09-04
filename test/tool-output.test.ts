import { describe, expect, it } from "vitest";
import {
  appendFullOutputNotice,
  extractFullOutputPath,
  MAX_RETAINED_OUTPUT_CHARS,
  reduceToolOutput,
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
  });

  it("reduces a large build result while retaining diagnostics and a tail", () => {
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
  });

  it("reduces a very large unknown command conservatively as generic output", () => {
    const reduced = textResult("ordinary output\n".repeat(2_000), {
      input: { command: "python script.py" },
    });
    expect(reduced.changed).toBe(true);
    expect(reduced.category).toBe("generic");
  });

  it("prioritizes diagnostics in a failed command", () => {
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
  });

  it("summarizes search and diff output with query/file information", () => {
    const search = reduceToolOutput({
      toolName: "grep",
      input: { pattern: "TODO" },
      content: [{ type: "text", text: Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:${i}: TODO item`).join("\n") }],
      isError: false,
    });
    expect(search.category).toBe("search");
    expect(search.compactedText).toContain('Search query: "TODO"');

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
});
