export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
}

export interface TelemetrySnapshot {
  contextTokens: number | null;
  contextWindow: number | null;
  compactThresholdTokens: number;
  percentOfThreshold: number | null;
  tokensAddedSinceCompaction: number | null;
  approximateToolOutputTokens: number;
  toolOutputTokensRemoved: number;
  toolOutputsReduced: number;
  compactions: number;
  lastCompactionAt: number | null;
  lastCompactionTurn: number | null;
  checkpointResets: number;
  lastCheckpointResetAt: number | null;
  lastCheckpointPath: string | null;
  currentTurn: number;
}

export class ContextTelemetry {
  private contextTokens: number | null = null;
  private contextWindow: number | null = null;
  private baselineTokens: number | null = null;
  private tokensAddedSinceCompaction: number | null = null;
  private approximateToolOutputTokens = 0;
  private toolOutputTokensRemoved = 0;
  private toolOutputsReduced = 0;
  private compactions: number;
  private lastCompactionAt: number | null;
  private lastCompactionTurn: number | null;
  private checkpointResets: number;
  private lastCheckpointResetAt: number | null;
  private lastCheckpointPath: string | null;
  private currentTurn = 0;

  constructor(
    compactions = 0,
    lastCompactionAt: number | null = null,
    checkpointResets = 0,
    lastCheckpointResetAt: number | null = null,
    lastCheckpointPath: string | null = null,
  ) {
    this.compactions = compactions;
    this.lastCompactionAt = lastCompactionAt;
    this.lastCompactionTurn = null;
    this.checkpointResets = checkpointResets;
    this.lastCheckpointResetAt = lastCheckpointResetAt;
    this.lastCheckpointPath = lastCheckpointPath;
  }

  observe(usage: ContextUsageLike | undefined): void {
    if (!usage) {
      return;
    }

    this.contextWindow = Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
    if (usage.tokens === null || !Number.isFinite(usage.tokens) || usage.tokens < 0) {
      this.contextTokens = null;
      this.tokensAddedSinceCompaction = null;
      return;
    }

    this.setObservedTokens(usage.tokens);
  }

  observeEstimate(tokens: number, contextWindow?: number): void {
    if (Number.isFinite(contextWindow) && contextWindow !== undefined && contextWindow > 0) {
      this.contextWindow = contextWindow;
    }
    if (!Number.isFinite(tokens) || tokens < 0) {
      return;
    }
    this.setObservedTokens(tokens);
  }

  private setObservedTokens(tokens: number): void {
    this.contextTokens = tokens;
    if (this.baselineTokens === null) {
      this.baselineTokens = tokens;
    }
    this.tokensAddedSinceCompaction = Math.max(0, tokens - this.baselineTokens);
  }

  markTurn(turn: number): void {
    if (Number.isFinite(turn) && turn >= 0) {
      this.currentTurn = turn;
    }
  }

  setCompactionBaseline(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) {
      return;
    }
    this.baselineTokens = tokens;
    if (this.contextTokens !== null) {
      this.tokensAddedSinceCompaction = Math.max(0, this.contextTokens - tokens);
    }
  }

  recordToolOutput(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.approximateToolOutputTokens += Math.floor(tokens);
    }
  }

  recordToolReduction(originalTokens: number, retainedTokens: number): void {
    const original = Math.max(0, originalTokens);
    const retained = Math.max(0, Math.min(original, retainedTokens));
    this.recordToolOutput(retained);
    this.toolOutputTokensRemoved += original - retained;
    this.toolOutputsReduced += 1;
  }

  setActiveToolOutputTokens(tokens: number): void {
    this.approximateToolOutputTokens = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0;
  }

  markCompaction(timestamp: number, turn: number, postTokens: number | null, activeToolOutputTokens: number): void {
    this.compactions += 1;
    this.lastCompactionAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    this.lastCompactionTurn = turn;
    this.baselineTokens = postTokens !== null && Number.isFinite(postTokens) ? postTokens : null;
    this.contextTokens = postTokens !== null && Number.isFinite(postTokens) ? postTokens : null;
    this.tokensAddedSinceCompaction = postTokens !== null && Number.isFinite(postTokens) ? 0 : null;
    this.setActiveToolOutputTokens(activeToolOutputTokens);
  }

  markCheckpointReset(timestamp: number, path: string, lineageCount?: number): void {
    if (lineageCount === undefined) {
      this.checkpointResets += 1;
    } else if (Number.isSafeInteger(lineageCount) && lineageCount >= 0) {
      this.checkpointResets = lineageCount;
    }
    this.lastCheckpointResetAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    this.lastCheckpointPath = path;
  }

  snapshot(compactThresholdTokens: number): TelemetrySnapshot {
    const percentOfThreshold =
      this.contextTokens !== null && compactThresholdTokens > 0
        ? (this.contextTokens / compactThresholdTokens) * 100
        : null;

    return {
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      compactThresholdTokens,
      percentOfThreshold,
      tokensAddedSinceCompaction: this.tokensAddedSinceCompaction,
      approximateToolOutputTokens: this.approximateToolOutputTokens,
      toolOutputTokensRemoved: this.toolOutputTokensRemoved,
      toolOutputsReduced: this.toolOutputsReduced,
      compactions: this.compactions,
      lastCompactionAt: this.lastCompactionAt,
      lastCompactionTurn: this.lastCompactionTurn,
      checkpointResets: this.checkpointResets,
      lastCheckpointResetAt: this.lastCheckpointResetAt,
      lastCheckpointPath: this.lastCheckpointPath,
      currentTurn: this.currentTurn,
    };
  }
}

export function formatTokenCount(tokens: number | null): string {
  if (tokens === null) {
    return "?";
  }
  if (tokens < 1_000) {
    return `${Math.round(tokens)}`;
  }
  if (tokens < 10_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(tokens / 1_000)}k`;
}

export function formatTelemetryStatus(snapshot: TelemetrySnapshot): string {
  const context = formatTokenCount(snapshot.contextTokens);
  const threshold = formatTokenCount(snapshot.compactThresholdTokens);
  const percent = snapshot.percentOfThreshold === null ? "?" : `${Math.round(snapshot.percentOfThreshold)}%`;
  const added = formatTokenCount(snapshot.tokensAddedSinceCompaction);
  const tools = formatTokenCount(snapshot.approximateToolOutputTokens);
  return `ctx ${context}/${threshold} (${percent}) · +${added} · tool≈${tools} · c${snapshot.compactions}`;
}

export function formatTelemetryDetails(snapshot: TelemetrySnapshot): string {
  const lines = [
    `Context: ${formatTokenCount(snapshot.contextTokens)} tokens`,
    `Context window: ${formatTokenCount(snapshot.contextWindow)}`,
    `Compact threshold: ${formatTokenCount(snapshot.compactThresholdTokens)} tokens`,
    `Threshold consumed: ${snapshot.percentOfThreshold === null ? "unknown" : `${snapshot.percentOfThreshold.toFixed(1)}%`}`,
    `Added since compaction: ${formatTokenCount(snapshot.tokensAddedSinceCompaction)} tokens`,
    `Active tool output: approximately ${formatTokenCount(snapshot.approximateToolOutputTokens)} tokens`,
    `Tool output reduced: ${snapshot.toolOutputsReduced} result(s), approximately ${formatTokenCount(snapshot.toolOutputTokensRemoved)} tokens removed`,
    `Compactions in session: ${snapshot.compactions}`,
    `Last compaction: ${snapshot.lastCompactionAt === null ? "never" : new Date(snapshot.lastCompactionAt).toISOString()}`,
    `Checkpoint resets in session lineage: ${snapshot.checkpointResets}`,
    `Last checkpoint reset: ${snapshot.lastCheckpointResetAt === null ? "never" : new Date(snapshot.lastCheckpointResetAt).toISOString()}`,
  ];
  if (snapshot.lastCheckpointPath !== null) {
    lines.push(`Last checkpoint path: ${snapshot.lastCheckpointPath}`);
  }
  if (snapshot.lastCompactionTurn !== null) {
    lines.push(`Last compaction turn: ${snapshot.lastCompactionTurn}`);
  }
  return lines.join("\n");
}
