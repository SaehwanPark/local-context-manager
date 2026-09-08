import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  findCutPoint,
  sessionEntryToContextMessages,
  type FileOperations,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ToolContentBlock } from "./tool-output.js";

export interface CompactionSlice {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
}

export function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function countCompactions(entries: SessionEntry[]): { count: number; lastAt: number | null } {
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

export function estimateContentTokens(content: unknown): number {
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

export function estimateToolContentTokens(content: ReadonlyArray<ToolContentBlock>): number {
  return estimateContentTokens(content);
}

export function estimateAgentMessageTokens(message: AgentMessage): number {
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

export function estimateActiveContextTokens(entries: SessionEntry[]): number {
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

export function estimateActiveToolOutputTokens(entries: SessionEntry[]): number {
  return entries.reduce((total, entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") {
      return total;
    }
    return total + estimateToolContentTokens(entry.message.content);
  }, 0);
}

export function cleanBoundaryReason(value: string | undefined): string | undefined {
  const reason = value?.replace(/\s+/g, " ").trim();
  return reason ? reason.slice(0, 240) : undefined;
}

export function filePathFromToolArguments(argumentsValue: unknown): string | undefined {
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

export function extendFileOperations(messages: AgentMessage[], fileOps: FileOperations): void {
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

export function getCompactionSlice(entries: SessionEntry[], keepRecentTokens: number): CompactionSlice | undefined {
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
