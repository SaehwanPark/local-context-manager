import { describe, expect, it } from "vitest";
import { ContextTelemetry, formatTelemetryDetails, formatTelemetryStatus } from "../src/telemetry.js";

describe("telemetry", () => {
  it("tracks context growth after compaction and reduced tool output", () => {
    const telemetry = new ContextTelemetry(2, 123);
    telemetry.markTurn(3);
    telemetry.observe({ tokens: 12_000, contextWindow: 64_000 });
    telemetry.markCompaction(456, 3, 8_000, 1_500);
    telemetry.recordToolReduction(4_000, 1_000);
    telemetry.markCheckpointReset(789, "/tmp/checkpoint.md");
    telemetry.markCheckpointReset(999, "/tmp/checkpoint-2.md", 4);
    telemetry.observe({ tokens: 10_500, contextWindow: 64_000 });

    const snapshot = telemetry.snapshot(32_000);
    expect(snapshot.contextTokens).toBe(10_500);
    expect(snapshot.tokensAddedSinceCompaction).toBe(2_500);
    expect(snapshot.compactions).toBe(3);
    expect(snapshot.approximateToolOutputTokens).toBe(2_500);
    expect(snapshot.toolOutputTokensRemoved).toBe(3_000);
    expect(snapshot.lastCompactionTurn).toBe(3);
    expect(snapshot.checkpointResets).toBe(4);
    expect(snapshot.lastCheckpointPath).toBe("/tmp/checkpoint-2.md");
    expect(formatTelemetryStatus(snapshot)).toContain("ctx 11k/32k");
    expect(formatTelemetryDetails(snapshot)).toContain("Last checkpoint reset");
  });

  it("uses an estimate when provider usage is unavailable", () => {
    const telemetry = new ContextTelemetry();
    telemetry.observeEstimate(5_000, 32_000);
    telemetry.observe({ tokens: null, contextWindow: 32_000 });
    expect(telemetry.snapshot(10_000).contextTokens).toBe(null);

    telemetry.observeEstimate(7_000);
    expect(telemetry.snapshot(10_000).tokensAddedSinceCompaction).toBe(2_000);
    expect(telemetry.snapshot(10_000).checkpointResets).toBe(0);
  });
});
