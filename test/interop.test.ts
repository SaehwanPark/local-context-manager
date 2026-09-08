import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FabricSnapshotRequest,
  FabricStateSnapshotV1,
  getInteropProvider,
  getInteropRegistry,
  isFabricQuiescent,
  isSessionReplacementSafe,
  queryFabricObservation,
  queryFabricState,
  registerInteropProvider,
  resolveSessionFile,
  resolveSessionId,
  SAFE_AGENT_FABRIC_PROVIDER_NAME,
  sanitizeFabricSnapshot,
  unregisterInteropProvider,
} from "../src/embedded/interop.js";

describe("process-local extension interop registry and safe-agent V1 contract", () => {
  beforeEach(() => {
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

    const obs = await queryFabricObservation({ cwd: "/home/user/project" });
    expect(obs.kind).toBe("absent");
    expect(isSessionReplacementSafe(obs)).toBe(true);
  });

  it("registers providers idempotently and rejects incompatible duplicates", () => {
    const provider1 = { version: "1.0.0" };
    const provider2 = { version: "2.0.0" };

    expect(registerInteropProvider("test.service.v1", provider1)).toBe(true);
    expect(registerInteropProvider("test.service.v1", provider1)).toBe(true);

    expect(registerInteropProvider("test.service.v1", provider2)).toBe(false);
    expect(getInteropProvider("test.service.v1")).toBe(provider1);

    expect(unregisterInteropProvider("test.service.v1", provider1)).toBe(true);
    expect(getInteropProvider("test.service.v1")).toBeUndefined();
  });

  it("resolves session ID and session file independently from sessionManager", () => {
    expect(resolveSessionId(undefined)).toBeUndefined();
    expect(resolveSessionFile(undefined)).toBeUndefined();

    const sessionManager = {
      getSessionId: () => "sess-abc-123",
      getSessionFile: () => "/tmp/sessions/sess-abc-123.jsonl",
    };

    expect(resolveSessionId(sessionManager)).toBe("sess-abc-123");
    expect(resolveSessionFile(sessionManager)).toBe("/tmp/sessions/sess-abc-123.jsonl");

    // Property fallback
    const propertyBased = {
      sessionId: "prop-session-id",
      sessionFile: "/tmp/prop-session.jsonl",
    };
    expect(resolveSessionId(propertyBased)).toBe("prop-session-id");
    expect(resolveSessionFile(propertyBased)).toBe("/tmp/prop-session.jsonl");
  });

  it("sanitizes valid safe-agent V1 snapshots strictly and clamps bounds", () => {
    expect(sanitizeFabricSnapshot(null)).toBeUndefined();
    expect(sanitizeFabricSnapshot(undefined)).toBeUndefined();
    expect(sanitizeFabricSnapshot("not an object")).toBeUndefined();
    expect(sanitizeFabricSnapshot({})).toBeUndefined(); // fail-closed on empty

    const validRaw = {
      version: 1,
      active: true,
      quiescent: false,
      state: "known",
      sessionReplacementSafe: false,
      capturedAt: 1725800000000,
      runningChildren: 3.8,
      unresolvedChildTasks: 1,
      mutableHolds: 2,
      activeWriteFences: 1,
      pendingRootRequests: 0,
      pendingRootDeliveries: 1,
      quiescenceReasons: ["running_children_active", "active_write_fences"],
      activeTasks: Array.from({ length: 60 }, (_, i) => ({
        id: `task-${i}`,
        status: "in_progress\n",
        owner: `agent-${i}`,
        description: "a".repeat(200),
      })),
      mutableResources: Array.from({ length: 60 }, (_, i) => ({
        id: `res-${i}`,
        path: `/path/to/resource/${i}`,
        holder: `agent-${i}`,
      })),
    };

    const sanitized = sanitizeFabricSnapshot(validRaw);
    expect(sanitized).toBeDefined();
    if (!sanitized) return;

    expect(sanitized.version).toBe(1);
    expect(sanitized.active).toBe(true);
    expect(sanitized.quiescent).toBe(false);
    expect(sanitized.state).toBe("known");
    expect(sanitized.sessionReplacementSafe).toBe(false);
    expect(sanitized.capturedAt).toBe(1725800000000);
    expect(sanitized.runningChildren).toBe(3); // Floored
    expect(sanitized.unresolvedChildTasks).toBe(1);
    expect(sanitized.mutableHolds).toBe(2);
    expect(sanitized.activeWriteFences).toBe(1);
    expect(sanitized.quiescenceReasons).toEqual(["running_children_active", "active_write_fences"]);

    // Clamped to 50 items max
    expect(sanitized.activeTasks).toHaveLength(50);
    expect(sanitized.mutableResources).toHaveLength(50);

    // Strings trimmed/truncated
    expect(sanitized.activeTasks![0].status).toBe("in_progress");
    expect(sanitized.activeTasks![0].description?.length).toBeLessThanOrEqual(120);
  });

  it("fails closed on malformed V1 snapshots", () => {
    const baseValid = {
      version: 1,
      active: true,
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
    };

    // Missing version or wrong version
    expect(sanitizeFabricSnapshot({ ...baseValid, version: 2 })).toBeUndefined();
    expect(sanitizeFabricSnapshot({ ...baseValid, version: undefined })).toBeUndefined();

    // Missing booleans
    expect(sanitizeFabricSnapshot({ ...baseValid, active: "true" })).toBeUndefined();
    expect(sanitizeFabricSnapshot({ ...baseValid, quiescent: null })).toBeUndefined();
    expect(sanitizeFabricSnapshot({ ...baseValid, sessionReplacementSafe: undefined })).toBeUndefined();

    // Invalid state
    expect(sanitizeFabricSnapshot({ ...baseValid, state: "invalid" })).toBeUndefined();

    // Missing or invalid capturedAt
    expect(sanitizeFabricSnapshot({ ...baseValid, capturedAt: -5 })).toBeUndefined();
    expect(sanitizeFabricSnapshot({ ...baseValid, capturedAt: "now" })).toBeUndefined();

    // Negative or non-numeric counters
    expect(sanitizeFabricSnapshot({ ...baseValid, runningChildren: -1 })).toBeUndefined();
    expect(sanitizeFabricSnapshot({ ...baseValid, activeWriteFences: "none" })).toBeUndefined();
    expect(sanitizeFabricSnapshot({ ...baseValid, mutableHolds: NaN })).toBeUndefined();
  });

  it("queries fabric observation with explicit known and uncertain discrimination", async () => {
    const validSnapshot: FabricStateSnapshotV1 = {
      version: 1,
      active: true,
      quiescent: true,
      state: "known",
      sessionReplacementSafe: true,
      capturedAt: 1725800000000,
      runningChildren: 0,
      unresolvedChildTasks: 0,
      mutableHolds: 0,
      activeWriteFences: 0,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
      quiescenceReasons: [],
    };

    const getSnapshot = vi.fn().mockImplementation((req: FabricSnapshotRequest) => {
      if (req.cwd !== "/repo") return null;
      if (req.sessionId !== "valid-session-id") return null;
      return validSnapshot;
    });

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, { getSnapshot });

    // Matching scope: known
    const knownObs = await queryFabricObservation({ cwd: "/repo", sessionId: "valid-session-id" });
    expect(knownObs.kind).toBe("known");
    if (knownObs.kind === "known") {
      expect(knownObs.snapshot.sessionReplacementSafe).toBe(true);
      expect(isSessionReplacementSafe(knownObs)).toBe(true);
    }

    // Provider returns null (e.g. session mismatch) -> uncertain (fail-closed)
    const nullObs = await queryFabricObservation({ cwd: "/repo", sessionId: "mismatched-session-id" });
    expect(nullObs.kind).toBe("uncertain");
    expect(isSessionReplacementSafe(nullObs)).toBe(false);
  });

  it("handles provider returning state: 'uncertain' cleanly", async () => {
    const uncertainSnapshot: FabricStateSnapshotV1 = {
      version: 1,
      active: true,
      quiescent: false,
      state: "uncertain",
      sessionReplacementSafe: false,
      capturedAt: Date.now(),
      runningChildren: 0,
      unresolvedChildTasks: 0,
      mutableHolds: 0,
      activeWriteFences: 0,
      pendingRootRequests: 0,
      pendingRootDeliveries: 0,
      quiescenceReasons: ["fabric_status_query_failed"],
    };

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, {
      getSnapshot: vi.fn().mockResolvedValue(uncertainSnapshot),
    });

    const obs = await queryFabricObservation({ cwd: "/repo" });
    expect(obs.kind).toBe("uncertain");
    expect(isSessionReplacementSafe(obs)).toBe(false);
    if (obs.kind === "uncertain") {
      expect(obs.reason).toContain("fabric_status_query_failed");
    }
  });

  it("handles throwing providers fail-soft without unhandled rejection", async () => {
    const badProvider = {
      getSnapshot: vi.fn().mockRejectedValue(new Error("Fabric internal failure")),
    };

    registerInteropProvider(SAFE_AGENT_FABRIC_PROVIDER_NAME, badProvider);

    const obs = await queryFabricObservation({ cwd: "/repo" });
    expect(obs.kind).toBe("uncertain");
    if (obs.kind === "uncertain") {
      expect(obs.reason).toContain("Fabric internal failure");
    }
    expect(isSessionReplacementSafe(obs)).toBe(false);
  });
});
