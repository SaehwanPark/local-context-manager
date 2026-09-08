import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FabricSnapshotRequest,
  FabricStateSnapshotV1,
  getInteropProvider,
  getInteropRegistry,
  isFabricQuiescent,
  queryFabricState,
  registerInteropProvider,
  SAFE_AGENT_FABRIC_PROVIDER_NAME,
  sanitizeFabricSnapshot,
  unregisterInteropProvider,
} from "../src/embedded/interop.js";

describe("process-local extension interop registry", () => {
  beforeEach(() => {
    // Clear the registry providers before each test
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  afterEach(() => {
    const registry = getInteropRegistry();
    registry.providers.clear();
  });

  it("handles absent providers cleanly with standalone defaults", async () => {
    expect(getInteropProvider("non-existent-provider")).toBeUndefined();
    const fabric = await queryFabricState({ cwd: "/home/user/project" });
    expect(fabric).toBeUndefined();
    expect(isFabricQuiescent(undefined)).toBe(true);
  });

  it("registers providers idempotently and rejects incompatible duplicates", () => {
    const provider1 = { version: "1.0.0" };
    const provider2 = { version: "2.0.0" };

    expect(registerInteropProvider("test.service.v1", provider1)).toBe(true);
    // Idempotent registration of the same provider
    expect(registerInteropProvider("test.service.v1", provider1)).toBe(true);

    // Incompatible duplicate registration rejected
    expect(registerInteropProvider("test.service.v1", provider2)).toBe(false);
    expect(getInteropProvider("test.service.v1")).toBe(provider1);

    // Unregister
    expect(unregisterInteropProvider("test.service.v1", provider1)).toBe(true);
    expect(getInteropProvider("test.service.v1")).toBeUndefined();
  });

  it("sanitizes and clamps raw fabric snapshots deterministically", () => {
    expect(sanitizeFabricSnapshot(null)).toBeUndefined();
    expect(sanitizeFabricSnapshot(undefined)).toBeUndefined();
    expect(sanitizeFabricSnapshot("not an object")).toBeUndefined();

    const raw = {
      active: true,
      quiescent: false,
      runningChildren: 3.8,
      unresolvedChildTasks: -1,
      mutableHolds: 2,
      pendingRootRequests: 0,
      pendingRootDeliveries: 1,
      activeTasks: Array.from({ length: 25 }, (_, i) => ({
        id: `task-${i}`,
        status: "in_progress\n",
        owner: `agent-${i}`,
        description: "a".repeat(200),
      })),
      mutableResources: Array.from({ length: 15 }, (_, i) => ({
        id: `res-${i}`,
        path: `/path/to/resource/${i}`,
        holder: `agent-${i}`,
      })),
    };

    const sanitized = sanitizeFabricSnapshot(raw);
    expect(sanitized).toBeDefined();
    if (!sanitized) return;

    expect(sanitized.active).toBe(true);
    expect(sanitized.quiescent).toBe(false);
    expect(sanitized.runningChildren).toBe(3); // Floored
    expect(sanitized.unresolvedChildTasks).toBe(0); // Clamped from -1
    expect(sanitized.mutableHolds).toBe(2);

    // Clamped to 10 items max
    expect(sanitized.activeTasks).toHaveLength(10);
    expect(sanitized.mutableResources).toHaveLength(10);

    // Strings trimmed/truncated
    expect(sanitized.activeTasks![0].status).toBe("in_progress");
    expect(sanitized.activeTasks![0].description?.length).toBeLessThanOrEqual(120);
  });

  it("queries fabric state from an object-style provider", async () => {
    const mockSnapshot: FabricStateSnapshotV1 = {
      active: true,
      quiescent: false,
      runningChildren: 2,
      unresolvedChildTasks: 1,
      mutableHolds: 1,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
      activeTasks: [{ id: "T-1", status: "running", owner: "subagent-1" }],
    };

    const getSnapshot = vi.fn().mockImplementation((req: FabricSnapshotRequest) => {
      if (req.cwd !== "/repo") return undefined;
      return mockSnapshot;
    });

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, { getSnapshot });

    // Different cwd: returns undefined
    const otherResult = await queryFabricState({ cwd: "/other" });
    expect(otherResult).toBeUndefined();

    // Matching cwd: returns snapshot
    const result = await queryFabricState({ cwd: "/repo", sessionId: "sess-1" });
    expect(result).toBeDefined();
    expect(result?.active).toBe(true);
    expect(result?.quiescent).toBe(false);
    expect(isFabricQuiescent(result)).toBe(false);
  });

  it("queries fabric state from a function-style provider", async () => {
    const providerFn = vi.fn().mockResolvedValue({
      active: true,
      quiescent: true,
      runningChildren: 0,
      unresolvedChildTasks: 0,
      mutableHolds: 0,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
    });

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, providerFn);

    const result = await queryFabricState({ cwd: "/repo" });
    expect(result?.active).toBe(true);
    expect(result?.quiescent).toBe(true);
    expect(isFabricQuiescent(result)).toBe(true);
  });

  it("handles throwing providers fail-soft without error", async () => {
    const badProvider = {
      getSnapshot: vi.fn().mockRejectedValue(new Error("Fabric internal failure")),
    };

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, badProvider);

    const result = await queryFabricState({ cwd: "/repo" });
    expect(result).toBeUndefined();
    expect(isFabricQuiescent(result)).toBe(true);
  });
});
