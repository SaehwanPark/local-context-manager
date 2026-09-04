import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  CompactOptions,
  CompactionResult,
  ExtensionAPI,
  FileOperations,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { runHandoff } from "./handoff.js";
import { getRearmTokens, CompactionGate, shouldTriggerThresholdCompaction } from "./policy.js";
import {
  DEFAULT_CONFIG,
  loadConfig,
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

function statusWithCeiling(
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
): string {
  const snapshot = telemetry.snapshot(config.compactThresholdTokens);
  const status = formatTelemetryStatus(snapshot);
  return snapshot.contextTokens !== null && snapshot.contextTokens >= config.hardCeilingTokens
    ? `${status} · hard ceiling`
    : status;
}

function updateStatus(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
): void {
  if (!context.hasUI) {
    return;
  }
  context.ui.setStatus(
    EXTENSION_STATUS_KEY,
    config.enabled ? statusWithCeiling(config, telemetry) : "off",
  );
}

function observeContext(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
  gate: CompactionGate,
): number | null {
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
  const snapshot = telemetry.snapshot(config.compactThresholdTokens);
  gate.observe(snapshot.contextTokens);
  updateStatus(context, config, telemetry);
  return snapshot.contextTokens;
}

function notifySoftWarning(
  context: ExtensionContext,
  config: LocalContextManagerConfig,
  telemetry: ContextTelemetry,
  warned: { value: boolean },
  tokens: number | null,
): void {
  if (tokens === null || warned.value || tokens < config.softWarningTokens) {
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
  updateStatus(context, config, telemetry);
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
): Promise<{ compaction: CompactionResult } | undefined> {
  const model = context.model;
  const nativeKeepRecentTokens = event.preparation.settings.keepRecentTokens;
  if (
    !config.enabled ||
    !model ||
    !Number.isFinite(nativeKeepRecentTokens) ||
    config.keepRecentTokens >= nativeKeepRecentTokens
  ) {
    return undefined;
  }

  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    if (
      typeof pi.findCutPoint !== "function" ||
      typeof pi.sessionEntryToContextMessages !== "function" ||
      typeof pi.compact !== "function"
    ) {
      debugLog(config, "native compaction helpers are unavailable; using Pi's default compaction");
      return undefined;
    }

    if (event.branchEntries.at(-1)?.type === "compaction") {
      return undefined;
    }

    let previousCompactionIndex = -1;
    for (let index = event.branchEntries.length - 1; index >= 0; index--) {
      if (event.branchEntries[index].type === "compaction") {
        previousCompactionIndex = index;
        break;
      }
    }
    let boundaryStart = 0;
    if (previousCompactionIndex >= 0) {
      const previousCompaction = event.branchEntries[previousCompactionIndex];
      if (previousCompaction.type === "compaction") {
        const keptIndex = event.branchEntries.findIndex(
          (entry) => entry.id === previousCompaction.firstKeptEntryId,
        );
        boundaryStart = keptIndex >= 0 ? keptIndex : previousCompactionIndex + 1;
      }
    }

    const cutPoint = pi.findCutPoint(
      event.branchEntries,
      boundaryStart,
      event.branchEntries.length,
      config.keepRecentTokens,
    );
    const firstKeptEntry = event.branchEntries[cutPoint.firstKeptEntryIndex];
    if (!firstKeptEntry?.id) {
      return undefined;
    }

    const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
    if (historyEnd < boundaryStart) {
      return undefined;
    }
    const messagesToSummarize = event.branchEntries
      .slice(boundaryStart, historyEnd)
      .flatMap((entry) => (entry.type === "compaction" ? [] : pi.sessionEntryToContextMessages(entry)));
    const turnPrefixMessages = cutPoint.isSplitTurn
      ? event.branchEntries
          .slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
          .flatMap((entry) => (entry.type === "compaction" ? [] : pi.sessionEntryToContextMessages(entry)))
      : [];
    if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
      return undefined;
    }

    const fileOps: FileOperations = {
      read: new Set(event.preparation.fileOps.read),
      written: new Set(event.preparation.fileOps.written),
      edited: new Set(event.preparation.fileOps.edited),
    };
    extendFileOperations(messagesToSummarize, fileOps);
    extendFileOperations(turnPrefixMessages, fileOps);

    const preparation = {
      ...event.preparation,
      firstKeptEntryId: firstKeptEntry.id,
      messagesToSummarize,
      turnPrefixMessages,
      isSplitTurn: cutPoint.isSplitTurn,
      fileOps,
      settings: {
        ...event.preparation.settings,
        keepRecentTokens: config.keepRecentTokens,
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
  let telemetry = new ContextTelemetry();
  let gate = new CompactionGate({
    rearmTokens: getRearmTokens(config.softWarningTokens, config.compactThresholdTokens),
  });
  const warned = { value: false };
  let turnSerial = 0;
  let semanticRequested = false;
  let semanticReason: string | undefined;
  let requestedCompaction: CompactionRequestReason | undefined;

  const setSemanticRequest = (reason: string | undefined): void => {
    semanticRequested = true;
    semanticReason = cleanBoundaryReason(reason);
  };

  const requestCompaction = (
    context: ExtensionContext,
    reason: CompactionRequestReason,
    instructions?: string,
  ): boolean => {
    if (!config.enabled || !context.isIdle()) {
      return false;
    }
    if (!gate.canRequest(turnSerial, reason === "semantic") || !gate.request(turnSerial)) {
      return false;
    }

    requestedCompaction = reason;
    semanticRequested = false;
    semanticReason = undefined;
    const options = buildCompactionOptions(
      reason,
      instructions,
      (result) => {
        // The session_compact event is the authoritative completion signal. This
        // callback is only a compatibility fallback for minimal test hosts.
        if (gate.isInFlight) {
          gate.complete(result.estimatedTokensAfter ?? null, turnSerial);
          requestedCompaction = undefined;
          updateStatus(context, config, telemetry);
        }
      },
      (error) => {
        if (gate.isInFlight) {
          gate.fail();
        }
        const failedRequest = requestedCompaction;
        requestedCompaction = undefined;
        debugLog(config, "compaction request failed", error);
        if (failedRequest && context.hasUI) {
          context.ui.notify(`Context compaction failed: ${error.message}`, "warning");
        }
        updateStatus(context, config, telemetry);
      },
    );

    try {
      context.compact(options);
      return true;
    } catch (error) {
      gate.fail();
      requestedCompaction = undefined;
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config, "could not start compaction", error);
      if (context.hasUI) {
        context.ui.notify(`Context compaction could not start: ${message}`, "warning");
      }
      return false;
    }
  };

  pi.on("session_start", async (_event, context) => {
    const paths = await getPiPathSettings();
    const loaded = await loadConfig({
      globalConfigPath: join(paths.agentDir, "local-context-manager.json"),
      projectConfigPath: join(context.cwd, paths.configDirName, "local-context-manager.json"),
      allowProjectConfig: context.isProjectTrusted(),
    });
    config = loaded.config;

    const branch = context.sessionManager.getBranch();
    const existing = countCompactions(branch);
    telemetry = new ContextTelemetry(existing.count, existing.lastAt);
    gate = new CompactionGate({
      rearmTokens: getRearmTokens(config.softWarningTokens, config.compactThresholdTokens),
    });
    warned.value = false;
    turnSerial = 0;
    semanticRequested = false;
    semanticReason = undefined;
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

    if (loaded.errors.length > 0) {
      const message = loaded.errors.join("; ");
      debugLog(config, message);
      if (context.hasUI) {
        context.ui.notify(`local-context-manager configuration warning: ${message}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", (_event, context) => {
    if (context.hasUI) {
      context.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
    }
  });

  pi.on("turn_start", (_event, context) => {
    turnSerial += 1;
    telemetry.markTurn(turnSerial);
    const tokens = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, tokens);
  });

  pi.on("turn_end", (_event, context) => {
    const tokens = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, tokens);

    // turn_end is the first boundary after all tool results have landed. Only use
    // it when the host reports idle; a continuing tool loop is handled at
    // agent_settled instead so native compact() cannot abort active work.
    if (
      config.enabled &&
      !semanticRequested &&
      context.isIdle() &&
      shouldTriggerThresholdCompaction(tokens, config.compactThresholdTokens)
    ) {
      requestCompaction(context, "threshold");
    }
  });

  pi.on("agent_settled", (_event, context) => {
    const tokens = observeContext(context, config, telemetry, gate);
    notifySoftWarning(context, config, telemetry, warned, tokens);

    if (semanticRequested && config.enabled && config.semanticCompaction) {
      requestCompaction(
        context,
        "semantic",
        semanticReason
          ? `${SEMANTIC_COMPACTION_INSTRUCTIONS} Completed phase: ${semanticReason}`
          : SEMANTIC_COMPACTION_INSTRUCTIONS,
      );
      return;
    }
    if (config.enabled && shouldTriggerThresholdCompaction(tokens, config.compactThresholdTokens)) {
      requestCompaction(context, "threshold");
    }
  });

  pi.on("session_compact", (event, context) => {
    const usage = context.getContextUsage();
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
    gate.complete(postTokens, turnSerial);
    requestedCompaction = undefined;
    semanticRequested = false;
    semanticReason = undefined;
    warned.value = false;
    updateStatus(context, config, telemetry);
    debugLog(config, `compaction completed (${event.reason})`);
  });

  pi.on("session_compact_failed", (event, context) => {
    const failedRequest = requestedCompaction;
    if (gate.isInFlight) {
      gate.fail();
    }
    requestedCompaction = undefined;
    if (failedRequest && context.hasUI) {
      context.ui.notify(
        `local-context-manager compaction did not complete: ${event.errorMessage ?? "cancelled"}`,
        "warning",
      );
    }
    debugLog(config, `compaction failed (${event.reason})`, event.errorMessage);
    updateStatus(context, config, telemetry);
  });

  pi.on("tool_result", async (event, context) => {
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
    return buildCustomCompaction(event, context, config);
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

  pi.registerCommand("context-stats", {
    description: "Show local context telemetry",
    handler: async (_args, context) => {
      const tokens = observeContext(context, config, telemetry, gate);
      const snapshot = telemetry.snapshot(config.compactThresholdTokens);
      const details = [
        formatTelemetryDetails(snapshot),
        `Soft warning: ${config.softWarningTokens.toLocaleString()} tokens`,
        `Hard ceiling: ${config.hardCeilingTokens.toLocaleString()} tokens`,
        `Enabled: ${config.enabled ? "yes" : "no"}`,
        `Current reading: ${tokens === null ? "unknown" : `${Math.round(tokens).toLocaleString()} tokens`}`,
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
