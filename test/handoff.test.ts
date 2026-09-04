import { describe, expect, it } from "vitest";
import { buildFallbackHandoffPrompt, getActiveConversationText } from "../src/handoff.js";

const entry = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  parentId: null,
  type: "message" as const,
  message: {
    role,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  },
});

describe("handoff", () => {
  it("creates a structured conservative fallback without inventing facts", () => {
    const prompt = buildFallbackHandoffPrompt("finish the migration", "known path: src/index.ts\nverified: npm test");
    for (const heading of [
      "## Objective",
      "## Current Repository State",
      "## Decisions",
      "## Relevant Files",
      "## Completed Work",
      "## Verification",
      "## Remaining Work",
      "## Important Constraints",
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("finish the migration");
    expect(prompt).toContain("known path: src/index.ts");
  });

  it("limits an oversized fallback context while preserving head and tail", () => {
    const prompt = buildFallbackHandoffPrompt("continue", `${"head\n".repeat(10_000)}TAIL-MARKER`);
    expect(prompt).toContain("Fallback handoff omitted");
    expect(prompt).toContain("TAIL-MARKER");
  });

  it("serializes the active compaction-aware conversation through Pi helpers", () => {
    const ctx = {
      sessionManager: {
        buildContextEntries: () => [
          entry("u", "user", "Inspect src/index.ts"),
          entry("a", "assistant", "I inspected it"),
        ],
      },
    } as unknown as Parameters<typeof getActiveConversationText>[0];
    const text = getActiveConversationText(ctx);
    expect(text).toContain("Inspect src/index.ts");
    expect(text).toContain("I inspected it");
  });
});
