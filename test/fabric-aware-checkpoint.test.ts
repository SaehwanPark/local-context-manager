import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  class TestLoader {
    readonly signal = new AbortController().signal;
    onAbort: (() => void) | undefined;
    constructor(_tui: unknown, _theme: unknown, _message: string) {}
    dispose(): void {}
  }
  return { ...actual, BorderedLoader: TestLoader };
});

import {
  formatCoordinationState,
  formatRepositoryState,
  getCheckpointStorageDirectory,
  listCheckpointFiles,
  runCheckpointReset,
  type RepositoryState,
} from "../src/checkpoint-reset.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  FabricSnapshotRequest,
  FabricStateSnapshotV1,
  getInteropRegistry,
  registerInteropProvider,
  SAFE_AGENT_FABRIC_PROVIDER_NAME,
} from "../src/embedded/interop.js";
import extension from "../src/index.js";

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function compactionHistory(contentChars = 32_000): SessionEntry[] {
  const content = [{ type: "text" as const, text: "x".repeat(contentChars) }];
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

function makeFabricSnapshot(overrides: Partial<FabricStateSnapshotV1> = {}): FabricStateSnapshotV1 {
  const active = overrides.active ?? true;
  const quiescent = overrides.quiescent ?? true;
  const state = overrides.state ?? "known";
  const sessionReplacementSafe = overrides.sessionReplacementSafe ?? (state === "known" && (active ? quiescent : true));
  return {
    version: 1,
    active,
    quiescent,
    state,
    sessionReplacementSafe,
    capturedAt: overrides.capturedAt ?? Date.now(),
    runningChildren: 0,
    unresolvedChildTasks: 0,
    mutableHolds: 0,
    activeWriteFences: 0,
    pendingRootRequests: 0,
    pendingRootDeliveries: 0,
    quiescenceReasons: quiescent ? [] : ["active_work"],
    timestamp: overrides.capturedAt ?? Date.now(),
    ...overrides,
  };
}

function makeContext(tokens: number | null, contextWindow = 64_000, entries: SessionEntry[] = []) {
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    hasUI: true,
    mode: "json",
    cwd: "/work/project",
    model: { contextWindow },
    isProjectTrusted: () => true,
    thinkingLevel: undefined,
    getContextUsage: () => ({
      tokens,
      contextWindow,
      percent: tokens ? (tokens / contextWindow) * 100 : 0,
    }),
    isIdle: () => true,
    compact: vi.fn((options: any) => {
      options?.onComplete?.({ estimatedTokensAfter: 8_000 });
    }),
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
      getSessionId: () => "sess-123",
      getSessionFile: () => "/work/project/session.jsonl",
    },
    ui: {
      notify: (message: string, type: string) => {
        notifications.push({ message, type });
      },
    },
    notifications,
  };
}

describe("Fabric-aware Checkpoint and Reset (Scenarios A-E)", () => {
  beforeEach(() => {
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  afterEach(() => {
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  // Scenario A: Clean episode
  it("Scenario A: clean episode - automatic reset proceeds when fabric is quiescent", async () => {
    const harness = makeExtensionHarness();
    const context = makeContext(10_000, 64_000);

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(makeFabricSnapshot()),
    });

    const resetTool = harness.tools.find((t) => t.name === "request_context_reset");
    await (resetTool?.execute as any)("call-1", { reason: "Phase 1 complete" });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    // Re-queue reset after session_start
    await (resetTool?.execute as any)("call-2", { reason: "Phase 1 complete" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);

    // Should proceed with recommendation, not deferred
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Checkpoint reset recommended (Phase 1 complete)"),
        type: "info",
      }),
    );
    expect(context.notifications).not.toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("deferred"),
      }),
    );
  });

  // Scenario B: Child still writing
  it("Scenario B: child still writing - defers semantic reset while active mutable hold present", async () => {
    const harness = makeExtensionHarness();
    const context = makeContext(10_000, 64_000);

    let isQuiescent = false;
    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockImplementation(() =>
        makeFabricSnapshot({
          active: true,
          quiescent: isQuiescent,
          runningChildren: isQuiescent ? 0 : 1,
          unresolvedChildTasks: isQuiescent ? 0 : 1,
          mutableHolds: isQuiescent ? 0 : 1,
          activeTasks: isQuiescent ? [] : [{ id: "task-1", status: "running", owner: "child-agent" }],
        }),
      ),
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const resetTool = harness.tools.find((t) => t.name === "request_context_reset");
    await (resetTool?.execute as any)("call-1", { reason: "Task done" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);

    // Notification must state recommendation is deferred
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Checkpoint reset recommendation deferred"),
        type: "info",
      }),
    );

    // Now simulate child finishing work: fabric becomes quiescent
    isQuiescent = true;
    context.notifications.length = 0;

    await agentSettled?.({}, context);

    // Now recommendation proceeds
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Checkpoint reset recommended (Task done)"),
        type: "info",
      }),
    );
  });

  // Scenario C: Child blocked on root
  it("Scenario C: child blocked on root - defers automatic reset when pendingRootRequests > 0", async () => {
    const harness = makeExtensionHarness();
    const context = makeContext(10_000, 64_000);

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(
        makeFabricSnapshot({
          active: true,
          quiescent: false,
          runningChildren: 0,
          unresolvedChildTasks: 0,
          mutableHolds: 0,
          pendingRootRequests: 1,
          pendingRootDeliveries: 0,
          quiescenceReasons: ["pending_root_requests"],
        }),
      ),
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const resetTool = harness.tools.find((t) => t.name === "request_context_reset");
    await (resetTool?.execute as any)("call-1", { reason: "Waiting on input" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);

    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Checkpoint reset recommendation deferred"),
        type: "info",
      }),
    );
  });

  // Scenario D: Hard ceiling during active child work
  it("Scenario D: hard ceiling during active child work - overrides deferral to protect context", async () => {
    const harness = makeExtensionHarness();
    // Context window 64k -> compactThreshold ~32k, hardCeiling ~54k (balanced profile)
    // Give 58_000 tokens to exceed hard ceiling
    const context = makeContext(58_000, 64_000);

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(
        makeFabricSnapshot({
          active: true,
          quiescent: false,
          runningChildren: 2,
          unresolvedChildTasks: 2,
          mutableHolds: 1,
          pendingRootRequests: 0,
          pendingRootDeliveries: 0,
        }),
      ),
    });

    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const resetTool = harness.tools.find((t) => t.name === "request_context_reset");
    await (resetTool?.execute as any)("call-1", { reason: "Urgent cleanup" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);

    // Hard ceiling safety override: recommendation proceeds with ceiling warning
    expect(context.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("hard ceiling reached; proceeding with fabric snapshot"),
        type: "info",
      }),
    );
  });

  const checkpointSections = [
    "## Goals\n- Keep the cache prefix stable.",
    "## Standing Constraints\n- Use TypeScript and Node built-ins.",
    "## Decisions and Rationale\n- Keep archive files outside the repository.",
    "## Work Completed\n- Added the reset flow.",
    "## Relevant Files\n- src/index.ts\n- src/checkpoint-reset.ts",
    "## Verification\n- npm test passed.",
    "## Problems Encountered\n- unknown",
    "## Rejected Approaches\n- Do not use automatic retrieval.",
    "## Unresolved Issues\n- The next feature is not selected.",
    "## Follow-ups\n- Continue the same project.",
    "## Historical Notes\n- The detailed episode remains in the parent session.",
  ].join("\n\n");

  const capsuleSections = [
    "## Active Goals\n- Continue maintaining the project.",
    "## Standing Constraints\n- Keep the active capsule small.",
    "## Durable Decisions\n- Historical details stay on disk.",
    "## Outstanding Work\n- Verify the next requested change.",
  ].join("\n\n");

  // Scenario E: User explicitly requests reset during child activity without --force
  it("Scenario E: user explicitly requests reset during child activity without --force - refuses reset with error and does not touch session", async () => {
    const fabricSnapshot: FabricStateSnapshotV1 = makeFabricSnapshot({
      active: true,
      quiescent: false,
      sessionReplacementSafe: false,
      runningChildren: 2,
      unresolvedChildTasks: 2,
      mutableHolds: 1,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
      activeTasks: [
        { id: "T-12", status: "active", owner: "agent-4", description: "running tests" },
        { id: "T-13", status: "blocked", owner: "agent-7" },
      ],
      mutableResources: [
        { id: "src/parser", path: "src/parser.ts", holder: "agent-4" },
      ],
      quiescenceReasons: ["running_children_active", "active_mutable_holds"],
      timestamp: Date.now(),
    });

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(fabricSnapshot),
    });

    const repoState: RepositoryState = {
      workingDirectory: "/work/project",
      repositoryRoot: "/work/project",
      branch: "main",
      head: "abcdef012345",
      workingTree: "clean",
    };

    // 1. Verify formatCoordinationState output (normal vs forced)
    const formattedCoord = formatCoordinationState(fabricSnapshot, false);
    expect(formattedCoord).toContain("### Coordination State");
    expect(formattedCoord).toContain("- Fabric: active");
    expect(formattedCoord).toContain("- Quiescent: no");
    expect(formattedCoord).toContain("- Running children: 2");
    expect(formattedCoord).toContain("- Active task T-12 [active], owner agent-4");
    expect(formattedCoord).toContain("- Mutable resource src/parser src/parser.ts, holder agent-4");
    expect(formattedCoord).not.toContain("FORCED during active child work");

    const formattedForced = formatCoordinationState(fabricSnapshot, true);
    expect(formattedForced).toContain("FORCED during active child work");
    expect(formattedForced).toContain("Episode completion: partial");

    const formattedRepo = formatRepositoryState(repoState, fabricSnapshot);
    expect(formattedRepo).toContain("Working directory: /work/project");
    expect(formattedRepo).toContain("### Coordination State");

    // 2. Verify runCheckpointReset refuses reset without --force
    const notifications: Array<{ message: string; type: string }> = [];
    const newSession = vi.fn();
    const fakeCtx = {
      mode: "tui" as const,
      cwd: "/work/project",
      model: { id: "test-model" },
      modelRegistry: {
        hasConfiguredAuth: () => true,
      },
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "sess-test",
        getSessionFile: () => "/work/project/session.jsonl",
        buildContextEntries: () => [
          {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: "Please implement feature X and coordinate child agents." }],
            },
          },
        ],
      },
      ui: {
        notify: (msg: string, type: string) => {
          notifications.push({ message: msg, type });
        },
      },
      newSession,
    };

    await runCheckpointReset("Manual reset", fakeCtx as any, {
      config: DEFAULT_CONFIG,
      agentDir: "/tmp/agent-dir",
      runCommand: vi.fn(),
      previousResetCount: 0,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Cannot reset checkpoint: Delegated child work is active in safe-agent-team"),
        type: "error",
      }),
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  // Scenario E2: User explicitly requests reset with --force during child activity
  it("Scenario E2: user explicitly requests reset with --force during child activity - prompts confirm and proceeds with forced snapshot", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lcm-test-force-reset-"));
    try {
      const fabricSnapshot: FabricStateSnapshotV1 = makeFabricSnapshot({
        active: true,
        quiescent: false,
        sessionReplacementSafe: false,
        runningChildren: 2,
        unresolvedChildTasks: 1,
        mutableHolds: 0,
        pendingRootRequests: 0,
        pendingRootDeliveries: 0,
        activeTasks: [{ id: "T-1", status: "running", owner: "child-worker" }],
        quiescenceReasons: ["running_children_active"],
        timestamp: Date.now(),
      });

      registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
        getSnapshot: vi.fn().mockResolvedValue(fabricSnapshot),
      });

      const responses = [checkpointSections, capsuleSections];
      const notifications: Array<{ message: string; type: string }> = [];
      const confirms: Array<{ title: string; message: string }> = [];
      const newSession = vi.fn().mockResolvedValue(undefined);

      const fakeCtx = {
        mode: "tui" as const,
        cwd: tempDir,
        model: { id: "test-model", maxTokens: 16_384 },
        modelRegistry: {
          hasConfiguredAuth: () => true,
          complete: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: responses.shift() ?? "" }],
          })),
        },
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => "sess-test",
          getSessionFile: () => join(tempDir, "session.jsonl"),
          buildContextEntries: () => [
            {
              type: "message",
              id: "m1",
              parentId: null,
              timestamp: new Date().toISOString(),
              message: {
                role: "user",
                content: [{ type: "text", text: "Implement work with subagent" }],
              },
            },
          ],
        },
        ui: {
          notify: (msg: string, type: string) => {
            notifications.push({ message: msg, type });
          },
          confirm: vi.fn(async (title: string, message: string) => {
            confirms.push({ title, message });
            return true;
          }),
          custom: vi.fn(async (factory: any) => {
            return new Promise<unknown>((resolve) => {
              factory(undefined, { fg: (_n: string, t: string) => t }, {}, resolve);
            });
          }),
          editor: vi.fn(async (_title: string, prefill?: string) => prefill),
        },
        newSession,
      };

      await runCheckpointReset("--force", fakeCtx as any, {
        config: { ...DEFAULT_CONFIG, checkpointDirectory: tempDir },
        agentDir: tempDir,
        runCommand: vi.fn(async (_cmd, args) => {
          const key = args.join(" ");
          if (key.includes("rev-parse --show-toplevel")) return { stdout: tempDir, stderr: "", code: 0 };
          if (key.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "main", stderr: "", code: 0 };
          if (key.includes("rev-parse HEAD")) return { stdout: "abcdef123", stderr: "", code: 0 };
          if (key.includes("status --porcelain")) return { stdout: "", stderr: "", code: 0 };
          return { stdout: "", stderr: "", code: 0 };
        }),
        previousResetCount: 0,
      });

      expect(confirms.length).toBe(2);
      expect(confirms[0].title).toBe("Warning: Active child agents detected");
      expect(confirms[1].title).toBe("Approve checkpoint reset?");
      expect(newSession).toHaveBeenCalledTimes(1);

      const storage = getCheckpointStorageDirectory(
        { ...DEFAULT_CONFIG, checkpointDirectory: tempDir },
        tempDir,
        tempDir,
        { workingDirectory: tempDir, repositoryRoot: tempDir, branch: "main", head: "abcdef123", workingTree: "clean" },
      );
      const files = await listCheckpointFiles(storage);
      expect(files.length).toBe(1);
      const content = await readFile(files[0].path, "utf8");
      expect(content).toContain("FORCED during active child work");
      expect(content).toContain("Forced: yes");
      expect(content).toContain("Episode completion: partial");

      const sessionOptions = newSession.mock.calls[0]?.[0];
      const fakeReplacementCtx = { ui: { setEditorText: vi.fn(), notify: vi.fn() } };
      await sessionOptions?.withSession(fakeReplacementCtx);
      expect(fakeReplacementCtx.ui.setEditorText).toHaveBeenCalledWith(
        expect.stringContaining("FORCED during active child work"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario E3: User requests reset with --force during child activity but declines confirm
  it("Scenario E3: user requests reset with --force during child activity but declines confirm - aborts reset", async () => {
    const fabricSnapshot: FabricStateSnapshotV1 = makeFabricSnapshot({
      active: true,
      quiescent: false,
      sessionReplacementSafe: false,
      runningChildren: 1,
      unresolvedChildTasks: 1,
      mutableHolds: 0,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
    });

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(fabricSnapshot),
    });

    const notifications: Array<{ message: string; type: string }> = [];
    const newSession = vi.fn();
    const fakeCtx = {
      mode: "tui" as const,
      cwd: "/work/project",
      model: { id: "test-model" },
      modelRegistry: { hasConfiguredAuth: () => true },
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "sess-test",
        getSessionFile: () => "/work/project/session.jsonl",
        buildContextEntries: () => [
          {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: "Please implement feature X and coordinate child agents." }],
            },
          },
        ],
      },
      ui: {
        notify: (msg: string, type: string) => {
          notifications.push({ message: msg, type });
        },
        confirm: vi.fn().mockResolvedValue(false),
      },
      newSession,
    };

    await runCheckpointReset("-f force attempt", fakeCtx as any, {
      config: DEFAULT_CONFIG,
      agentDir: "/tmp/agent-dir",
      runCommand: vi.fn(),
      previousResetCount: 0,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Checkpoint reset cancelled; active children and context preserved."),
        type: "info",
      }),
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  // Scenario E4: Fabric provider throws or is uncertain
  it("Scenario E4: fabric provider throws while registered - fails closed without --force", async () => {
    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockRejectedValue(new Error("Broker unreachable")),
    });

    const notifications: Array<{ message: string; type: string }> = [];
    const newSession = vi.fn();
    const fakeCtx = {
      mode: "tui" as const,
      cwd: "/work/project",
      model: { id: "test-model" },
      modelRegistry: { hasConfiguredAuth: () => true },
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "sess-test",
        getSessionFile: () => "/work/project/session.jsonl",
        buildContextEntries: () => [
          {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: "Please implement feature X and coordinate child agents." }],
            },
          },
        ],
      },
      ui: {
        notify: (msg: string, type: string) => {
          notifications.push({ message: msg, type });
        },
        confirm: vi.fn().mockResolvedValue(true),
      },
      newSession,
    };

    await runCheckpointReset("attempt reset", fakeCtx as any, {
      config: DEFAULT_CONFIG,
      agentDir: "/tmp/agent-dir",
      runCommand: vi.fn(),
      previousResetCount: 0,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Safe-agent fabric is registered but state query failed or is uncertain"),
        type: "error",
      }),
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  // Scenario F: Semantic compaction deferral
  it("Scenario F: defers semantic compaction when fabric is active and non-quiescent, keeping threshold compaction independent", async () => {
    const harness = makeExtensionHarness();
    let isQuiescent = false;

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockImplementation(() =>
        makeFabricSnapshot({
          active: true,
          quiescent: isQuiescent,
          sessionReplacementSafe: isQuiescent,
          runningChildren: isQuiescent ? 0 : 1,
          unresolvedChildTasks: isQuiescent ? 0 : 1,
          mutableHolds: 0,
          pendingRootRequests: 0,
          pendingRootDeliveries: 0,
        }),
      ),
    });

    // Sub-case 1: Context tokens below threshold, semantic compaction requested
    // Expect: semantic compaction deferred, context.compact NOT called
    const context1 = makeContext(10_000, 64_000, compactionHistory());
    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context1);

    const compactionTool = harness.tools.find((t) => t.name === "request_context_compaction");
    await (compactionTool?.execute as any)("call-1", { reason: "Refactored module A" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context1);
    await flushImmediate();

    expect(context1.notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Semantic compaction deferred: delegated child agents are still active."),
        type: "info",
      }),
    );
    expect(context1.compact).not.toHaveBeenCalled();

    // Sub-case 2: Context tokens EXCEED threshold while fabric is still non-quiescent
    // Expect: threshold compaction proceeds independently!
    const context2 = makeContext(60_000, 64_000, compactionHistory());
    await agentSettled?.({}, context2);
    await flushImmediate();
    expect(context2.compact).toHaveBeenCalled();

    // Sub-case 3: Fabric becomes quiescent -> semantic compaction executes at next settled boundary
    isQuiescent = true;
    const turnStart = harness.handlers.get("turn_start")?.[0];
    await turnStart?.({}, context2);
    await turnStart?.({}, context2);

    const context3 = makeContext(10_000, 64_000, compactionHistory());
    await agentSettled?.({}, context3);
    await flushImmediate();
    expect(context3.compact).toHaveBeenCalled();
  });

  // Scenario G: Scoping contract - getSessionId() is supplied, NOT getSessionFile()
  it("Scenario G: fabric query uses getSessionId() for scoping and reserves getSessionFile() for parentSession lineage", async () => {
    let capturedQuerySessionId: string | undefined;
    const provider = {
      getSnapshot: vi.fn().mockImplementation((req: FabricSnapshotRequest) => {
        capturedQuerySessionId = req.sessionId;
        if (req.sessionId !== "actual-pi-session-id") {
          return null; // safe-agent rejects mismatched ID
        }
        return makeFabricSnapshot();
      }),
    };
    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, provider);

    const fakeCtx = {
      mode: "tui" as const,
      cwd: "/work/project",
      model: { id: "test-model" },
      modelRegistry: { hasConfiguredAuth: () => true },
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "actual-pi-session-id",
        getSessionFile: () => "/work/project/sessions/actual-pi-session-id.jsonl",
        buildContextEntries: () => [
          {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: [{ type: "text", text: "Test reset session ID scoping" }] },
          },
        ],
      },
      ui: {
        notify: vi.fn(),
        confirm: vi.fn().mockResolvedValue(false), // decline reset so it doesn't write
      },
      newSession: vi.fn(),
    };

    await runCheckpointReset("scope test", fakeCtx as any, {
      config: DEFAULT_CONFIG,
      agentDir: "/tmp/agent-dir",
      runCommand: vi.fn(),
      previousResetCount: 0,
    });

    expect(capturedQuerySessionId).toBe("actual-pi-session-id");
    expect(capturedQuerySessionId).not.toBe("/work/project/sessions/actual-pi-session-id.jsonl");
  });

  // Scenario H: sessionReplacementSafe: false blocks reset even if runningChildren is 0
  it("Scenario H: sessionReplacementSafe: false blocks reset even if child counters are 0", async () => {
    const unreplacableSnapshot = makeFabricSnapshot({
      active: true,
      quiescent: false,
      state: "known",
      sessionReplacementSafe: false,
      runningChildren: 0,
      unresolvedChildTasks: 0,
      mutableHolds: 0,
      activeWriteFences: 2, // Fences prevent session replacement!
      quiescenceReasons: ["active_write_fences"],
    });

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(unreplacableSnapshot),
    });

    const notifications: Array<{ message: string; type: string }> = [];
    const newSession = vi.fn();
    const fakeCtx = {
      mode: "tui" as const,
      cwd: "/work/project",
      model: { id: "test-model" },
      modelRegistry: { hasConfiguredAuth: () => true },
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => "sess-123",
        getSessionFile: () => "/work/project/session.jsonl",
        buildContextEntries: () => [
          {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: [{ type: "text", text: "Test fence safety" }] },
          },
        ],
      },
      ui: {
        notify: (msg: string, type: string) => {
          notifications.push({ message: msg, type });
        },
      },
      newSession,
    };

    await runCheckpointReset("fence test", fakeCtx as any, {
      config: DEFAULT_CONFIG,
      agentDir: "/tmp/agent-dir",
      runCommand: vi.fn(),
      previousResetCount: 0,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Cannot reset checkpoint: Delegated child work is active in safe-agent-team"),
        type: "error",
      }),
    );
    expect(notifications[0].message).toContain("2 write fence(s)");
    expect(newSession).not.toHaveBeenCalled();
  });

  // Scenario I: Forced reset under provider query failure durably preserves uncertain status in archive
  it("Scenario I: forced reset with provider query failure durably records uncertain coordination in archive", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lcm-test-uncertain-force-"));
    try {
      registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
        getSnapshot: vi.fn().mockRejectedValue(new Error("Simulated broker crash")),
      });

      const checkpointSections = [
        "## Goals\n- Test durability under uncertain provider.",
        "## Standing Constraints\n- none",
        "## Decisions and Rationale\n- force reset anyway",
        "## Work Completed\n- work",
        "## Relevant Files\n- none",
        "## Verification\n- verify",
        "## Problems Encountered\n- broker crashed",
        "## Rejected Approaches\n- none",
        "## Unresolved Issues\n- uncertain child state",
        "## Follow-ups\n- none",
        "## Historical Notes\n- none",
      ].join("\n\n");
      const capsuleSections = [
        "## Active Goals\n- Test durability under uncertain provider.",
        "## Standing Constraints\n- none",
        "## Durable Decisions\n- force reset anyway",
        "## Outstanding Work\n- none",
      ].join("\n\n");

      const responses = [checkpointSections, capsuleSections];
      const newSession = vi.fn().mockResolvedValue(undefined);

      const fakeCtx = {
        mode: "tui" as const,
        cwd: tempDir,
        model: { id: "test-model", maxTokens: 16_384 },
        modelRegistry: {
          hasConfiguredAuth: () => true,
          complete: vi.fn(async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: responses.shift() ?? "" }],
          })),
        },
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => "sess-123",
          getSessionFile: () => join(tempDir, "session.jsonl"),
          buildContextEntries: () => [
            {
              type: "message",
              id: "m1",
              parentId: null,
              timestamp: new Date().toISOString(),
              message: { role: "user", content: [{ type: "text", text: "Force reset test" }] },
            },
          ],
        },
        ui: {
          notify: vi.fn(),
          confirm: vi.fn().mockResolvedValue(true),
          custom: vi.fn(async (factory: any) => {
            return new Promise<unknown>((resolve) => {
              factory(undefined, { fg: (_n: string, t: string) => t }, {}, resolve);
            });
          }),
          editor: vi.fn(async (_title: string, prefill?: string) => prefill),
        },
        newSession,
      };

      await runCheckpointReset("--force forced with failed provider", fakeCtx as any, {
        config: { ...DEFAULT_CONFIG, checkpointDirectory: tempDir },
        agentDir: tempDir,
        runCommand: vi.fn(async (_cmd, args) => {
          const key = args.join(" ");
          if (key.includes("rev-parse --show-toplevel")) return { stdout: tempDir, stderr: "", code: 0 };
          if (key.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "main", stderr: "", code: 0 };
          if (key.includes("rev-parse HEAD")) return { stdout: "abcdef123", stderr: "", code: 0 };
          if (key.includes("status --porcelain")) return { stdout: "", stderr: "", code: 0 };
          return { stdout: "", stderr: "", code: 0 };
        }),
        previousResetCount: 0,
      });

      expect(newSession).toHaveBeenCalledTimes(1);

      const storage = getCheckpointStorageDirectory(
        { ...DEFAULT_CONFIG, checkpointDirectory: tempDir },
        tempDir,
        tempDir,
        { workingDirectory: tempDir, repositoryRoot: tempDir, branch: "main", head: "abcdef123", workingTree: "clean" },
      );
      const files = await listCheckpointFiles(storage);
      expect(files.length).toBe(1);
      const content = await readFile(files[0].path, "utf8");

      expect(content).toContain("Coordination: uncertain (FORCED reset)");
      expect(content).toContain("Reset status: FORCED while coordination safety state was UNCERTAIN");
      expect(content).toContain("Uncertainty reason: Fabric query threw error: Simulated broker crash");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // Scenario J: agent_settled handles transient root-only lag without deferring semantic compaction
  it("Scenario J: agent_settled does not defer semantic compaction when the only quiescence reason is root_agent_active_or_running", async () => {
    const harness = makeExtensionHarness();

    // Fabric reports active with ONLY root_agent_active_or_running, while child counters are 0
    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(
        makeFabricSnapshot({
          active: true,
          quiescent: false,
          sessionReplacementSafe: false,
          runningChildren: 0,
          unresolvedChildTasks: 0,
          mutableHolds: 0,
          activeWriteFences: 0,
          pendingRootRequests: 0,
          pendingRootDeliveries: 0,
          quiescenceReasons: ["root_agent_active_or_running"],
        }),
      ),
    });

    const context = makeContext(10_000, 64_000, compactionHistory());
    const sessionStart = harness.handlers.get("session_start")?.[0];
    await sessionStart?.({}, context);

    const compactionTool = harness.tools.find((t) => t.name === "request_context_compaction");
    await (compactionTool?.execute as any)("call-1", { reason: "Phase complete" });

    const agentSettled = harness.handlers.get("agent_settled")?.[0];
    await agentSettled?.({}, context);
    await flushImmediate();

    // Semantic compaction should NOT be deferred because Pi itself emitted agent_settled
    expect(context.notifications).not.toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Semantic compaction deferred: delegated child agents are still active."),
      }),
    );
    expect(context.compact).toHaveBeenCalled();
  });
});
