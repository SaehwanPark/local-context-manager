import { describe, expect, it } from "vitest";
import {
  attachEvidenceCompletenessNote,
  EvidenceReductionTracker,
  EVIDENCE_COMPLETENESS_NOTE,
} from "../src/evidence-provenance.js";

describe("evidence-provenance", () => {
  it("tracks reduced categories and compaction boundaries", () => {
    const tracker = new EvidenceReductionTracker();
    expect(tracker.hasReducedSinceLastCompaction).toBe(false);
    expect(tracker.totalReducedCount).toBe(0);
    expect(tracker.reducedSinceLastCompactionCount).toBe(0);

    tracker.record("build");
    tracker.record("failure");
    expect(tracker.hasReducedSinceLastCompaction).toBe(true);
    expect(tracker.totalReducedCount).toBe(2);
    expect(tracker.reducedSinceLastCompactionCount).toBe(2);
    expect([...tracker.observedCategories]).toEqual(["build", "failure"]);

    tracker.markCompaction();
    expect(tracker.hasReducedSinceLastCompaction).toBe(false);
    expect(tracker.totalReducedCount).toBe(2);
    expect(tracker.reducedSinceLastCompactionCount).toBe(0);

    tracker.record("search");
    expect(tracker.hasReducedSinceLastCompaction).toBe(true);
    expect(tracker.totalReducedCount).toBe(3);
    expect(tracker.reducedSinceLastCompactionCount).toBe(1);

    const snap = tracker.snapshot();
    expect(snap.reducedOutputs).toBe(3);
    expect(snap.reducedSinceLastCompaction).toBe(1);
    expect(snap.categories.has("search")).toBe(true);
  });

  it("attaches evidence completeness note without duplicating it", () => {
    const summary = "Phase completed successfully.";
    const attached = attachEvidenceCompletenessNote(summary);
    expect(attached).toContain(summary);
    expect(attached).toContain(EVIDENCE_COMPLETENESS_NOTE);

    // Idempotent: attaching again must not duplicate the note
    const attachedTwice = attachEvidenceCompletenessNote(attached);
    expect(attachedTwice).toBe(attached);
    expect(attachedTwice.split("Evidence completeness:").length).toBe(2);
  });
});
