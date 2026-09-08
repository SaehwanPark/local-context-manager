import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  formatCoordinationState,
  formatRepositoryState,
  runCheckpointReset,
  type RepositoryState,
} from "../src/checkpoint-reset.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  FabricStateSnapshotV1,
  getInteropRegistry,
  registerInteropProvider,
  SAFE_AGENT_FABRIC_PROVIDER_NAME,
} from "../src/embedded/interop.js";
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
    compact: vi.fn(),
    sessionManager: {
      buildContextEntries: () => entries,
      getBranch: () => entries,
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
      getSnapshot: vi.fn().mockResolvedValue({
        active: true,
        quiescent: true,
        runningChildren: 0,
        unresolvedChildTasks: 0,
        mutableHolds: 0,
        pendingRootRequests: 0,
        pendingRootDeliveries: 0,
      }),
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
      getSnapshot: vi.fn().mockImplementation(() => ({
        active: true,
        quiescent: isQuiescent,
        runningChildren: 1,
        unresolvedChildTasks: 1,
        mutableHolds: 1,
        pendingRootRequests: 0,
        pendingRootDeliveries: 0,
        activeTasks: [{ id: "task-1", status: "running", owner: "child-agent" }],
      })),
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
      getSnapshot: vi.fn().mockResolvedValue({
        active: true,
        quiescent: false,
        runningChildren: 1,
        unresolvedChildTasks: 1,
        mutableHolds: 0,
        pendingRootRequests: 1,
        pendingRootDeliveries: 0,
      }),
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
      getSnapshot: vi.fn().mockResolvedValue({
        active: true,
        quiescent: false,
        runningChildren: 2,
        unresolvedChildTasks: 2,
        mutableHolds: 1,
        pendingRootRequests: 0,
        pendingRootDeliveries: 0,
      }),
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

  // Scenario E: User explicitly requests reset during child activity
  it("Scenario E: user explicitly requests reset during child activity - warns and persists coordination state", async () => {
    const fabricSnapshot: FabricStateSnapshotV1 = {
      active: true,
      quiescent: false,
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
      timestamp: Date.now(),
    };

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

    // 1. Verify formatCoordinationState and formatRepositoryState output
    const formattedCoord = formatCoordinationState(fabricSnapshot);
    expect(formattedCoord).toContain("### Coordination State");
    expect(formattedCoord).toContain("- Fabric: active");
    expect(formattedCoord).toContain("- Quiescent: no");
    expect(formattedCoord).toContain("- Running children: 2");
    expect(formattedCoord).toContain("- Active task T-12 [active], owner agent-4");
    expect(formattedCoord).toContain("- Mutable resource src/parser src/parser.ts, holder agent-4");

    const formattedRepo = formatRepositoryState(repoState, fabricSnapshot);
    expect(formattedRepo).toContain("Working directory: /work/project");
    expect(formattedRepo).toContain("### Coordination State");

    // 2. Verify runCheckpointReset warns about active delegated children
    const notifications: Array<{ message: string; type: string }> = [];
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
        custom: vi.fn().mockResolvedValue(null), // simulate aborted/cancelled generation
      },
    };

    await runCheckpointReset("Manual reset", fakeCtx as any, {
      config: DEFAULT_CONFIG,
      agentDir: "/tmp/agent-dir",
      runCommand: vi.fn(),
      previousResetCount: 0,
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Warning: Delegated child agents are still active"),
        type: "warning",
      }),
    );
  });
});
