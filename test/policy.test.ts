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

  it("rearms after post-compaction epoch growth when compaction lands above rearmTokens", () => {
    // Balanced mode: rearmTokens = 24k, threshold = 32k.
    // Compaction completes at 28k (above 24k rearm watermark).
    const gate = new CompactionGate({ rearmTokens: 24_000 });
    gate.request(1);
    gate.complete(28_000, 1);
    expect(gate.isArmed).toBe(false);
    expect(gate.canRequest(2, false)).toBe(false);

    // Monotonically growing context without falling below 24k:
    // Small increment (28_500) within cooldown or below margin -> remains disarmed
    gate.observe(28_500, 32_000);
    expect(gate.isArmed).toBe(false);
    expect(gate.canRequest(3, false)).toBe(false);

    // Meaningful growth in post-compaction epoch (>= 28k + margin, e.g. 30_500)
    gate.observe(30_500, 32_000);
    expect(gate.isArmed).toBe(true);
    expect(gate.canRequest(3, false)).toBe(true);
  });

  it("rearms when context re-enters compactThresholdTokens even if postTokens was above rearmTokens", () => {
    const gate = new CompactionGate({ rearmTokens: 24_000, growthMargin: 10_000 });
    gate.request(1);
    gate.complete(29_000, 1);
    expect(gate.isArmed).toBe(false);

    // Context reaches 32_000 (compactThresholdTokens)
    gate.observe(32_000, 32_000);
    expect(gate.isArmed).toBe(true);
    expect(gate.canRequest(3, false)).toBe(true);
  });

  it("does not rearm in a loop when compaction lands above compactThresholdTokens without growth", () => {
    // Balanced mode: rearmTokens = 24k, threshold = 32k.
    // Compaction completes at 33k (already above threshold).
    const gate = new CompactionGate({ rearmTokens: 24_000 });
    gate.request(1);
    gate.complete(33_000, 1);
    expect(gate.isArmed).toBe(false);

    // Context remains at 33k: must remain disarmed (no growth)
    gate.observe(33_000, 32_000);
    expect(gate.isArmed).toBe(false);
    expect(gate.canRequest(3, false)).toBe(false);

    // Minor growth below margin (33_500): must remain disarmed
    gate.observe(33_500, 32_000);
    expect(gate.isArmed).toBe(false);
    expect(gate.canRequest(3, false)).toBe(false);

    // Meaningful growth beyond 33k (>= 33k + margin, e.g. 35_500): rearms
    gate.observe(35_500, 32_000);
    expect(gate.isArmed).toBe(true);
    expect(gate.canRequest(3, false)).toBe(true);
  });

  it("rearms after a failed request with a turn backoff", () => {
    const gate = new CompactionGate({ rearmTokens: 24_000 });
    gate.request(1);
    gate.fail(1);
    expect(gate.canRequest(2, false)).toBe(false);
    expect(gate.canRequest(3, false)).toBe(true);

    gate.request(3);
    gate.fail(3);
    expect(gate.canRequest(6, false)).toBe(false);
    expect(gate.canRequest(7, false)).toBe(true);
  });

  it("updates hysteresis when the active context window changes", () => {
    const gate = new CompactionGate({ rearmTokens: 24_000 });
    gate.request(1);
    gate.complete(30_000);
    gate.setRearmTokens(8_000);
    gate.observe(8_000);
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
