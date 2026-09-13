import { stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CompactOptions, ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { getSessionRecoveryStorage } from "../src/tool-output.js";
import {
  getInteropRegistry,
  registerInteropProvider,
  SAFE_AGENT_FABRIC_PROVIDER_NAME,
} from "../src/embedded/interop.js";

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

  it("restores config file thresholds when /context-mode reset is invoked", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    const context = contextWithUsage(25_000, 64_000, compactionHistory());
    context.compact = () => {
      compactCalls += 1;
    };

    const modeCommand = harness.commands.get("context-mode")?.handler;
    expect(modeCommand).toBeDefined();

    await modeCommand?.("aggressive", context);

    await modeCommand?.("reset", context);

    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(0);
  });

  it("reports session override status and recovery prune count in /context-stats", async () => {
    const harness = makeExtensionHarness();
    const statsCommand = harness.commands.get("context-stats")?.handler;
    expect(statsCommand).toBeDefined();

    let notifyMessage = "";
    const mockContext = {
      ...contextWithUsage(10_000),
      hasUI: true,
      ui: {
        notify: (msg: string) => {
          notifyMessage = msg;
        },
      },
    } as unknown as ExtensionCommandContext;

    await statsCommand?.("", mockContext);
    expect(notifyMessage).toContain("Context mode: balanced (local-context-manager.json)");
    expect(notifyMessage).toContain("Recovery copies pruned: 0");

    const modeCommand = harness.commands.get("context-mode")?.handler;
    await modeCommand?.("aggressive", mockContext);

    await statsCommand?.("", mockContext);
    expect(notifyMessage).toContain(
      "Context mode: aggressive (session override; /context-mode reset restores local-context-manager.json)",
    );
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

  it("ignores a late completion event from a previous session", async () => {
    const harness = makeExtensionHarness();
    let compactCalls = 0;
    let secondOptions: CompactOptions | undefined;
    const firstContext = contextWithUsage(32_000, 64_000, compactionHistory());
    firstContext.compact = () => {
      compactCalls += 1;
    };
    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnEnd?.({}, firstContext);
    const compacted = harness.handlers.get("session_compact")?.[0];
    await compacted?.(
      {
        compactionEntry: {
          type: "compaction",
          id: "old-session-compaction",
          parentId: null,
          summary: "old checkpoint",
          firstKeptEntryId: "kept-1",
          tokensBefore: 32_000,
          timestamp: new Date().toISOString(),
        },
        reason: "manual",
      },
      contextWithUsage(1_000),
    );

    await harness.handlers.get("session_shutdown")?.[0]?.({}, firstContext);
    const secondContext = contextWithUsage(10_000, 64_000, compactionHistory());
    secondContext.compact = (options?: CompactOptions): void => {
      compactCalls += 1;
      secondOptions = options;
    };
    await harness.handlers.get("session_start")?.[0]?.({ reason: "reload" }, secondContext);
    const requestTool = harness.tools.find((candidate) => candidate.name === "request_context_compaction");
    await (requestTool?.execute as (id: string, params: { reason?: string }) => Promise<unknown>)("phase-1", {
      reason: "new phase",
    });
    const settled = harness.handlers.get("agent_settled")?.[0];
    await settled?.({}, secondContext);
    await flushImmediate();
    expect(compactCalls).toBe(2);

    await compacted?.(
      {
        compactionEntry: {
          type: "compaction",
          id: "old-session-compaction",
          parentId: null,
          summary: "old checkpoint",
          firstKeptEntryId: "kept-1",
          tokensBefore: 32_000,
          timestamp: new Date().toISOString(),
        },
        reason: "manual",
      },
      secondContext,
    );
    secondOptions?.onError?.(new Error("new compaction failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnStart?.({}, secondContext);
    await turnStart?.({}, secondContext);
    await settled?.({}, secondContext);
    await flushImmediate();
    expect(compactCalls).toBe(3);
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

  it("bypasses custom compaction for overflow compaction and non-semantic threshold compactions", async () => {
    const harness = makeExtensionHarness();
    const context = contextWithUsage(35_000, 64_000, compactionHistory());
    const sessionBeforeCompact = harness.handlers.get("session_before_compact")?.[0];
    expect(sessionBeforeCompact).toBeDefined();

    // 1. Overflow event: must return undefined unconditionally so Pi recovers natively
    const overflowResult = await sessionBeforeCompact?.(
      {
        reason: "overflow",
        preparation: { settings: { keepRecentTokens: 20_000 } },
        branchEntries: [],
      },
      context,
    );
    expect(overflowResult).toBeUndefined();

    // 2. Proactive threshold compaction without explicit semantic request: must return undefined
    const thresholdResult = await sessionBeforeCompact?.(
      {
        reason: "threshold",
        preparation: { settings: { keepRecentTokens: 20_000 } },
        branchEntries: [],
      },
      context,
    );
    expect(thresholdResult).toBeUndefined();
  });

  it("preserves recovery copies across session_shutdown (resume/fork lifecycle)", async () => {
    const harness = makeExtensionHarness();
    const context = contextWithUsage(10_000, 64_000);
    const storage = getSessionRecoveryStorage();

    const savedPath = await storage.save("essential tool result to survive across fork/resume", "bash");
    expect(savedPath).toBeDefined();
    expect(storage.activeFilesCount).toBeGreaterThan(0);

    const initialStat = await stat(savedPath!);
    expect(initialStat.isFile()).toBe(true);

    // Simulate session_shutdown (which Pi fires on fork, resume, reload, switch)
    const sessionShutdown = harness.handlers.get("session_shutdown")?.[0];
    expect(sessionShutdown).toBeDefined();
    await sessionShutdown?.({}, context);

    // Storage and files must survive
    const postShutdownStat = await stat(savedPath!);
    expect(postShutdownStat.isFile()).toBe(true);
    expect(storage.activeFilesCount).toBeGreaterThan(0);

    await storage.cleanup();
  });

  it("does not consume semanticRequested upon an unrelated threshold or auto compaction", async () => {
    const harness = makeExtensionHarness();
    const context = contextWithUsage(35_000, 64_000, compactionHistory());

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    // Request semantic compaction
    const compactionTool = harness.tools.find((t) => t.name === "request_context_compaction");
    await (compactionTool?.execute as any)("call-1", { reason: "Refactored module X" });

    // An unrelated auto/threshold compaction completes
    const sessionCompact = harness.handlers.get("session_compact")?.[0];
    await sessionCompact?.(
      {
        compactionEntry: {
          type: "compaction",
          id: "comp-auto-1",
          parentId: null,
          summary: "auto threshold summary",
          firstKeptEntryId: "kept-1",
          tokensBefore: 35_000,
          timestamp: new Date().toISOString(),
        },
        reason: "threshold",
      },
      contextWithUsage(20_000, 64_000, compactionHistory()),
    );

    // Settled boundary should still schedule the semantic compaction because it was not consumed
    let compactReason: string | undefined;
    const settledContext = contextWithUsage(20_000, 64_000, compactionHistory());
    settledContext.compact = (options: any) => {
      compactReason = options?.customInstructions;
    };

    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnStart?.({}, settledContext);
    await turnStart?.({}, settledContext);

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, settledContext);
    await flushImmediate();

    expect(compactReason).toBeDefined();
    expect(compactReason).toContain("Refactored module X");
  });

  it("skips fabric query in agent_settled when neither semantic compaction nor checkpoint reset is pending", async () => {
    const registry = getInteropRegistry();
    registry.providers.clear();

    const getSnapshot = vi.fn().mockResolvedValue({
      version: 1,
      active: false,
      quiescent: true,
      state: "known",
      sessionReplacementSafe: true,
      capturedAt: Date.now(),
      runningChildren: 0,
      unresolvedChildTasks: 0,
      mutableHolds: 0,
      activeWriteFences: 0,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
      quiescenceReasons: [],
    });
    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, { getSnapshot });

    const harness = makeExtensionHarness();
    const context = contextWithUsage(15_000, 64_000, compactionHistory());

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    // Ordinary settled boundary with no semantic compaction and no checkpoint reset
    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);
    await flushImmediate();

    // Fabric should NOT be queried
    expect(getSnapshot).not.toHaveBeenCalled();

    registry.providers.clear();
  });

  it("does not record evidence reduction when full output copy cannot be saved", async () => {
    const harness = makeExtensionHarness();
    const context = contextWithUsage(15_000, 64_000, compactionHistory());

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const storage = getSessionRecoveryStorage();
    const originalSave = storage.save.bind(storage);
    // Simulate save failure
    storage.save = vi.fn().mockResolvedValue(undefined);

    const toolResult = harness.handlers.get("tool_result")?.[0];
    const largeOutput = "error TS2322: type mismatch\n" + "build detail\n".repeat(500);
    const result = await toolResult?.(
      {
        toolName: "bash",
        input: { command: "npm test" },
        content: [{ type: "text", text: largeOutput }],
        isError: false,
      },
      context,
    );

    // Because save failed, tool_result preserves original content
    expect(result).toBeUndefined();

    storage.save = originalSave;
  });
});
