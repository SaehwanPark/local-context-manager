import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_COMPACTION_SETTINGS,
  findCutPoint,
  sessionEntryToContextMessages,
  type CompactOptions,
  type CompactionResult,
  type ExtensionAPI,
  type FileOperations,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { runHandoff } from "./handoff.js";
import {
  getCheckpointStorageDirectory,
  getLatestCheckpointResetRecord,
  getRepositoryState,
  listCheckpointFiles,
  runCheckpointReset,
} from "./checkpoint-reset.js";
import { getRearmTokens, CompactionGate, shouldTriggerThresholdCompaction } from "./policy.js";
import {
  CONTEXT_PROFILE_THRESHOLDS,
  DEFAULT_CONFIG,
  getEffectiveThresholds,
  loadConfig,
  type ContextProfile,
  type ContextThresholds,
  type LocalContextManagerConfig,
} from "./config.js";
import {
  ContextTelemetry,
  formatTelemetryDetails,
  formatTelemetryStatus,
} from "./telemetry.js";
import {
  appendFullOutputNotice,
  extractFullOutputPath,
  reduceToolOutput,
  type ToolContentBlock,
} from "./tool-output.js";

const EXTENSION_STATUS_KEY = "local-context-manager";
const SEMANTIC_COMPACTION_INSTRUCTIONS =
  "A meaningful task phase has completed. Preserve exact paths, decisions, verification, unresolved issues, and the next independent phase; do not preserve conversational filler.";
const SEMANTIC_PARAMETERS = Type.Object({
  reason: Type.Optional(Type.String({ description: "Short description of the completed phase" })),
});

type CompactionRequestReason = "threshold" | "semantic";

interface PendingCompaction {
  reason: CompactionRequestReason;
  generation: number;
  semanticReason?: string;
}

interface ObservedContext {
  tokens: number | null;
  thresholds: ContextThresholds;
}

interface PiPathSettings {
  agentDir: string;
  configDirName: string;
}

function debugLog(config: LocalContextManagerConfig, message: string, error?: unknown): void {
  if (!config.debug) {
    return;
  }
  if (error === undefined) {
    console.error(`[local-context-manager] ${message}`);
  } else {
    console.error(`[local-context-manager] ${message}`, error);
  }
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function countCompactions(entries: SessionEntry[]): { count: number; lastAt: number | null } {
  let count = 0;
  let lastAt: number | null = null;
  for (const entry of entries) {
    if (entry.type !== "compaction") {
      continue;
    }
    count += 1;
    const timestamp = parseTimestamp(entry.timestamp);
    if (timestamp !== null && (lastAt === null || timestamp > lastAt)) {
      lastAt = timestamp;
    }
  }
  return { count, lastAt };
}

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") {
    return Math.ceil(content.length / 4);
  }
  if (!Array.isArray(content)) {
    return 0;
  }

  let characters = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const value = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
    if (value.type === "text" && typeof value.text === "string") {
      characters += value.text.length;
    } else if (value.type === "thinking" && typeof value.thinking === "string") {
      characters += value.thinking.length;
    } else if (value.type === "toolCall") {
      const name = typeof value.name === "string" ? value.name.length : 0;
      let argumentsLength = 0;
      try {
        argumentsLength = JSON.stringify(value.arguments ?? {}).length;
      } catch {
        argumentsLength = 0;
      }
      characters += name + argumentsLength;
    } else if (value.type === "image") {
      characters += 4_800;
    }
  }
  return Math.ceil(characters / 4);
}

function estimateToolContentTokens(content: ReadonlyArray<ToolContentBlock>): number {
  return estimateContentTokens(content);
}

function estimateAgentMessageTokens(message: AgentMessage): number {
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return estimateContentTokens(message.content);
    case "bashExecution": {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      return Math.ceil((command.length + output.length) / 4);
    }
    case "branchSummary":
    case "compactionSummary":
      return typeof message.summary === "string" ? Math.ceil(message.summary.length / 4) : 0;
    default:
      return 0;
  }
}

function estimateActiveContextTokens(entries: SessionEntry[]): number {
  let tokens = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      tokens += estimateAgentMessageTokens(entry.message);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      tokens += typeof entry.summary === "string" ? Math.ceil(entry.summary.length / 4) : 0;
    } else if (entry.type === "custom_message") {
      tokens += estimateContentTokens(entry.content);
    }
  }
  return tokens;
}

function estimateActiveToolOutputTokens(entries: SessionEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") {
      return total;
    }
    return total + estimateToolContentTokens(entry.message.content);
  }, 0);
}

function cleanBoundaryReason(value: string | undefined): string | undefined {
  const reason = value?.replace(/\s+/g, " ").trim();
  return reason ? reason.slice(0, 240) : undefined;
}

function filePathFromToolArguments(argumentsValue: unknown): string | undefined {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return undefined;
  }
  const argumentsRecord = argumentsValue as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const path = argumentsRecord[key];
    if (typeof path === "string" && path.trim()) {
      return path.trim();
    }
  }
  return undefined;
}

function extendFileOperations(messages: AgentMessage[], fileOps: FileOperations): void {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "toolCall") {
        continue;
      }
      const path = filePathFromToolArguments(block.arguments);
      if (!path) {
        continue;
      }
      if (block.name === "read") {
        fileOps.read.add(path);
      } else if (block.name === "write") {
        fileOps.written.add(path);
      } else if (block.name === "edit") {
        fileOps.edited.add(path);
      }
    }
  }
}

async function getPiPathSettings(): Promise<PiPathSettings> {
  const fallback: PiPathSettings = {
    agentDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    configDirName: ".pi",
  };

  // These helpers are not needed for the core policy. Keeping them optional lets the
  // extension fall back to conventional paths if it is loaded by an older Pi build.
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    return {
      agentDir: typeof pi.getAgentDir === "function" ? pi.getAgentDir() : fallback.agentDir,
      configDirName: typeof pi.CONFIG_DIR_NAME === "string" ? pi.CONFIG_DIR_NAME : fallback.configDirName,
    };
  } catch {
    return fallback;
  }
}

async function saveRecoveryCopy(text: string): Promise<string | undefined> {
  try {
    const directory = await mkdtemp(join(tmpdir(), "pi-local-context-"));
    const path = join(directory, "tool-output.txt");
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

function resolveThresholds(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
): ContextThresholds {
  const contextWindow = telemetry.snapshot(config.compactThresholdTokens).contextWindow ?? context.model?.contextWindow;
  return getEffectiveThresholds(config, contextWindow);
}

function statusWithCeiling(
  telemetry: ContextTelemetry,
  thresholds: ContextThresholds,
): string {
  const snapshot = telemetry.snapshot(thresholds.compactThresholdTokens);
  const status = formatTelemetryStatus(snapshot);
  return snapshot.contextTokens !== null && snapshot.contextTokens >= thresholds.hardCeilingTokens
    ? `${status} · hard ceiling`
    : status;
}

function updateStatus(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
  thresholds?: ContextThresholds,
): void {
  try {
    if (!context.hasUI) {
      return;
    }
    const activeThresholds = thresholds ?? resolveThresholds(context, config, telemetry);
    context.ui.setStatus(
      EXTENSION_STATUS_KEY,
      config.enabled ? statusWithCeiling(telemetry, activeThresholds) : "off",
    );
  } catch (error) {
    // Completion callbacks may outlive a replaced session. Status cleanup is
    // best-effort and must not turn a native compaction failure into an
    // unhandled rejection through Pi's compact() callback wrapper.
    debugLog(config, "could not update extension status", error);
  }
}

function notifyUI(context: ExtensionContext, config: LocalContextManagerConfig, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (context.hasUI) {
      context.ui.notify(message, level);
    }
  } catch (error) {
    debugLog(config, "could not notify through stale extension context", error);
  }
}

function observeContext(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
  gate: CompactionGate,
): ObservedContext {
  const usage = context.getContextUsage();
  telemetry.observe(usage);
  if (usage?.tokens == null) {
    try {
      telemetry.observeEstimate(
        estimateActiveContextTokens(context.sessionManager.buildContextEntries()),
        usage?.contextWindow ?? context.model?.contextWindow,
      );
    } catch (error) {
      debugLog(config, "could not estimate active context", error);
    }
  }
  const thresholds = resolveThresholds(context, config, telemetry);
  gate.setRearmTokens(getRearmTokens(thresholds.softWarningTokens, thresholds.compactThresholdTokens));
  const snapshot = telemetry.snapshot(thresholds.compactThresholdTokens);
  gate.observe(snapshot.contextTokens);
  updateStatus(context, config, telemetry, thresholds);
  return { tokens: snapshot.contextTokens, thresholds };
}

function notifySoftWarning(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
  warned: { value: boolean },
  observed: ObservedContext,
): void {
  const { tokens, thresholds } = observed;
  if (tokens === null || warned.value || tokens < thresholds.softWarningTokens) {
    return;
  }
  warned.value = true;
  if (context.hasUI) {
    context.ui.notify(
      `Context is approaching the local-context-manager threshold (${Math.round(tokens).toLocaleString()} tokens).`,
      "warning",
    );
  }
  debugLog(config, `soft warning at ${tokens} tokens`);
  updateStatus(context, config, telemetry, thresholds);
}

function parseContextProfile(value: string): ContextProfile | undefined {
  if (value === "aggressive" || value === "balanced" || value === "relaxed") {
    return value;
  }
  return undefined;
}

function formatThresholdSummary(thresholds: ContextThresholds): string {
  return [
    `keep ${thresholds.keepRecentTokens.toLocaleString()}`,
    `warn ${thresholds.softWarningTokens.toLocaleString()}`,
    `compact ${thresholds.compactThresholdTokens.toLocaleString()}`,
    `ceiling ${thresholds.hardCeilingTokens.toLocaleString()}`,
  ].join(" · ");
}

interface CompactionSlice {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
}

function getCompactionSlice(entries: SessionEntry[], keepRecentTokens: number): CompactionSlice | undefined {
  if (entries.length === 0 || entries.at(-1)?.type === "compaction") {
    return undefined;
  }

  let previousCompactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === "compaction") {
      previousCompactionIndex = index;
      break;
    }
  }
  let boundaryStart = 0;
  if (previousCompactionIndex >= 0) {
    const previousCompaction = entries[previousCompactionIndex];
    if (previousCompaction.type === "compaction") {
      const keptIndex = entries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId);
      boundaryStart = keptIndex >= 0 ? keptIndex : previousCompactionIndex + 1;
    }
  }

  const cutPoint = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens);
  const firstKeptEntry = entries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  if (historyEnd < boundaryStart) {
    return undefined;
  }
  const messagesToSummarize = entries
    .slice(boundaryStart, historyEnd)
    .flatMap((entry) => (entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry)));
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? entries
        .slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
        .flatMap((entry) => (entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry)))
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return undefined;
  }
  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
  };
}

function hasPersistedCompaction(context: ExtensionContext, compactionId: string): boolean {
  try {
    const branch = context.sessionManager.getBranch();
    // Minimal hosts may not expose persisted entries; let Pi remain authoritative
    // when there is no branch to inspect.
    return branch.length === 0 || branch.some((entry) => entry.id === compactionId);
  } catch {
    return true;
  }
}

function hasNativeCompactionCandidate(context: ExtensionContext): boolean {
  try {
    // Pi performs this preparation before it emits session_before_compact. If
    // there are no messages before the native cut point, context.compact() can
    // only fail with "Nothing to compact". Use Pi's exported defaults for the
    // preflight because ExtensionContext does not expose active compaction
    // settings; the extension's smaller keepRecentTokens policy is applied only
    // after this native preflight succeeds.
    return getCompactionSlice(
      context.sessionManager.getBranch(),
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    ) !== undefined;
  } catch {
    // A host without a readable session branch should retain Pi's normal behavior
    // rather than making the extension's best-effort guard authoritative.
    return true;
  }
}

function buildCompactionOptions(
  reason: CompactionRequestReason,
  instructions: string | undefined,
  onComplete: (result: { estimatedTokensAfter?: number }) => void,
  onError: (error: Error) => void,
): CompactOptions {
  const options: CompactOptions = { onComplete, onError };
  if (reason === "semantic") {
    options.customInstructions = instructions || SEMANTIC_COMPACTION_INSTRUCTIONS;
  }
  return options;
}

async function buildCustomCompaction(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  thresholds: ContextThresholds,
): Promise<{ compaction: CompactionResult } | undefined> {
  const model = context.model;
  const nativeKeepRecentTokens = event.preparation.settings.keepRecentTokens;
  if (
    !config.enabled ||
    !model ||
    !Number.isFinite(nativeKeepRecentTokens) ||
    thresholds.keepRecentTokens >= nativeKeepRecentTokens
  ) {
    return undefined;
  }

  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    if (typeof pi.compact !== "function") {
      debugLog(config, "native compaction helpers are unavailable; using Pi's default compaction");
      return undefined;
    }

    const slice = getCompactionSlice(event.branchEntries, thresholds.keepRecentTokens);
    if (!slice) {
      return undefined;
    }
    const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn } = slice;
    const fileOps: FileOperations = {
      read: new Set(event.preparation.fileOps.read),
      written: new Set(event.preparation.fileOps.written),
      edited: new Set(event.preparation.fileOps.edited),
    };
    extendFileOperations(messagesToSummarize, fileOps);
    extendFileOperations(turnPrefixMessages, fileOps);

    const preparation = {
      ...event.preparation,
      firstKeptEntryId,
      messagesToSummarize,
      turnPrefixMessages,
      isSplitTurn,
      fileOps,
      settings: {
        ...event.preparation.settings,
        keepRecentTokens: thresholds.keepRecentTokens,
      },
    };

    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      debugLog(config, "could not resolve compaction authentication; using Pi's default compaction", auth.error);
      return undefined;
    }

    const headers = auth.headers
      ? Object.fromEntries(
          Object.entries(auth.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    const result = await pi.compact(
      preparation,
      model,
      auth.apiKey,
      headers,
      event.customInstructions,
      event.signal,
      context.thinkingLevel,
      undefined,
      auth.env,
    );
    if (!result.summary.trim() || !result.firstKeptEntryId) {
      debugLog(config, "native compaction returned no usable summary; using Pi's default compaction");
      return undefined;
    }
    return { compaction: result };
  } catch (error) {
    debugLog(config, "custom compaction failed; using Pi's default compaction", error);
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  let config: LocalContextManagerConfig = { ...DEFAULT_CONFIG };
  let pathSettings: PiPathSettings | undefined;
  let telemetry = new ContextTelemetry();
  let gate = new CompactionGate({
    rearmTokens: getRearmTokens(config.softWarningTokens, config.compactThresholdTokens),
  });
  const warned = { value: false };
  let turnSerial = 0;
  let sessionGeneration = 0;
  let semanticRequested = false;
  let semanticReason: string | undefined;
  let checkpointResetRequested = false;
  let checkpointResetReason: string | undefined;
  let requestedCompaction: PendingCompaction | undefined;

  const setSemanticRequest = (reason: string | undefined): void => {
    semanticRequested = true;
    semanticReason = cleanBoundaryReason(reason);
  };

  const setCheckpointResetRequest = (reason: string | undefined): void => {
    checkpointResetRequested = true;
    checkpointResetReason = cleanBoundaryReason(reason);
  };

  const restoreSemanticRequest = (pending: PendingCompaction): void => {
    if (pending.reason !== "semantic" || pending.generation !== sessionGeneration) {
      return;
    }
    semanticRequested = true;
    semanticReason = pending.semanticReason;
  };

  const runPiCommand = (command: string, args: string[], cwd: string) =>
    pi.exec(command, args, { cwd, timeout: 3_000 });

  const requestCompaction = (
    context: ExtensionContext,
    reason: CompactionRequestReason,
    instructions?: string,
  ): boolean => {
    if (!config.enabled || !context.isIdle()) {
      return false;
    }
    if (!hasNativeCompactionCandidate(context)) {
      debugLog(config, "skipping compaction: session has no summarizable history");
      return false;
    }
    if (!gate.canRequest(turnSerial, reason === "semantic") || !gate.request(turnSerial)) {
      return false;
    }

    const pending: PendingCompaction = {
      reason,
      generation: sessionGeneration,
      ...(reason === "semantic" && semanticReason !== undefined ? { semanticReason } : {}),
    };
    requestedCompaction = pending;
    semanticRequested = false;
    semanticReason = undefined;
    const isCurrentRequest = (): boolean =>
      requestedCompaction === pending && pending.generation === sessionGeneration;
    const options = buildCompactionOptions(
      reason,
      instructions,
      (result) => {
        // The session_compact event is the authoritative completion signal. This
        // callback is only a compatibility fallback for minimal test hosts.
        if (!isCurrentRequest()) {
          debugLog(config, "ignoring stale compaction completion callback");
          return;
        }
        if (gate.isInFlight) {
          gate.complete(result.estimatedTokensAfter ?? null, turnSerial);
          requestedCompaction = undefined;
          updateStatus(context, config, telemetry);
        }
      },
      (error) => {
        if (!isCurrentRequest()) {
          debugLog(config, "ignoring stale compaction failure callback", error);
          return;
        }
        if (gate.isInFlight) {
          gate.fail(turnSerial);
        }
        restoreSemanticRequest(pending);
        requestedCompaction = undefined;
        debugLog(config, "compaction request failed", error);
        notifyUI(context, config, `Context compaction failed: ${error.message}`, "warning");
        updateStatus(context, config, telemetry);
      },
    );

    try {
      context.compact(options);
      return true;
    } catch (error) {
      if (requestedCompaction === pending) {
        gate.fail(turnSerial);
        restoreSemanticRequest(pending);
        requestedCompaction = undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config, "could not start compaction", error);
      notifyUI(context, config, `Context compaction could not start: ${message}`, "warning");
      return false;
    }
  };

  const scheduleSettledCompaction = (
    context: ExtensionContext,
    reason: CompactionRequestReason,
    instructions?: string,
  ): void => {
    const generation = sessionGeneration;
    setImmediate(() => {
      if (generation !== sessionGeneration) {
        debugLog(config, "skipping settled compaction from a replaced session");
        return;
      }
      try {
        requestCompaction(context, reason, instructions);
      } catch (error) {
        // A host may tear down the session between agent_settled and this
        // deferred boundary. Compaction is best-effort and must not escape the
        // timer as an unhandled rejection.
        debugLog(config, "could not schedule settled compaction", error);
      }
    });
  };

  pi.on("session_start", async (event, context) => {
    const generation = sessionGeneration + 1;
    sessionGeneration = generation;
    requestedCompaction = undefined;
    semanticRequested = false;
    semanticReason = undefined;
    checkpointResetRequested = false;
    checkpointResetReason = undefined;

    const paths = await getPiPathSettings();
    if (generation !== sessionGeneration) {
      return;
    }
    pathSettings = paths;
    const loaded = await loadConfig({
      globalConfigPath: join(paths.agentDir, "local-context-manager.json"),
      projectConfigPath: join(context.cwd, paths.configDirName, "local-context-manager.json"),
      allowProjectConfig: context.isProjectTrusted(),
    });
    if (generation !== sessionGeneration) {
      return;
    }
    config = loaded.config;

    const branch = context.sessionManager.getBranch();
    const existing = countCompactions(branch);
    const checkpointReset = getLatestCheckpointResetRecord(branch);
    telemetry = new ContextTelemetry(
      existing.count,
      existing.lastAt,
      checkpointReset?.count ?? 0,
      checkpointReset?.createdAt ?? null,
      checkpointReset?.path ?? null,
    );
    const initialThresholds = getEffectiveThresholds(config, context.model?.contextWindow);
    gate = new CompactionGate({
      rearmTokens: getRearmTokens(initialThresholds.softWarningTokens, initialThresholds.compactThresholdTokens),
    });
    warned.value = false;
    turnSerial = 0;
    semanticRequested = false;
    semanticReason = undefined;
    checkpointResetRequested = false;
    checkpointResetReason = undefined;
    requestedCompaction = undefined;

    let activeEntries: SessionEntry[] = [];
    try {
      activeEntries = context.sessionManager.buildContextEntries();
      telemetry.setActiveToolOutputTokens(estimateActiveToolOutputTokens(activeEntries));
    } catch (error) {
      debugLog(config, "could not estimate active context", error);
    }
    observeContext(context, config, telemetry, gate);
    if (branch.some((entry) => entry.type === "compaction") && activeEntries.length > 0) {
      telemetry.setCompactionBaseline(estimateActiveContextTokens(activeEntries));
    }

    if (event.reason === "new") {
      // newSession() runs its setup callback after session_start, so recover the
      // reset marker once the new session's append-only state is available.
      setImmediate(() => {
        if (generation !== sessionGeneration) {
          return;
        }
        try {
          const latestReset = getLatestCheckpointResetRecord(context.sessionManager.getBranch());
          if (latestReset) {
            telemetry.markCheckpointReset(latestReset.createdAt, latestReset.path, latestReset.count);
            updateStatus(context, config, telemetry);
          }
        } catch (error) {
          debugLog(config, "could not restore checkpoint reset telemetry", error);
        }
      });
    }

    if (loaded.errors.length > 0) {
      const message = loaded.errors.join("; ");
      debugLog(config, message);
      if (context.hasUI) {
        context.ui.notify(`local-context-manager configuration warning: ${message}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", (_event, context) => {
    sessionGeneration += 1;
    requestedCompaction = undefined;
    semanticRequested = false;
    semanticReason = undefined;
    if (context.hasUI) {
      context.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
    }
  });

  pi.on("turn_start", (_event, context) => {
    turnSerial += 1;
    telemetry.markTurn(turnSerial);
    const observed = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, observed);
  });

  pi.on("turn_end", (_event, context) => {
    const observed = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, observed);

    // turn_end is the first boundary after all tool results have landed. Only use
    // it when the host reports idle; a continuing tool loop is handled at
    // agent_settled instead so native compact() cannot abort active work.
    if (
      config.enabled &&
      !semanticRequested &&
      context.isIdle() &&
      shouldTriggerThresholdCompaction(observed.tokens, observed.thresholds.compactThresholdTokens)
    ) {
      requestCompaction(context, "threshold");
    }
  });

  pi.on("agent_settled", (_event, context) => {
    const observed = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, observed);

    if (checkpointResetRequested) {
      const reason = checkpointResetReason;
      checkpointResetRequested = false;
      checkpointResetReason = undefined;
      if (context.hasUI) {
        context.ui.notify(
          `Checkpoint reset recommended${reason ? ` (${reason})` : ""}. No session change was made; review it with /checkpoint-reset${reason ? ` ${reason}` : ""}.`,
          "info",
        );
      }
    }

    if (semanticRequested && config.enabled && config.semanticCompaction) {
      scheduleSettledCompaction(
        context,
        "semantic",
        semanticReason
          ? `${SEMANTIC_COMPACTION_INSTRUCTIONS} Completed phase: ${semanticReason}`
          : SEMANTIC_COMPACTION_INSTRUCTIONS,
      );
      return;
    }
    if (config.enabled && shouldTriggerThresholdCompaction(observed.tokens, observed.thresholds.compactThresholdTokens)) {
      scheduleSettledCompaction(context, "threshold");
    }
  });

  pi.on("session_compact", (event, context) => {
    const pending = requestedCompaction;
    if (pending && pending.generation !== sessionGeneration) {
      debugLog(config, "ignoring stale compaction completion event");
      return;
    }
    if (!pending && !hasPersistedCompaction(context, event.compactionEntry.id)) {
      debugLog(config, `ignoring stale compaction completion event (${event.reason})`);
      return;
    }
    const usage = context.getContextUsage();
    telemetry.observe(usage);
    let activeEntries: SessionEntry[] = [];
    let activeToolOutputTokens = 0;
    try {
      activeEntries = context.sessionManager.buildContextEntries();
      activeToolOutputTokens = estimateActiveToolOutputTokens(activeEntries);
    } catch (error) {
      debugLog(config, "could not estimate post-compaction context", error);
    }
    const postTokens =
      usage?.tokens ?? (activeEntries.length > 0 ? estimateActiveContextTokens(activeEntries) : null);

    telemetry.markCompaction(
      parseTimestamp(event.compactionEntry.timestamp) ?? Date.now(),
      turnSerial,
      postTokens,
      activeToolOutputTokens,
    );
    const thresholds = resolveThresholds(context, config, telemetry);
    gate.setRearmTokens(getRearmTokens(thresholds.softWarningTokens, thresholds.compactThresholdTokens));
    gate.complete(postTokens, turnSerial);
    requestedCompaction = undefined;
    semanticRequested = false;
    semanticReason = undefined;
    warned.value = false;
    updateStatus(context, config, telemetry, thresholds);
    debugLog(config, `compaction completed (${event.reason})`);
  });

  pi.on("session_compact_failed", (event, context) => {
    const failedRequest = requestedCompaction;
    if (
      !failedRequest ||
      failedRequest.generation !== sessionGeneration ||
      event.reason !== "manual"
    ) {
      debugLog(config, `ignoring unrelated compaction failure (${event.reason})`, event.errorMessage);
      return;
    }
    if (gate.isInFlight) {
      gate.fail(turnSerial);
    }
    restoreSemanticRequest(failedRequest);
    requestedCompaction = undefined;
    const retryMessage = failedRequest.reason === "semantic" ? " The phase-boundary request was retained for a later turn." : "";
    notifyUI(
      context,
      config,
      `local-context-manager compaction did not complete: ${event.errorMessage ?? "cancelled"}.${retryMessage}`,
      "warning",
    );
    debugLog(config, `compaction failed (${event.reason})`, event.errorMessage);
    updateStatus(context, config, telemetry);
  });

  pi.on("tool_result", async (event, context) => {
    const generation = sessionGeneration;
    if (!config.enabled) {
      return;
    }

    if (!config.toolOutputReduction) {
      telemetry.recordToolOutput(estimateToolContentTokens(event.content));
      updateStatus(context, config, telemetry);
      return;
    }

    const reduction = reduceToolOutput({
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      details: event.details,
      isError: event.isError,
    });
    if (!reduction.changed) {
      telemetry.recordToolOutput(estimateToolContentTokens(event.content));
      updateStatus(context, config, telemetry);
      return;
    }

    let content = reduction.content;
    let fullOutputPath = extractFullOutputPath(event.details, reduction.originalText);
    if (!fullOutputPath) {
      fullOutputPath = await saveRecoveryCopy(reduction.originalText);
      if (generation !== sessionGeneration) {
        debugLog(config, "ignoring stale tool result after session change");
        return;
      }
    }
    if (!fullOutputPath) {
      // Do not discard recoverability when the host did not provide a full-output
      // path and the fallback copy could not be written.
      telemetry.recordToolOutput(reduction.originalTokens);
      updateStatus(context, config, telemetry);
      debugLog(config, "could not save full tool output; preserving the original result");
      return;
    }
    if (
      !content.some(
        (block) => block.type === "text" && block.text.toLowerCase().includes("full output") && block.text.includes(fullOutputPath),
      )
    ) {
      content = appendFullOutputNotice(content, fullOutputPath);
    }

    telemetry.recordToolReduction(reduction.originalTokens, reduction.retainedTokens);
    updateStatus(context, config, telemetry);
    debugLog(
      config,
      `reduced ${event.toolName} ${reduction.originalTokens} -> ${reduction.retainedTokens} tokens (${reduction.category})`,
    );
    return { content };
  });

  pi.on("session_before_compact", async (event, context) => {
    return buildCustomCompaction(event, context, config, resolveThresholds(context, config, telemetry));
  });

  pi.registerTool({
    name: "request_context_compaction",
    label: "Request context compaction",
    description:
      "Request context compaction after a meaningful task phase is complete. Use sparingly, not for routine turns.",
    promptSnippet: "Queue compaction after a meaningful completed phase",
    promptGuidelines: ["Use request_context_compaction only at meaningful phase boundaries, never on routine turns."],
    parameters: SEMANTIC_PARAMETERS,
    async execute(_toolCallId, params) {
      if (!config.enabled || !config.semanticCompaction) {
        return {
          content: [{ type: "text", text: "Semantic compaction is disabled; continue normally." }],
          details: { queued: false },
        };
      }
      setSemanticRequest(params.reason);
      return {
        content: [
          {
            type: "text",
            text: "Compaction request recorded for the end of this agent run. It may be skipped if the context is not idle, a compaction is already running, or cooldown is active; continue only with the next phase or final status.",
          },
        ],
        details: { queued: true },
      };
    },
  });

  pi.registerTool({
    name: "request_context_reset",
    label: "Request checkpoint reset",
    description:
      "Request a user-reviewed checkpoint reset after a completed semantic episode. This queues a recommendation only; it never writes a checkpoint or switches sessions.",
    promptSnippet: "Recommend a reviewed checkpoint reset after a completed semantic episode",
    promptGuidelines: [
      "Use request_context_reset only after a major semantic unit is complete and detailed context is unlikely to be needed immediately, such as a merged PR, resolved issue, completed release, deployment, investigation, experiment, or accepted independent milestone.",
      "Do not use request_context_reset during routine coding, active debugging, review, or closely related follow-up work.",
      "request_context_reset only recommends /checkpoint-reset; it never resets the session without explicit user approval.",
    ],
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "Short description of the completed episode" })),
    }),
    async execute(_toolCallId, params) {
      if (!config.enabled || !config.checkpointReset) {
        return {
          content: [{ type: "text", text: "Checkpoint reset is disabled; continue normally." }],
          details: { queued: false },
        };
      }
      setCheckpointResetRequest(params.reason);
      return {
        content: [
          {
            type: "text",
            text: "Checkpoint reset recommendation recorded. No checkpoint was written and no session was changed. After this agent run settles, ask the user to review and invoke /checkpoint-reset if the boundary is still appropriate.",
          },
        ],
        details: {
          queued: true,
          ...(checkpointResetReason ? { reason: checkpointResetReason } : {}),
        },
      };
    },
  });

  pi.registerCommand("context-stats", {
    description: "Show local context telemetry",
    handler: async (_args, context) => {
      const observed = observeContext(context, config, telemetry, gate);
      const snapshot = telemetry.snapshot(observed.thresholds.compactThresholdTokens);
      const details = [
        formatTelemetryDetails(snapshot),
        `Context mode: ${config.contextProfile}`,
        `Effective thresholds: ${formatThresholdSummary(observed.thresholds)}`,
        `Soft warning: ${observed.thresholds.softWarningTokens.toLocaleString()} tokens`,
        `Hard ceiling: ${observed.thresholds.hardCeilingTokens.toLocaleString()} tokens`,
        `Enabled: ${config.enabled ? "yes" : "no"}`,
        `Current reading: ${observed.tokens === null ? "unknown" : `${Math.round(observed.tokens).toLocaleString()} tokens`}`,
      ].join("\n");
      if (context.hasUI) {
        context.ui.notify(details, "info");
      } else if (config.debug) {
        console.error(details);
      }
    },
  });

  pi.registerCommand("context-mode", {
    description: "Show or set context mode: aggressive, balanced, or relaxed",
    handler: async (args, context) => {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        const observed = observeContext(context, config, telemetry, gate);
        const snapshot = telemetry.snapshot(observed.thresholds.compactThresholdTokens);
        const details = [
          `Context mode: ${config.contextProfile}`,
          `Effective thresholds: ${formatThresholdSummary(observed.thresholds)}`,
          `Context window: ${snapshot.contextWindow === null ? "not reported" : `${Math.round(snapshot.contextWindow).toLocaleString()} tokens`}`,
        ].join("\n");
        if (context.hasUI) {
          context.ui.notify(details, "info");
        } else if (config.debug) {
          console.error(details);
        }
        return;
      }

      const profile = parseContextProfile(requested);
      if (!profile) {
        if (context.hasUI) {
          context.ui.notify("Usage: /context-mode [aggressive|balanced|relaxed]", "error");
        } else {
          debugLog(config, "Usage: /context-mode [aggressive|balanced|relaxed]");
        }
        return;
      }

      config = {
        ...config,
        contextProfile: profile,
        ...CONTEXT_PROFILE_THRESHOLDS[profile],
      };
      warned.value = false;
      const observed = observeContext(context, config, telemetry, gate);
      const snapshot = telemetry.snapshot(observed.thresholds.compactThresholdTokens);
      const details = [
        `Context mode set to ${profile} for this session.`,
        `Effective thresholds: ${formatThresholdSummary(observed.thresholds)}`,
        `Context window: ${snapshot.contextWindow === null ? "not reported" : `${Math.round(snapshot.contextWindow).toLocaleString()} tokens`}`,
        `To make it persistent, set \"contextProfile\": \"${profile}\" in local-context-manager.json.`,
      ].join("\n");
      if (context.hasUI) {
        context.ui.notify(details, "info");
      } else if (config.debug) {
        console.error(details);
      }
    },
  });

  pi.registerCommand("compact-phase", {
    description: "Compact context at an intentional task-phase boundary",
    handler: async (args, context) => {
      if (!config.enabled || !config.semanticCompaction) {
        context.ui.notify("Semantic compaction is disabled", "warning");
        return;
      }
      await context.waitForIdle();
      const reason = cleanBoundaryReason(args);
      const instructions = reason
        ? `${SEMANTIC_COMPACTION_INSTRUCTIONS} Completed phase: ${reason}`
        : SEMANTIC_COMPACTION_INSTRUCTIONS;
      if (!requestCompaction(context, "semantic", instructions)) {
        context.ui.notify("No compaction was started (cooldown, already running, or insufficient history)", "info");
      }
    },
  });

  pi.registerCommand("checkpoint-reset", {
    description: "Archive a completed episode and start a reviewed fresh session",
    handler: async (args, context) => {
      if (!config.enabled || !config.checkpointReset) {
        context.ui.notify("Checkpoint reset is disabled", "warning");
        return;
      }
      const paths = pathSettings ?? (await getPiPathSettings());
      await runCheckpointReset(args, context, {
        config,
        agentDir: paths.agentDir,
        runCommand: runPiCommand,
        previousResetCount: telemetry.snapshot(config.compactThresholdTokens).checkpointResets,
      });
    },
  });

  pi.registerCommand("context-checkpoints", {
    description: "List recent local context checkpoints for this repository",
    handler: async (_args, context) => {
      if (!config.enabled || !config.checkpointReset) {
        context.ui.notify("Checkpoint reset is disabled", "warning");
        return;
      }

      const paths = pathSettings ?? (await getPiPathSettings());
      const state = await getRepositoryState(context.cwd, runPiCommand);
      try {
        const directory = getCheckpointStorageDirectory(config, paths.agentDir, context.cwd, state);
        const checkpoints = await listCheckpointFiles(directory);
        const details = checkpoints.length === 0
          ? `No checkpoints found for this repository.\nDirectory: ${directory}`
          : [
              `Recent checkpoints (${checkpoints.length}):`,
              ...checkpoints.map(
                (checkpoint) => `${checkpoint.createdAt} · ${checkpoint.reason} · ${checkpoint.path}`,
              ),
            ].join("\n");
        if (context.hasUI) {
          context.ui.notify(details, "info");
        } else if (config.debug) {
          console.error(details);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.ui.notify(`Could not list checkpoints: ${message}`, "warning");
      }
    },
  });

  pi.registerCommand("handoff", {
    description: "Draft a reviewed continuation prompt in a new session",
    handler: async (args, context: ExtensionCommandContext) => {
      if (!config.enabled || !config.handoff) {
        context.ui.notify("Session handoff is disabled", "warning");
        return;
      }
      const goal = args.trim();
      if (!goal) {
        context.ui.notify("Usage: /handoff <objective for the new session>", "error");
        return;
      }
      await context.waitForIdle();
      await runHandoff(goal, context);
    },
  });
}
