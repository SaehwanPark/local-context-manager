export type ToolOutputCategory = "build" | "failure" | "search" | "diff" | "generic";

export const EVIDENCE_COMPLETENESS_NOTE =
  "Evidence completeness: some prior tool outputs were reduced. Re-read authoritative full output if a later conclusion requires exhaustive matches, exact counts, absence, or event ordering.";

export interface EvidenceReductionState {
  reducedOutputs: number;
  categories: Set<ToolOutputCategory>;
  reducedSinceLastCompaction: number;
}

export class EvidenceReductionTracker {
  private totalReduced = 0;
  private reducedSinceLastCompaction = 0;
  private categories = new Set<ToolOutputCategory>();

  record(category: ToolOutputCategory): void {
    this.totalReduced += 1;
    this.reducedSinceLastCompaction += 1;
    this.categories.add(category);
  }

  markCompaction(): void {
    this.reducedSinceLastCompaction = 0;
  }

  get hasReducedSinceLastCompaction(): boolean {
    return this.reducedSinceLastCompaction > 0;
  }

  get totalReducedCount(): number {
    return this.totalReduced;
  }

  get reducedSinceLastCompactionCount(): number {
    return this.reducedSinceLastCompaction;
  }

  get observedCategories(): ReadonlySet<ToolOutputCategory> {
    return this.categories;
  }

  snapshot(): EvidenceReductionState {
    return {
      reducedOutputs: this.totalReduced,
      categories: new Set(this.categories),
      reducedSinceLastCompaction: this.reducedSinceLastCompaction,
    };
  }
}

export function attachEvidenceCompletenessNote(summary: string): string {
  if (summary.includes("Evidence completeness:")) {
    return summary;
  }
  const trimmed = summary.trim();
  return trimmed ? `${trimmed}\n\n${EVIDENCE_COMPLETENESS_NOTE}` : EVIDENCE_COMPLETENESS_NOTE;
}
