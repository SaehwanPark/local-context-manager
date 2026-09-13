import {
  DEFAULT_CONFIG,
  getEffectiveThresholds,
  type ContextThresholds,
  type LocalContextManagerConfig,
} from "../config.js";
import {
  EvidenceReductionTracker,
  EVIDENCE_COMPLETENESS_NOTE,
} from "../evidence-provenance.js";
import { CompactionGate, getRearmTokens, shouldTriggerThresholdCompaction } from "../policy.js";
import { estimateActiveContextTokens } from "../session-utils.js";
import {
  appendFullOutputNotice,
  appendPrunedOutputNotice,
  extractFullOutputPath,
  reduceToolOutput,
  SessionRecoveryStorage,
} from "../tool-output.js";
import type {
  EmbeddedCompactionRequest,
  EmbeddedContextHost,
  EmbeddedContextManager,
  EmbeddedContextManagerOptions,
  EmbeddedContextSnapshot,
  EmbeddedContextUsage,
  EmbeddedToolResult,
} from "./types.js";

export class EmbeddedContextController implements EmbeddedContextManager {
  private readonly host: EmbeddedContextHost;
  private readonly config: LocalContextManagerConfig;
  private readonly mode: "root" | "managed-child";
  private readonly evidenceTracker = new EvidenceReductionTracker();
  private readonly gate: CompactionGate;
  private readonly recoveryStorage: SessionRecoveryStorage;
  private readonly ownsRecoveryStorage: boolean;

  private currentTokens: number | null = null;
  private currentContextWindow: number | null = null;
  private currentTokenSource: EmbeddedContextSnapshot["tokenSource"] = "unknown";
  private turnSerial = 0;
  private compactionsCount = 0;
  private deactivated = false;
  private disposed = false;

  constructor(host: EmbeddedContextHost, options: EmbeddedContextManagerOptions = {}) {
    this.host = host;
    this.mode = options.mode ?? "managed-child";
    if (options.recoveryStorage) {
      this.recoveryStorage = options.recoveryStorage;
      this.ownsRecoveryStorage = false;
    } else {
      this.recoveryStorage = new SessionRecoveryStorage({
        onDiagnostic: (message) => this.host.onDiagnostic?.({ level: "warning", message }),
      });
      this.ownsRecoveryStorage = true;
    }

    const baseConfig: LocalContextManagerConfig = {
      ...DEFAULT_CONFIG,
      ...(options.config ?? {}),
    };

    if (this.mode === "managed-child") {
      baseConfig.checkpointReset = false;
      baseConfig.handoff = false;
    }

    this.config = baseConfig;
    const initialThresholds = getEffectiveThresholds(
      this.config,
      options.contextWindow ?? this.config.compactThresholdTokens * 2,
    );
    this.gate = new CompactionGate({
      rearmTokens: getRearmTokens(initialThresholds.softWarningTokens, initialThresholds.compactThresholdTokens),
    });

    this.refreshUsage();
  }

  private resolveThresholds(): ContextThresholds {
    return getEffectiveThresholds(this.config, this.currentContextWindow ?? undefined);
  }

  private refreshUsage(): { tokens: number | null; thresholds: ContextThresholds } {
    if (this.disposed) {
      return { tokens: null, thresholds: this.resolveThresholds() };
    }

    let usage: EmbeddedContextUsage | null = null;
    try {
      usage = this.host.getContextUsage();
    } catch (error) {
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Error reading host context usage: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
    }

    if (usage && usage.tokens !== null && Number.isFinite(usage.tokens) && usage.tokens >= 0) {
      this.currentTokens = usage.tokens;
      this.currentContextWindow = usage.contextWindow;
      this.currentTokenSource = usage.source ?? "pi-estimate";
    } else {
      try {
        const entries = this.host.getContextEntries();
        this.currentTokens = estimateActiveContextTokens(entries);
        this.currentContextWindow = usage?.contextWindow ?? null;
        this.currentTokenSource = "local-fallback";
      } catch (error) {
        this.currentTokens = null;
        this.currentTokenSource = "unknown";
        this.host.onDiagnostic?.({
          level: "warning",
          message: `Error estimating active context: ${error instanceof Error ? error.message : String(error)}`,
          error,
        });
      }
    }

    const thresholds = this.resolveThresholds();
    this.gate.setRearmTokens(getRearmTokens(thresholds.softWarningTokens, thresholds.compactThresholdTokens));
    this.gate.observe(this.currentTokens);

    try {
      this.host.onStatus?.(this.snapshot());
    } catch {
      // Host status notification is non-fatal
    }

    return { tokens: this.currentTokens, thresholds };
  }

  observeTurnStart(): void {
    if (this.disposed || this.deactivated) return;
    this.turnSerial += 1;
    this.refreshUsage();
  }

  observeTurnEnd(): void {
    if (this.disposed || this.deactivated) return;
    this.refreshUsage();
  }

  async observeSettled(): Promise<void> {
    if (this.disposed || this.deactivated || !this.config.enabled) {
      return;
    }

    const { tokens, thresholds } = this.refreshUsage();

    if (!shouldTriggerThresholdCompaction(tokens, thresholds.compactThresholdTokens)) {
      return;
    }

    if (!this.gate.canRequest(this.turnSerial, false) || !this.gate.request(this.turnSerial)) {
      return;
    }

    const request: EmbeddedCompactionRequest = {
      reason: "threshold",
    };

    if (this.evidenceTracker.hasReducedSinceLastCompaction) {
      request.customInstructions = EVIDENCE_COMPLETENESS_NOTE;
    }

    try {
      await this.host.compact(request);
      this.compactionsCount += 1;
      this.evidenceTracker.markCompaction();

      const postUsage = this.refreshUsage();
      this.gate.complete(postUsage.tokens, this.turnSerial);
    } catch (error) {
      this.gate.fail(this.turnSerial);
      const message = error instanceof Error ? error.message : String(error);
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Embedded compaction failed: ${message}`,
        error,
      });
    }
  }

  async transformToolResult(result: EmbeddedToolResult): Promise<EmbeddedToolResult> {
    if (this.disposed || this.deactivated || !this.config.enabled || !this.config.toolOutputReduction) {
      return result;
    }

    this.recoveryStorage.noteReferences(result.input);
    if (result.isError) {
      const pruned = this.recoveryStorage.findPrunedReferences(result.input);
      if (pruned.length > 0) {
        return { ...result, content: appendPrunedOutputNotice(result.content, pruned) };
      }
    }

    let reduction;
    try {
      reduction = reduceToolOutput({
        toolName: result.toolName,
        input: result.input,
        content: result.content,
        details: result.details,
        isError: result.isError,
      });
    } catch (error) {
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Tool output reduction failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
      return result;
    }

    if (!reduction.changed) {
      return result;
    }

    let fullOutputPath = extractFullOutputPath(result.details, reduction.originalText);
    if (!fullOutputPath) {
      try {
        fullOutputPath = await this.recoveryStorage.save(reduction.originalText, result.toolName);
      } catch (error) {
        this.host.onDiagnostic?.({
          level: "warning",
          message: `Could not save recovery copy: ${error instanceof Error ? error.message : String(error)}`,
          error,
        });
      }
    }

    if (!fullOutputPath) {
      // P0.3: Embedded output reduction can lose authoritative output if recovery storage fails.
      // Match root LCM semantics: preserve original tool result byte-for-byte, do not record evidence reduction.
      this.host.onDiagnostic?.({
        level: "warning",
        message: `Preserving original tool output because recovery storage is unavailable for ${result.toolName}`,
      });
      return result;
    }

    if (reduction.category) {
      this.evidenceTracker.record(reduction.category);
    }

    let content = reduction.content;
    if (
      !content.some(
        (block) =>
          block.type === "text" &&
          block.text.toLowerCase().includes("full output") &&
          block.text.includes(fullOutputPath),
      )
    ) {
      content = appendFullOutputNotice(content, fullOutputPath, this.recoveryStorage.retentionNote);
    }

    try {
      this.host.onStatus?.(this.snapshot());
    } catch {
      // Best effort
    }

    return {
      ...result,
      content,
    };
  }

  snapshot(): EmbeddedContextSnapshot {
    const thresholds = this.resolveThresholds();
    const percentOfThreshold =
      this.currentTokens !== null && thresholds.compactThresholdTokens > 0
        ? (this.currentTokens / thresholds.compactThresholdTokens) * 100
        : null;

    return {
      tokens: this.currentTokens,
      contextTokens: this.currentTokens,
      contextWindow: this.currentContextWindow,
      tokenSource: this.currentTokenSource,
      compactThresholdTokens: thresholds.compactThresholdTokens,
      percentOfThreshold,
      thresholdRatio: percentOfThreshold !== null ? percentOfThreshold / 100 : undefined,
      mode: this.mode,
      enabled: this.config.enabled && !this.deactivated && !this.disposed,
      toolOutputsReduced: this.evidenceTracker.totalReducedCount,
      reducedOutputsSinceCompaction: this.evidenceTracker.reducedSinceLastCompactionCount,
      compactions: this.compactionsCount,
    };
  }

  deactivate(): void {
    if (this.disposed) return;
    // Recovery files are intentionally retained. A reduced tool result may
    // already be present in the child transcript, and deleting its referenced
    // file during an embedded->native fallback would make that transcript
    // unrecoverable.
    this.deactivated = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivated = true;
    this.disposed = true;
    if (this.ownsRecoveryStorage) {
      void this.recoveryStorage.cleanup().catch(() => undefined);
    }
  }
}

export function createEmbeddedContextManager(
  host: EmbeddedContextHost,
  options?: EmbeddedContextManagerOptions,
): EmbeddedContextManager {
  return new EmbeddedContextController(host, options);
}
