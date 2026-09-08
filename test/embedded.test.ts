import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedContextManager,
  EmbeddedContextHost,
  EmbeddedToolResult,
  getInteropProvider,
  getInteropRegistry,
  LCM_EMBEDDED_CONTEXT_PROVIDER_NAME,
  registerEmbeddedContextManagerProvider,
} from "../src/embedded/index.js";
import { EVIDENCE_COMPLETENESS_NOTE } from "../src/evidence-provenance.js";
import { NON_EXHAUSTIVE_NOTICE } from "../src/tool-output.js";

describe("EmbeddedContextManager", () => {
  beforeEach(() => {
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  function createMockHost(overrides: Partial<EmbeddedContextHost> = {}): EmbeddedContextHost {
    return {
      getContextUsage: vi.fn().mockReturnValue({
        tokens: 15_000,
        contextWindow: 128_000,
        source: "reported",
      }),
      getContextEntries: vi.fn().mockReturnValue([]),
      compact: vi.fn().mockResolvedValue(undefined),
      onStatus: vi.fn(),
      onDiagnostic: vi.fn(),
      ...overrides,
    };
  }

  it("creates manager with managed-child defaults and derives adaptive thresholds", () => {
    const host = createMockHost();
    const manager = createEmbeddedContextManager(host, {
      contextWindow: 128_000,
    });

    const snapshot = manager.snapshot();
    expect(snapshot.mode).toBe("managed-child");
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.tokenSource).toBe("reported");
    expect(snapshot.contextTokens).toBe(15_000);
    expect(snapshot.contextWindow).toBe(128_000);
    expect(snapshot.compactThresholdTokens).toBeGreaterThan(0);
    expect(host.onStatus).toHaveBeenCalled();
  });

  it("falls back to character estimation from entries when host token usage is absent", () => {
    const host = createMockHost({
      getContextUsage: vi.fn().mockReturnValue(null),
      getContextEntries: vi.fn().mockReturnValue([
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Hello world, testing context estimation." }],
          },
        },
      ]),
    });

    const manager = createEmbeddedContextManager(host, { contextWindow: 200_000 });
    const snapshot = manager.snapshot();

    expect(snapshot.tokenSource).toBe("estimated");
    expect(snapshot.contextTokens).toBeGreaterThan(0);
  });

  it("transforms tool result with reduction, evidence tracking, and recovery notice", async () => {
    const host = createMockHost();
    const manager = createEmbeddedContextManager(host, { contextWindow: 128_000 });

    // Small output is not reduced
    const smallResult: EmbeddedToolResult = {
      toolName: "bash",
      input: { command: "echo ok" },
      content: [{ type: "text", text: "ok\n" }],
      isError: false,
    };
    const smallTransformed = await manager.transformToolResult(smallResult);
    expect(smallTransformed.content).toEqual(smallResult.content);

    // Read tool is preserved without reduction
    const readResult: EmbeddedToolResult = {
      toolName: "read",
      input: { path: "src/index.ts" },
      content: [{ type: "text", text: "line\n".repeat(2_000) }],
      isError: false,
    };
    const readTransformed = await manager.transformToolResult(readResult);
    expect(readTransformed.content).toEqual(readResult.content);

    // Large build output is reduced
    const largeBuild: EmbeddedToolResult = {
      toolName: "bash",
      input: { command: "npm test" },
      content: [
        {
          type: "text",
          text: [
            ...Array.from({ length: 300 }, (_, i) => `compiling module ${i}`),
            "error TS1234: syntax error in main.ts",
            ...Array.from({ length: 300 }, (_, i) => `more log ${i}`),
            "Tests: 10 passed, 1 failed",
          ].join("\n"),
        },
      ],
      isError: true,
    };

    const transformed = await manager.transformToolResult(largeBuild);
    const text = transformed.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

    expect(text).toContain(NON_EXHAUSTIVE_NOTICE);
    expect(text).toContain("error TS1234");
    expect(text).toContain("Full output saved to:");

    const snap = manager.snapshot();
    expect(snap.toolOutputsReduced).toBe(1);
    expect(snap.reducedOutputsSinceCompaction).toBe(1);
  });

  it("triggers threshold compaction at settled boundary and passes evidence completeness note", async () => {
    let currentTokens = 100_000;
    const host = createMockHost({
      getContextUsage: vi.fn().mockImplementation(() => ({
        tokens: currentTokens,
        contextWindow: 100_000,
        source: "reported",
      })),
      compact: vi.fn().mockImplementation(async () => {
        currentTokens = 30_000;
      }),
    });

    const manager = createEmbeddedContextManager(host, { contextWindow: 100_000 });

    // 1. First record a tool reduction so evidenceTracker has reduced output
    await manager.transformToolResult({
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "error TS1: failed compilation with detailed message\n".repeat(400) }],
      isError: true,
    });

    expect(manager.snapshot().reducedOutputsSinceCompaction).toBe(1);

    // 2. Observe settled: tokens (100k) >= compact threshold (~60k) -> triggers compaction
    await manager.observeSettled();

    expect(host.compact).toHaveBeenCalledTimes(1);
    const compactArg = (host.compact as any).mock.calls[0][0];
    expect(compactArg.reason).toBe("threshold");
    expect(compactArg.customInstructions).toBe(EVIDENCE_COMPLETENESS_NOTE);

    // 3. Post-compaction: reducedOutputsSinceCompaction reset, compactions count incremented
    const snap = manager.snapshot();
    expect(snap.compactions).toBe(1);
    expect(snap.reducedOutputsSinceCompaction).toBe(0);
    expect(snap.toolOutputsReduced).toBe(1); // Lifetime total retained
  });

  it("fails soft on host exceptions without crashing", async () => {
    const host = createMockHost({
      getContextUsage: vi.fn().mockImplementation(() => {
        throw new Error("Simulated host usage error");
      }),
      getContextEntries: vi.fn().mockImplementation(() => {
        throw new Error("Simulated entries error");
      }),
      compact: vi.fn().mockRejectedValue(new Error("Host compaction failed")),
    });

    const manager = createEmbeddedContextManager(host, { contextWindow: 128_000 });

    // Reading usage should not throw
    expect(() => manager.observeTurnStart()).not.toThrow();
    expect(host.onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning", message: expect.stringContaining("host context usage") }),
    );

    // Settled with compact failing should not throw
    await expect(manager.observeSettled()).resolves.not.toThrow();
  });

  it("can be registered and created through the interop provider", () => {
    registerEmbeddedContextManagerProvider();

    const provider = getInteropProvider<{
      createEmbeddedContextManager: typeof createEmbeddedContextManager;
    }>(LCM_EMBEDDED_CONTEXT_PROVIDER_NAME);

    expect(provider).toBeDefined();
    expect(typeof provider?.createEmbeddedContextManager).toBe("function");

    const host = createMockHost();
    const manager = provider!.createEmbeddedContextManager(host, { contextWindow: 128_000 });
    expect(manager).toBeDefined();
    expect(manager.snapshot().mode).toBe("managed-child");
  });
});
