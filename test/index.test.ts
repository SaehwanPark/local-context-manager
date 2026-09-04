import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

type Handler = (event: unknown, context: unknown) => unknown;

function makeExtensionHarness() {
  const handlers = new Map<string, Handler[]>();
  const tools: Array<Record<string, unknown>> = [];
  const commands = new Map<string, { handler: Handler }>();
  const api = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    registerCommand(name: string, options: { handler: Handler }) {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  extension(api);
  return { handlers, tools, commands };
}

function contextWithUsage(tokens: number | null) {
  return {
    hasUI: false,
    mode: "json",
    cwd: process.cwd(),
    model: undefined,
    thinkingLevel: undefined,
    getContextUsage: () => (tokens === null ? { tokens: null, contextWindow: 64_000, percent: null } : { tokens, contextWindow: 64_000, percent: 50 }),
    isIdle: () => true,
    compact: () => undefined,
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
    },
  };
}

describe("extension integration", () => {
  it("registers native lifecycle hooks, tools, and commands", () => {
    const harness = makeExtensionHarness();
    expect(harness.handlers.has("session_start")).toBe(true);
    expect(harness.handlers.has("turn_end")).toBe(true);
    expect(harness.handlers.has("agent_settled")).toBe(true);
    expect(harness.handlers.has("session_before_compact")).toBe(true);
    expect(harness.handlers.has("tool_result")).toBe(true);
    expect(harness.tools.map((tool) => tool.name)).toContain("request_context_compaction");
    expect([...harness.commands.keys()]).toEqual(expect.arrayContaining(["context-stats", "compact-phase", "handoff"]));
  });

  it("does not compact while a turn is still active", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000);
    context.isIdle = () => false;
    context.compact = () => {
      compactCalls += 1;
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(0);
  });

  it("requests one proactive compaction at a safe boundary", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000);
    context.compact = () => {
      compactCalls += 1;
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    expect(turnEnd).toBeDefined();
    await turnEnd?.({}, context);
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);

    const compacted = harness.handlers.get("session_compact")?.[0];
    expect(compacted).toBeDefined();
    await compacted?.(
      {
        compactionEntry: {
          type: "compaction",
          id: "compact-1",
          parentId: null,
          summary: "checkpoint",
          firstKeptEntryId: "kept-1",
          tokensBefore: 32_000,
          timestamp: new Date().toISOString(),
        },
        reason: "threshold",
      },
      contextWithUsage(null),
    );
  });
});
