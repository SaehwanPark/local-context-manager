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

function contextWithUsage(tokens: number | null, contextWindow = 64_000) {
  return {
    hasUI: false,
    mode: "json",
    cwd: process.cwd(),
    model: undefined,
    thinkingLevel: undefined,
    getContextUsage: () => (tokens === null ? { tokens: null, contextWindow, percent: null } : { tokens, contextWindow, percent: 50 }),
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
    expect(harness.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["request_context_compaction", "request_context_reset"]),
    );
    expect([...harness.commands.keys()]).toEqual(
      expect.arrayContaining([
        "context-stats",
        "context-mode",
        "compact-phase",
        "checkpoint-reset",
        "context-checkpoints",
        "handoff",
      ]),
    );
  });

  it("switches context mode for the current session", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(25_000);
    context.compact = () => {
      compactCalls += 1;
    };

    const modeCommand = harness.commands.get("context-mode")?.handler;
    expect(modeCommand).toBeDefined();
    await modeCommand?.("aggressive", context);

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);
  });

  it("ignores an invalid context mode without changing policy", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(25_000);
    context.compact = () => {
      compactCalls += 1;
    };

    const modeCommand = harness.commands.get("context-mode")?.handler;
    expect(modeCommand).toBeDefined();
    await modeCommand?.("turbo", context);

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(0);
  });

  it("queues a reset recommendation without switching sessions", async () => {
    const harness = makeExtensionHarness();
    const tool = harness.tools.find((candidate) => candidate.name === "request_context_reset");
    expect(tool?.execute).toBeDefined();

    const result = await (tool?.execute as (id: string, params: { reason?: string }) => Promise<Record<string, unknown>>)(
      "reset-1",
      { reason: "PR #123 merged" },
    );

    expect(result.details).toEqual({ queued: true, reason: "PR #123 merged" });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("No checkpoint was written") }),
    ]);
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

  it("lowers the proactive threshold for a constrained context window", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(17_000, 32_000);
    context.compact = () => {
      compactCalls += 1;
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);
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
