import { describe, expect, it } from "vitest";
import type { CompactOptions, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
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

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function contextWithUsage(tokens: number | null, contextWindow = 64_000, entries: SessionEntry[] = []) {
  return {
    hasUI: false,
    mode: "json",
    cwd: process.cwd(),
    model: undefined,
    isProjectTrusted: () => true,
    thinkingLevel: undefined,
    getContextUsage: () => (tokens === null ? { tokens: null, contextWindow, percent: null } : { tokens, contextWindow, percent: 50 }),
    isIdle: () => true,
    compact: (_options?: CompactOptions): void => {},
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
    },
  };
}

function compactionHistory(contentChars = 32_000): SessionEntry[] {
  const content = [{ type: "text", text: "x".repeat(contentChars) }];
  return [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content, timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: new Date(2).toISOString(),
      message: { role: "assistant", content, timestamp: 2 },
    },
    {
      type: "message",
      id: "user-2",
      parentId: "assistant-1",
      timestamp: new Date(3).toISOString(),
      message: { role: "user", content, timestamp: 3 },
    },
    {
      type: "message",
      id: "assistant-2",
      parentId: "user-2",
      timestamp: new Date(4).toISOString(),
      message: { role: "assistant", content, timestamp: 4 },
    },
  ] as SessionEntry[];
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
    const context = contextWithUsage(25_000, 64_000, compactionHistory());
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
    const context = contextWithUsage(17_000, 32_000, compactionHistory());
    context.compact = () => {
      compactCalls += 1;
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);
  });

  it("does not start compaction when Pi has no summarizable history", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000);
    context.compact = () => {
      compactCalls += 1;
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(0);
  });

  it("does not trigger below Pi's native compaction floor", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(17_000, 32_000, compactionHistory(16_000));
    context.compact = () => {
      compactCalls += 1;
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(0);
  });

  it("does not let an unrelated native failure disable proactive requests", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000, 64_000, compactionHistory());
    context.compact = () => {
      compactCalls += 1;
    };

    const failed = harness.handlers.get("session_compact_failed")?.[0];
    await failed?.({ reason: "threshold", errorMessage: "native failure" }, context);
    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);
  });

  it("keeps later turns alive when asynchronous compaction fails", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000, 64_000, compactionHistory());
    context.compact = (options?: CompactOptions): void => {
      compactCalls += 1;
      queueMicrotask(() => options?.onError?.(new Error("transient compaction failure")));
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(compactCalls).toBe(1);

    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);
  });

  it("retains a semantic request after an asynchronous compaction failure", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000, 64_000, compactionHistory());
    context.compact = (options?: CompactOptions): void => {
      compactCalls += 1;
      queueMicrotask(() => options?.onError?.(new Error("transient compaction failure")));
    };

    const requestTool = harness.tools.find((candidate) => candidate.name === "request_context_compaction");
    await (requestTool?.execute as (id: string, params: { reason?: string }) => Promise<unknown>)("phase-1", {
      reason: "phase one complete",
    });
    const settled = harness.handlers.get("agent_settled")?.[0];
    await settled?.({}, context);
    await flushImmediate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(compactCalls).toBe(1);

    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnStart?.({}, context);
    await turnStart?.({}, context);
    await settled?.({}, context);
    await flushImmediate();
    expect(compactCalls).toBe(2);
  });

  it("retains a semantic request after a native failure event", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000, 64_000, compactionHistory());
    context.compact = (): void => {
      compactCalls += 1;
    };

    const requestTool = harness.tools.find((candidate) => candidate.name === "request_context_compaction");
    await (requestTool?.execute as (id: string, params: { reason?: string }) => Promise<unknown>)("phase-1", {
      reason: "phase one complete",
    });
    const settled = harness.handlers.get("agent_settled")?.[0];
    await settled?.({}, context);
    await flushImmediate();
    expect(compactCalls).toBe(1);

    const failed = harness.handlers.get("session_compact_failed")?.[0];
    await failed?.({ reason: "manual", errorMessage: "native failure" }, context);
    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnStart?.({}, context);
    await turnStart?.({}, context);
    await settled?.({}, context);
    await flushImmediate();
    expect(compactCalls).toBe(2);
  });

  it("contains stale-context errors from a current compaction failure callback", async () => {
    const harness = makeExtensionHarness();
    const context = contextWithUsage(32_000, 64_000, compactionHistory());
    let stale = false;
    Object.defineProperty(context, "hasUI", {
      get: () => {
        if (stale) throw new Error("stale context");
        return false;
      },
    });
    context.compact = (options?: CompactOptions): void => {
      stale = true;
      queueMicrotask(() => options?.onError?.(new Error("transient compaction failure")));
    };

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("isolates a settled compaction when the session is replaced", async () => {
    const harness = makeExtensionHarness();
    let firstOptions: CompactOptions | undefined;
    const firstContext = contextWithUsage(32_000, 64_000, compactionHistory());
    firstContext.compact = (options?: CompactOptions): void => {
      firstOptions = options;
    };

    const settled = harness.handlers.get("agent_settled")?.[0];
    await settled?.({}, firstContext);
    await flushImmediate();
    expect(firstOptions?.onError).toBeDefined();

    const shutdown = harness.handlers.get("session_shutdown")?.[0];
    await shutdown?.({}, firstContext);
    await harness.handlers.get("session_start")?.[0]?.({ reason: "reload" }, contextWithUsage(1_000));

    expect(() => firstOptions?.onError?.(new Error("stale settled failure"))).not.toThrow();
  });

  it("ignores a late failure callback from a previous session", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    let firstOptions: CompactOptions | undefined;
    let secondOptions: CompactOptions | undefined;
    const firstContext = contextWithUsage(32_000, 64_000, compactionHistory());
    firstContext.compact = (options?: CompactOptions): void => {
      compactCalls += 1;
      firstOptions = options;
    };
    const sessionStart = harness.handlers.get("session_start")?.[0];
    const turnEnd = harness.handlers.get("turn_end")?.[0];
    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnEnd?.({}, firstContext);

    const secondContext = contextWithUsage(32_000, 64_000, compactionHistory());
    secondContext.compact = (options?: CompactOptions): void => {
      compactCalls += 1;
      secondOptions = options;
    };
    await sessionStart?.({ reason: "reload" }, secondContext);
    await turnEnd?.({}, secondContext);
    expect(compactCalls).toBe(2);
    expect(firstOptions?.onError).toBeDefined();
    expect(secondOptions?.onComplete).toBeDefined();

    firstOptions?.onError?.(new Error("stale compaction failure"));
    (firstOptions?.onComplete as ((result: { estimatedTokensAfter: number }) => void) | undefined)?.({
      estimatedTokensAfter: 1_000,
    });
    (secondOptions?.onComplete as ((result: { estimatedTokensAfter: number }) => void) | undefined)?.({
      estimatedTokensAfter: 1_000,
    });
    await turnStart?.({}, secondContext);
    await turnStart?.({}, secondContext);
    await turnEnd?.({}, secondContext);
    expect(compactCalls).toBe(3);
  });

  it("requests one proactive compaction at a safe boundary", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(32_000, 64_000, compactionHistory());
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
        reason: "manual",
      },
      contextWithUsage(1_000),
    );

    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnStart?.({}, context);
    await turnStart?.({}, context);
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(2);
  });
});
