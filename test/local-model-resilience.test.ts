import { readFile } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  CompactOptions,
  ExtensionAPI,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import {
  getInteropRegistry,
  registerInteropProvider,
  SAFE_AGENT_FABRIC_PROVIDER_NAME,
  type FabricStateSnapshotV1,
} from "../src/embedded/interop.js";
import { getSessionRecoveryStorage } from "../src/tool-output.js";

type Handler = (event: unknown, context: unknown) => unknown;

function makeHarness() {
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

function sampleHistory(contentChars = 32_000): SessionEntry[] {
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

function makeContext(
  tokens: number | null,
  contextWindow = 128_000,
  entries: SessionEntry[] = sampleHistory(),
  isIdle = true,
) {
  const notifications: Array<{ message: string; type: string }> = [];
  let statusValue: string | undefined;
  return {
    hasUI: true,
    mode: "json",
    cwd: "/workspace/project",
    model: { id: "qwen-2.5-coder-32b", contextWindow },
    isProjectTrusted: () => true,
    thinkingLevel: undefined,
    getContextUsage: () =>
      tokens === null
        ? { tokens: null, contextWindow, percent: null }
        : { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
    isIdle: () => isIdle,
    compact: vi.fn(),
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => "session-128k-local",
      getSessionFile: () => "/workspace/project/.pi/session.jsonl",
    },
    ui: {
      notify: (message: string, type: string) => {
        notifications.push({ message, type });
      },
      setStatus: (_key: string, status?: string) => {
        statusValue = status;
      },
    },
    notifications,
    getStatus: () => statusValue,
  };
}

describe("local-model failure injection & resilience (128k context)", () => {
  beforeEach(() => {
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  afterEach(() => {
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  it("Scenario 1: prefill/OOM failure on first compaction backs off cleanly without wedge", async () => {
    const harness = makeHarness();
    let compactOptions: CompactOptions | undefined;
    const context = makeContext(35_000, 64_000);
    context.compact = vi.fn((opts) => {
      compactOptions = opts;
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const turnStart = harness.handlers.get("turn_start")?.[0];
    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnStart?.({}, context);
    await turnEnd?.({}, context);

    // Threshold reached (35k >= 32k)
    expect(context.compact).toHaveBeenCalledTimes(1);
    expect(compactOptions).toBeDefined();

    // Simulate prefill CUDA OOM failure
    const oomError = new Error("CUDA out of memory: tried to allocate 4.2 GiB during compaction prefill");
    compactOptions?.onError?.(oomError);

    // UI notified with warning, session remains operative
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Context compaction failed"),
        type: "warning",
      }),
    );

    // Immediate next turn: cooldown prevents hammering the already-OOM model
    await turnStart?.({}, context);
    await turnEnd?.({}, context);
    expect(context.compact).toHaveBeenCalledTimes(1); // Not called again immediately
  });

  it("Scenario 2: transport termination during summary generation recovers fail-soft", async () => {
    const harness = makeHarness();
    let compactOptions: CompactOptions | undefined;
    const context = makeContext(35_000, 64_000);
    context.compact = vi.fn((opts) => {
      compactOptions = opts;
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const turnStart = harness.handlers.get("turn_start")?.[0];
    const turnEnd = harness.handlers.get("turn_end")?.[0];
    await turnStart?.({}, context);
    await turnEnd?.({}, context);

    expect(context.compact).toHaveBeenCalledTimes(1);

    // Simulate socket reset/drop during summary generation
    compactOptions?.onError?.(new Error("fetch failed: socket hang up / connection reset by peer"));
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("connection reset"),
        type: "warning",
      }),
    );
  });

  it("Scenario 3: compaction landing above classic rearm watermark rearms on epoch growth", async () => {
    const harness = makeHarness();
    let compactCalls = 0;
    // 64k window: threshold = 32_000, rearm watermark = 24_000
    const context = makeContext(33_000, 64_000);
    context.compact = vi.fn(() => {
      compactCalls += 1;
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const turnStart = harness.handlers.get("turn_start")?.[0];
    const turnEnd = harness.handlers.get("turn_end")?.[0];
    const sessionCompact = harness.handlers.get("session_compact")?.[0];

    // First compaction triggered at 33k
    await turnStart?.({}, context);
    await turnEnd?.({}, context);
    expect(compactCalls).toBe(1);

    // Compaction finishes with postTokens = 28_000 (above 24_000 rearm watermark)
    await sessionCompact?.(
      {
        compactionEntry: {
          type: "compaction",
          id: "comp-1",
          parentId: null,
          summary: "summary 1",
          firstKeptEntryId: "kept-1",
          tokensBefore: 33_000,
          timestamp: new Date().toISOString(),
        },
        reason: "manual",
      },
      makeContext(28_000, 64_000),
    );

    // Turn 2: context is 28_500 (small growth, in cooldown) -> no compaction
    const contextTurn2 = makeContext(28_500, 64_000);
    contextTurn2.compact = vi.fn(() => {
      compactCalls += 1;
    });
    await turnStart?.({}, contextTurn2);
    await turnEnd?.({}, contextTurn2);
    expect(compactCalls).toBe(1);

    // Turn 3: context grows to 32_500 (meaningful post-compaction epoch growth)
    // Gate must NOT retire itself even though tokens never fell to <= 24k!
    const contextTurn3 = makeContext(32_500, 64_000);
    contextTurn3.compact = vi.fn(() => {
      compactCalls += 1;
    });
    await turnStart?.({}, contextTurn3);
    await turnEnd?.({}, contextTurn3);
    expect(compactCalls).toBe(2);
  });

  it("Scenario 4: Pi overflow compaction returns undefined unconditionally to keep native preparation", async () => {
    const harness = makeHarness();
    const context = makeContext(64_000, 64_000);
    const sessionBeforeCompact = harness.handlers.get("session_before_compact")?.[0];
    expect(sessionBeforeCompact).toBeDefined();

    const overflowEvent: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      reason: "overflow",
      preparation: {
        settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 64_000,
        firstKeptEntryId: "entry-1",
      },
      branchEntries: [],
      willRetry: true,
      signal: new AbortController().signal,
    };

    const result = await sessionBeforeCompact?.(overflowEvent, context);
    expect(result).toBeUndefined();
  });

  it("Scenario 5: recovery copies survive across fork/resume session_shutdown and stay byte-readable", async () => {
    const harness = makeHarness();
    const storage = getSessionRecoveryStorage();

    const rawToolOutput = "important full log output lines\n".repeat(50);
    const savedPath = await storage.save(rawToolOutput, "pytest");
    expect(savedPath).toBeDefined();

    // Session shutdown emitted on fork or resume
    const sessionShutdown = harness.handlers.get("session_shutdown")?.[0];
    await sessionShutdown?.({}, makeContext(10_000));

    // File still exists and content matches byte-for-byte
    const content = await readFile(savedPath!, "utf8");
    expect(content).toBe(rawToolOutput);

    // Resumed session notes reference and reads copy
    const toolResult = harness.handlers.get("tool_result")?.[0];
    await toolResult?.(
      {
        toolName: "read",
        input: { path: savedPath },
        content: [{ type: "text", text: content }],
        isError: false,
      },
      makeContext(10_000),
    );

    // File was not pruned or deleted
    expect(storage.activeFilesCount).toBeGreaterThan(0);
    await storage.cleanup();
  });

  it("Scenario 6: context growth during active child fabric work defers semantic compaction until settled", async () => {
    const harness = makeHarness();
    const context = makeContext(10_000, 64_000);
    context.compact = vi.fn((options: any) => {
      options?.onComplete?.({ estimatedTokensAfter: 8_000 });
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    let isQuiescent = false;
    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn(() => {
        const snapshot: FabricStateSnapshotV1 = {
          version: 1,
          active: true,
          quiescent: isQuiescent,
          state: "known",
          sessionReplacementSafe: isQuiescent,
          rootSessionId: "session-128k-local",
          capturedAt: Date.now(),
          runningChildren: isQuiescent ? 0 : 2,
          unresolvedChildTasks: isQuiescent ? 0 : 1,
          mutableHolds: isQuiescent ? 0 : 1,
          activeWriteFences: 0,
          pendingRootRequests: 0,
          pendingRootDeliveries: 0,
          quiescenceReasons: isQuiescent ? [] : ["running_children_active"],
        };
        return snapshot;
      }),
    });

    // Semantic compaction requested after phase complete
    const compactionTool = harness.tools.find((t) => t.name === "request_context_compaction");
    await (compactionTool?.execute as any)("call-1", { reason: "Phase 1 complete" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);
    await flushImmediate();

    // Child tasks active: semantic compaction deferred
    expect(context.compact).not.toHaveBeenCalled();
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Semantic compaction deferred"),
        type: "info",
      }),
    );

    // Fabric transitions to quiescent
    isQuiescent = true;

    await agentSettled?.({}, context);
    await flushImmediate();

    // Now semantic compaction proceeds
    expect(context.compact).toHaveBeenCalledTimes(1);
  });
});
