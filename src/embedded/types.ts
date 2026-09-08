import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LocalContextManagerConfig } from "../config.js";
import type { ToolContentBlock } from "../tool-output.js";

export type EmbeddedContextUsageSource =
  | "pi-estimate"
  | "local-fallback"
  | "reported"
  | "estimated";

export interface EmbeddedContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  source: EmbeddedContextUsageSource;
}

export interface EmbeddedCompactionRequest {
  reason?: "threshold" | "semantic" | string;
  customInstructions?: string;
  targetTokens?: number;
}

export interface EmbeddedContextSnapshot {
  tokens?: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  tokenSource: "pi-estimate" | "local-fallback" | "reported" | "estimated" | "unknown";
  compactThresholdTokens: number;
  percentOfThreshold: number | null;
  thresholdRatio?: number | undefined;
  mode: "root" | "managed-child";
  enabled: boolean;
  toolOutputsReduced: number;
  reducedOutputsSinceCompaction: number;
  compactions: number;
}

export interface EmbeddedContextDiagnostic {
  level: "info" | "warning" | "error";
  message: string;
  error?: unknown;
}

export interface EmbeddedContextHost {
  getContextUsage(): EmbeddedContextUsage | null;
  getContextEntries(): SessionEntry[];

  /**
   * Called only at a host-declared safe boundary.
   * The host remains authoritative about whether compaction is currently legal.
   */
  compact(request: EmbeddedCompactionRequest): Promise<void>;

  /**
   * Optional host notification. Must never be required for correctness.
   */
  onStatus?(snapshot: EmbeddedContextSnapshot): void;
  onDiagnostic?(diagnostic: EmbeddedContextDiagnostic): void;
}

export interface EmbeddedContextManagerOptions {
  config?: Partial<LocalContextManagerConfig>;

  /**
   * Child-safe mode disables root-session-only features by default.
   */
  mode?: "root" | "managed-child";

  /**
   * Optional advertised model context window.
   */
  contextWindow?: number;
}

export interface EmbeddedToolResult {
  toolName: string;
  input: Record<string, unknown>;
  content: ReadonlyArray<ToolContentBlock>;
  details?: unknown;
  isError: boolean;
}

export interface EmbeddedContextManager {
  observeTurnStart(): void;
  observeTurnEnd(): void;

  /**
   * Host calls this only when the model/session is settled.
   * May request threshold compaction through host.compact().
   */
  observeSettled(): Promise<void>;

  /**
   * Returns transformed output when reduction is appropriate.
   * Must preserve current LCM recovery semantics.
   */
  transformToolResult(result: EmbeddedToolResult): Promise<EmbeddedToolResult>;

  snapshot(): EmbeddedContextSnapshot;
  dispose(): void;
}
