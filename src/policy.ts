export const MIN_COMPACTION_TURN_GAP = 2;

export interface CompactionGateOptions {
  rearmTokens: number;
  minimumTurnGap?: number;
}

/**
 * Keeps threshold compaction one-shot until the active epoch has actually shrunk.
 * Explicit phase-boundary requests still honor the turn cooldown but can bypass the
 * threshold gate when the caller has deliberately asked for a new epoch.
 */
export class CompactionGate {
  private rearmTokens: number;
  private readonly minimumTurnGap: number;
  private armed = true;
  private inFlight = false;
  private lastRequestTurn: number | null = null;

  constructor(options: CompactionGateOptions) {
    this.rearmTokens = Number.isFinite(options.rearmTokens) ? Math.max(1, options.rearmTokens) : 1;
    const minimumTurnGap = options.minimumTurnGap ?? MIN_COMPACTION_TURN_GAP;
    this.minimumTurnGap = Number.isFinite(minimumTurnGap) ? Math.max(0, Math.floor(minimumTurnGap)) : MIN_COMPACTION_TURN_GAP;
  }

  setRearmTokens(rearmTokens: number): void {
    this.rearmTokens = Number.isFinite(rearmTokens) ? Math.max(1, rearmTokens) : 1;
  }

  observe(tokens: number | null): void {
    if (tokens !== null && Number.isFinite(tokens) && tokens <= this.rearmTokens) {
      this.armed = true;
    }
  }

  canRequest(turn: number, explicit: boolean): boolean {
    if (this.inFlight) {
      return false;
    }
    if (
      this.lastRequestTurn !== null &&
      Number.isFinite(turn) &&
      turn - this.lastRequestTurn < this.minimumTurnGap
    ) {
      return false;
    }
    return explicit || this.armed;
  }

  request(turn: number): boolean {
    if (this.inFlight) {
      return false;
    }
    this.inFlight = true;
    this.armed = false;
    this.lastRequestTurn = Number.isFinite(turn) ? turn : this.lastRequestTurn;
    return true;
  }

  complete(postTokens: number | null, turn?: number): void {
    this.inFlight = false;
    this.observe(postTokens);
    if (turn !== undefined && Number.isFinite(turn) && turn >= 0) {
      this.lastRequestTurn = turn;
    }
  }

  fail(): void {
    this.inFlight = false;
    this.armed = false;
  }

  get isInFlight(): boolean {
    return this.inFlight;
  }
}

export function shouldTriggerThresholdCompaction(tokens: number | null, thresholdTokens: number): boolean {
  return tokens !== null && Number.isFinite(tokens) && tokens >= thresholdTokens;
}

export function getRearmTokens(softWarningTokens: number, compactThresholdTokens: number): number {
  const threeQuarterThreshold = Math.floor(compactThresholdTokens * 0.75);
  return Math.max(1, Math.min(softWarningTokens, threeQuarterThreshold));
}
