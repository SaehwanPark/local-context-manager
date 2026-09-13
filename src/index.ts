import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  DEFAULT_COMPACTION_SETTINGS,
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
  formatTokenSourceDescription,
} from "./telemetry.js";
import {
  appendFullOutputNotice,
  appendPrunedOutputNotice,
  extractFullOutputPath,
  getSessionRecoveryStorage,
  reduceToolOutput,
  setRecoveryStorageDiagnostics,
  touchSessionLease,
} from "./tool-output.js";
import {
  cleanBoundaryReason,
  countCompactions,
  estimateActiveContextTokens,
  estimateActiveToolOutputTokens,
  estimateToolContentTokens,
  extendFileOperations,
  getCompactionSlice,
  parseTimestamp,
} from "./session-utils.js";
import {
  attachEvidenceCompletenessNote,
  EvidenceReductionTracker,
  EVIDENCE_COMPLETENESS_NOTE,
} from "./evidence-provenance.js";
import {
  createEmbeddedContextManager,
  getInteropProvider,
  getInteropStatus,
  LCM_EMBEDDED_CONTEXT_PROVIDER_NAME,
  queryFabricObservation,
  registerInteropProvider,
  resolveSessionId,
  type FabricObservation,
} from "./embedded/index.js";

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

async function getPiPathSettings(): Promise<PiPathSettings> {
  const fallback: PiPathSettings = {
    agentDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    configDirName: ".pi",
  };

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
  gate.observe(snapshot.contextTokens, thresholds.compactThresholdTokens);
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
  evidenceNote?: string,
): CompactOptions {
  const options: CompactOptions = { onComplete, onError };
  let finalInstructions = instructions;
  if (reason === "semantic") {
    finalInstructions = instructions || SEMANTIC_COMPACTION_INSTRUCTIONS;
  }
  if (evidenceNote) {
    finalInstructions = finalInstructions ? `${finalInstructions}\n\n${evidenceNote}` : evidenceNote;
  }
  if (finalInstructions) {
    options.customInstructions = finalInstructions;
  }
  return options;
}

async function buildCustomCompaction(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  thresholds: ContextThresholds,
  hasEvidenceReduction = false,
): Promise<{ compaction: CompactionResult } | undefined> {
  const model = context.model;
  const nativeKeepRecentTokens = event.preparation.settings.keepRecentTokens;
  if (
    !config.enabled ||
    event.reason === "overflow" ||
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
    if (hasEvidenceReduction) {
      result.summary = attachEvidenceCompletenessNote(result.summary);
    }
    return { compaction: result };
  } catch (error) {
    debugLog(config, "custom compaction failed; using Pi's default compaction", error);
    return undefined;
  }
}

// LCM embedded controller provider instance registered once at module scope
// for the Pi process lifetime so child agents and peers can discover it.
const embeddedContextProvider = Object.freeze({
  version: 1,
  createEmbeddedContextManager,
});

const embeddedProviderRegistration = registerInteropProvider(
  LCM_EMBEDDED_CONTEXT_PROVIDER_NAME,
  embeddedContextProvider,
);

function interopRegistrationProblem(): string | undefined {
  if (embeddedProviderRegistration) {
    return undefined;
  }
  const status = getInteropStatus();
  return status.shared
    ? `${LCM_EMBEDDED_CONTEXT_PROVIDER_NAME} was already registered by another module instance, so that provider stays in place for this process`
    : `the extension interop registry v${status.publishedVersion} is not understood by local-context-manager, so its providers are invisible to each other`;
}

export default function (pi: ExtensionAPI): void {
  // `config` is what every call site reads; `fileConfig` keeps the loaded files
  // verbatim so a session profile switch can be dropped without a restart.
  let config: LocalContextManagerConfig = { ...DEFAULT_CONFIG };
  let fileConfig: LocalContextManagerConfig = { ...DEFAULT_CONFIG };
  let profileOverride: ContextProfile | undefined;
  let pathSettings: PiPathSettings | undefined;
  let telemetry = new ContextTelemetry();
  let gate = new CompactionGate({
    rearmTokens: getRearmTokens(config.softWarningTokens, config.compactThresholdTokens),
  });
  const evidenceTracker = new EvidenceReductionTracker();
  let semanticResetDeferredNotified = false;
  let semanticCompactionDeferredNotified = false;
  const warned = { value: false };
  let turnSerial = 0;
  let sessionGeneration = 0;
  let semanticRequested = false;
  let semanticReason: string | undefined;
  let seenCompactionIds = new Set<string>();
  const retiredCompactionIds = new Set<string>();
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

  const rememberCompactionId = (id: string, target: Set<string>): void => {
    target.add(id);
    while (target.size > 2_048) {
      const oldest = target.values().next().value as string | undefined;
      if (oldest === undefined) break;
      target.delete(oldest);
    }
  };

  const retireSeenCompactions = (): void => {
    for (const id of seenCompactionIds) {
      rememberCompactionId(id, retiredCompactionIds);
    }
    seenCompactionIds = new Set<string>();
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
    if (reason === "semantic") {
      semanticRequested = false;
      semanticReason = undefined;
    }
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
      evidenceTracker.hasReducedSinceLastCompaction ? EVIDENCE_COMPLETENESS_NOTE : undefined,
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
    retireSeenCompactions();
    requestedCompaction = undefined;
    semanticRequested = false;
    semanticReason = undefined;
    checkpointResetRequested = false;
    checkpointResetReason = undefined;
    evidenceTracker.markCompaction();
    semanticResetDeferredNotified = false;
    semanticCompactionDeferredNotified = false;

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
    fileConfig = loaded.config;
    profileOverride = undefined;
    config = loaded.config;
    setRecoveryStorageDiagnostics((message) => debugLog(config, message));

    const branch = context.sessionManager.getBranch();
    seenCompactionIds = new Set(
      branch.flatMap((entry) => (entry.type === "compaction" && entry.id ? [entry.id] : [])),
    );
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

    // Registration happens at module load, before any context exists to report
    // through; a lost or shadowed provider is otherwise invisible until a peer
    // silently fails to find it.
    const interopProblem = interopRegistrationProblem();
    if (interopProblem) {
      debugLog(config, `interop registration: ${interopProblem}`);
      notifyUI(context, config, `local-context-manager integration warning: ${interopProblem}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, context) => {
    sessionGeneration += 1;
    retireSeenCompactions();
    requestedCompaction = undefined;
    semanticRequested = false;
    semanticReason = undefined;
    semanticCompactionDeferredNotified = false;
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

  pi.on("agent_settled", async (_event, context) => {
    let currentSessionId: string | undefined;
    try {
      currentSessionId = resolveSessionId(context.sessionManager);
    } catch {
      currentSessionId = undefined;
    }
    void touchSessionLease(currentSessionId).catch(() => undefined);

    const observed = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, observed);

    const needsFabric = Boolean(
      (checkpointResetRequested && config.enabled && config.checkpointReset) ||
      (semanticRequested && config.enabled && config.semanticCompaction),
    );

    let observation: FabricObservation = { kind: "absent" };
    if (needsFabric) {
      observation = await queryFabricObservation({
        cwd: context.cwd,
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      });
    }

    // The safe-agent provider owns the quiescence definition. Reproducing only
    // part of that definition here would silently become unsafe when the
    // provider adds another non-quiescence reason (for example, a pending root
    // request). The one deliberate exception is the known root-only projection
    // lag that can remain briefly after Pi emits agent_settled.
    const isRootOnlyLag = Boolean(
      observation.kind === "known" &&
        observation.snapshot.active &&
        !observation.snapshot.quiescent &&
        observation.snapshot.quiescenceReasons?.length === 1 &&
        observation.snapshot.quiescenceReasons[0] === "root_agent_active_or_running",
    );

    const deferFabricWork =
      observation.kind === "uncertain" ||
      (observation.kind === "known" &&
        observation.snapshot.active &&
        !observation.snapshot.quiescent &&
        !isRootOnlyLag);

    if (checkpointResetRequested) {
      const reason = checkpointResetReason;
      const atHardCeiling =
        observed.tokens !== null && observed.tokens >= observed.thresholds.hardCeilingTokens;

      if (deferFabricWork && !atHardCeiling) {
        debugLog(config, "automatic semantic reset deferred: active safe-agent fabric is not quiescent");
        if (context.hasUI && !semanticResetDeferredNotified) {
          semanticResetDeferredNotified = true;
          context.ui.notify(
            "Checkpoint reset recommendation deferred: delegated child agents are still active.",
            "info",
          );
        }
      } else {
        checkpointResetRequested = false;
        checkpointResetReason = undefined;
        semanticResetDeferredNotified = false;
        if (context.hasUI) {
          const suffix = reason ? ` (${reason})` : "";
          const ceilingWarning =
            atHardCeiling && deferFabricWork
              ? " [hard ceiling reached; proceeding with fabric snapshot]"
              : "";
          context.ui.notify(
            `Checkpoint reset recommended${suffix}${ceilingWarning}. No session change was made; review it with /checkpoint-reset${suffix}.`,
            "info",
          );
        }
      }
    }

    if (semanticRequested && config.enabled && config.semanticCompaction) {
      if (deferFabricWork) {
        debugLog(config, "semantic compaction deferred: active safe-agent fabric is not quiescent");
        if (context.hasUI && !semanticCompactionDeferredNotified) {
          semanticCompactionDeferredNotified = true;
          context.ui.notify(
            "Semantic compaction deferred: delegated child agents are still active.",
            "info",
          );
        }
      } else {
        semanticCompactionDeferredNotified = false;
        scheduleSettledCompaction(
          context,
          "semantic",
          semanticReason
            ? `${SEMANTIC_COMPACTION_INSTRUCTIONS} Completed phase: ${semanticReason}`
            : SEMANTIC_COMPACTION_INSTRUCTIONS,
        );
        return;
      }
    }
    if (config.enabled && shouldTriggerThresholdCompaction(observed.tokens, observed.thresholds.compactThresholdTokens)) {
      scheduleSettledCompaction(context, "threshold");
    }
  });

  pi.on("session_compact", (event, context) => {
    const compactionId = event.compactionEntry.id;
    const pending = requestedCompaction;
    if (seenCompactionIds.has(compactionId) || retiredCompactionIds.has(compactionId)) {
      debugLog(config, `ignoring duplicate or stale compaction completion event (${event.reason})`);
      return;
    }
    if (pending && pending.generation !== sessionGeneration) {
      debugLog(config, "ignoring stale compaction completion event");
      return;
    }
    if (!pending && !hasPersistedCompaction(context, compactionId)) {
      debugLog(config, `ignoring stale compaction completion event (${event.reason})`);
      return;
    }
    rememberCompactionId(compactionId, seenCompactionIds);
    evidenceTracker.markCompaction();
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
    const tokenSource = usage?.tokens != null ? "pi-estimate" : "local-fallback";

    telemetry.markCompaction(
      parseTimestamp(event.compactionEntry.timestamp) ?? Date.now(),
      turnSerial,
      postTokens,
      activeToolOutputTokens,
      tokenSource,
    );
    const thresholds = resolveThresholds(context, config, telemetry);
    gate.setRearmTokens(getRearmTokens(thresholds.softWarningTokens, thresholds.compactThresholdTokens));
    gate.complete(postTokens, turnSerial);
    requestedCompaction = undefined;
    if (pending?.reason === "semantic" || event.reason === "manual") {
      semanticRequested = false;
      semanticReason = undefined;
      semanticCompactionDeferredNotified = false;
    }
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

    let currentSessionId: string | undefined;
    try {
      currentSessionId = resolveSessionId(context.sessionManager);
    } catch {
      currentSessionId = undefined;
    }

    const recoveryStorage = getSessionRecoveryStorage(currentSessionId);
    // A read of a recovery copy keeps that copy alive through the next eviction,
    // and a failed read of one this session already deleted must say so instead
    // of returning an unexplained ENOENT for a path the transcript still names.
    recoveryStorage.noteReferences(event.input);
    if (event.isError) {
      const pruned = recoveryStorage.findPrunedReferences(event.input);
      if (pruned.length > 0) {
        telemetry.recordToolOutput(estimateToolContentTokens(event.content));
        updateStatus(context, config, telemetry);
        debugLog(config, `explaining ${pruned.length} pruned recovery reference(s) to a failed tool result`);
        return { content: appendPrunedOutputNotice(event.content, pruned) };
      }
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
      fullOutputPath = await recoveryStorage.save(reduction.originalText, event.toolName);
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
    if (reduction.category) {
      evidenceTracker.record(reduction.category);
    }
    if (
      !content.some(
        (block) => block.type === "text" && block.text.toLowerCase().includes("full output") && block.text.includes(fullOutputPath),
      )
    ) {
      content = appendFullOutputNotice(content, fullOutputPath, recoveryStorage.retentionNote);
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
    // 1. Overflow compaction: return undefined unconditionally so Pi recovers
    //    natively without deepening prefill on an already-pressured model.
    // 2. Threshold/manual compaction: return undefined so Pi's native preparation
    //    (~20k kept tokens) is used rather than deepening summarization prefill.
    // 3. Explicit semantic phase compaction: must be correlated to LCM's manual
    //    compaction request; uses LCM's custom slice to preserve phase boundary
    //    instructions and evidence reduction notes.
    if (event.reason !== "manual" || requestedCompaction?.reason !== "semantic") {
      return undefined;
    }
    return buildCustomCompaction(
      event,
      context,
      config,
      resolveThresholds(context, config, telemetry),
      evidenceTracker.hasReducedSinceLastCompaction,
    );
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

  const contextModeSummary = (): string =>
    profileOverride
      ? `${config.contextProfile} (session override; /context-mode reset restores local-context-manager.json)`
      : `${config.contextProfile} (local-context-manager.json)`;

  const reportContextStats = async (_args: string, context: ExtensionCommandContext) => {
    const observed = observeContext(context, config, telemetry, gate);
    const snapshot = telemetry.snapshot(observed.thresholds.compactThresholdTokens);

    const embeddedAvailable = getInteropProvider(LCM_EMBEDDED_CONTEXT_PROVIDER_NAME) !== undefined;
    let fabricStatus = "unavailable";
    let currentSessionId: string | undefined;
    try {
      currentSessionId = resolveSessionId(context.sessionManager);
    } catch {
      currentSessionId = undefined;
    }

    const observation = await queryFabricObservation({
      cwd: context.cwd,
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
    });

    if (observation.kind === "absent") {
      fabricStatus = "unavailable";
    } else if (observation.kind === "uncertain") {
      fabricStatus = `uncertain (${observation.reason})`;
    } else {
      const snap = observation.snapshot;
      if (!snap.active) {
        fabricStatus = "inactive";
      } else if (snap.quiescent) {
        fabricStatus = "active (quiescent)";
      } else {
        const reasons =
          snap.quiescenceReasons && snap.quiescenceReasons.length > 0
            ? `: ${snap.quiescenceReasons.join(", ")}`
            : "";
        fabricStatus = `active (busy${reasons})`;
      }
    }

    const isFabricBusy = observation.kind === "known" && !observation.snapshot.quiescent;
    const isFabricUncertainOrBusy = observation.kind === "uncertain" || isFabricBusy;

    const semanticResetStatus = checkpointResetRequested
      ? (isFabricUncertainOrBusy ? "deferred by active fabric" : "ready")
      : "ready";
    const semanticCompactionStatus = semanticRequested
      ? (isFabricUncertainOrBusy ? "deferred by active fabric" : "queued")
      : "none";

    const interopStatus = getInteropStatus();
    const details = [
      formatTelemetryDetails(snapshot),
      `Context source: ${formatTokenSourceDescription(snapshot.tokenSource)}`,
      `Embedded provider: ${embeddedAvailable ? "available" : "unavailable"}`,
      `Interop registry: ${
        interopStatus.shared
          ? `v${interopStatus.publishedVersion} (shared)`
          : `v${interopStatus.publishedVersion} (not understood; LCM providers are private to this process)`
      }`,
      `Fabric provider: ${fabricStatus}`,
      `Semantic reset: ${semanticResetStatus}`,
      `Semantic compaction: ${semanticCompactionStatus}`,
      `Reduced outputs since compaction: ${evidenceTracker.reducedSinceLastCompactionCount}`,
      `Recovery copies pruned: ${getSessionRecoveryStorage(currentSessionId).prunedFileCount}`,
      `Context mode: ${contextModeSummary()}`,
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
  };

  pi.registerCommand("context-stats", {
    description: "Show local context telemetry and integration diagnostics",
    handler: reportContextStats,
  });

  pi.registerCommand("context-status", {
    description: "Show local context telemetry and integration diagnostics",
    handler: reportContextStats,
  });

  pi.registerCommand("context-mode", {
    description: "Show or set context mode: aggressive, balanced, relaxed, or reset",
    handler: async (args, context) => {
      const requested = args.trim().toLowerCase();
      const usage = "Usage: /context-mode [aggressive|balanced|relaxed|reset]";
      if (!requested) {
        const observed = observeContext(context, config, telemetry, gate);
        const snapshot = telemetry.snapshot(observed.thresholds.compactThresholdTokens);
        const details = [
          `Context mode: ${contextModeSummary()}`,
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

      if (requested === "reset" || requested === "config") {
        if (profileOverride === undefined) {
          const message = `No session override is active; thresholds already come from local-context-manager.json (${config.contextProfile}).`;
          if (context.hasUI) {
            context.ui.notify(message, "info");
          } else {
            debugLog(config, message);
          }
          return;
        }
        profileOverride = undefined;
        config = { ...fileConfig };
        warned.value = false;
        const observed = observeContext(context, config, telemetry, gate);
        const details = [
          "Session profile override removed.",
          `Context mode: ${contextModeSummary()}`,
          `Effective thresholds: ${formatThresholdSummary(observed.thresholds)}`,
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
          context.ui.notify(usage, "error");
        } else {
          debugLog(config, usage);
        }
        return;
      }

      profileOverride = profile;
      config = {
        ...fileConfig,
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
        "Thresholds you set in local-context-manager.json are replaced for this session; /context-mode reset restores them.",
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
        const directory = getCheckpointStorageDirectory(config, paths.agentDir, state);
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
