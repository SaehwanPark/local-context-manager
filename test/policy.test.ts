import { describe, expect, it } from "vitest";
import {
  CompactionGate,
  getRearmTokens,
  MIN_COMPACTION_TURN_GAP,
  shouldTriggerThresholdCompaction,
} from "../src/policy.js";

describe("compaction policy", () => {
  it("triggers only at or above the threshold", () => {
    expect(shouldTriggerThresholdCompaction(null, 32_000)).toBe(false);
    expect(shouldTriggerThresholdCompaction(31_999, 32_000)).toBe(false);
    expect(shouldTriggerThresholdCompaction(32_000, 32_000)).toBe(true);
    expect(shouldTriggerThresholdCompaction(48_000, 32_000)).toBe(true);
  });

  it("prevents duplicate threshold requests and rearms after hysteresis", () => {
    const gate = new CompactionGate({ rearmTokens: 24_000 });
    expect(gate.canRequest(1, false)).toBe(true);
    expect(gate.request(1)).toBe(true);
    expect(gate.canRequest(1, false)).toBe(false);

    gate.complete(31_000);
    expect(gate.canRequest(2, false)).toBe(false);
    expect(gate.canRequest(3, false)).toBe(false);

    gate.observe(24_000);
    expect(gate.canRequest(3, false)).toBe(true);
  });

  it("keeps explicit phase requests under the same cooldown and in-flight guard", () => {
    const gate = new CompactionGate({ rearmTokens: 10_000, minimumTurnGap: MIN_COMPACTION_TURN_GAP });
    gate.request(4);
    expect(gate.canRequest(5, true)).toBe(false);
    gate.complete(8_000);
    expect(gate.canRequest(5, true)).toBe(false);
    expect(gate.canRequest(6, true)).toBe(true);
  });

  it("derives a conservative rearm point", () => {
    expect(getRearmTokens(24_000, 32_000)).toBe(24_000);
    expect(getRearmTokens(40_000, 32_000)).toBe(24_000);
  });
});
