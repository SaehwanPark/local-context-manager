export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type ToolContentBlock = TextContentBlock | ImageContentBlock;

export interface ToolOutputInput {
  toolName: string;
  input: Record<string, unknown>;
  content: ReadonlyArray<ToolContentBlock>;
  details?: unknown;
  isError: boolean;
}

export interface ToolReduction {
  changed: boolean;
  content: ToolContentBlock[];
  originalText: string;
  compactedText: string;
  originalTokens: number;
  retainedTokens: number;
  removedTokens: number;
  category: "build" | "failure" | "search" | "diff" | "generic" | null;
}

export const MAX_RETAINED_OUTPUT_CHARS = 10_000;
export const MAX_RETAINED_OUTPUT_LINES = 120;

const MAX_LINE_CHARS = 2_000;
const SUCCESSFUL_COMMAND_RE =
  /\b(?:build|test|check|lint|typecheck|compile|make|cargo|clippy|pytest|jest|vitest|mocha|npm|pnpm|yarn|bun|gradle|mvn|dotnet|xcodebuild|swift|go\s+(?:test|build)|mix\s+(?:test|compile)|maturin)\b/i;
const SOURCE_COMMAND_RE =
  /(?:^|[;&|])(\s*)(?:cat|sed|head|tail|less|more|type|Get-Content|git\s+show)\b|\b(?:cat|sed|head|tail|less|more|type|Get-Content|git\s+show)\s+/i;
const SEARCH_COMMAND_RE = /(?:^|[;&|\s])(?:rg|ripgrep|grep|git\s+grep|find)\b/i;
const GIT_DIFF_COMMAND_RE = /(?:^|[;&|\s])git\s+(?:-[^\s]+\s+)*diff\b/i;
const HIGH_PRIORITY_RE =
  /\b(?:error|errors|failed|failure|exception|traceback|panic|fatal|undefined|cannot|could not|command exited|exit code)\b|(?:^|\s)(?:at\s+)?[^\s:]+:\d+(?::\d+)?/i;
const MEDIUM_PRIORITY_RE =
  /\b(?:warning|warnings|warn|passed|passing|failed|skipped|tests?|suites?|summary|assert(?:ion)?s?)\b/i;

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getText(content: ReadonlyArray<ToolContentBlock>): string {
  return content
    .filter((block): block is TextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getCommand(input: Record<string, unknown>): string | undefined {
  return typeof input.command === "string" && input.command.trim() ? input.command.trim() : undefined;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) {
    return line;
  }
  const head = Math.max(1_000, MAX_LINE_CHARS - 450);
  return `${line.slice(0, head)} ... ${line.slice(-400)} [line clipped]`;
}

function lineScore(line: string): number {
  if (HIGH_PRIORITY_RE.test(line)) {
    return 3;
  }
  if (MEDIUM_PRIORITY_RE.test(line)) {
    return 2;
  }
  return 1;
}

function selectExcerpt(lines: string[], maxLines = MAX_RETAINED_OUTPUT_LINES): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const mandatory = new Set<number>();
  const selected = new Set<number>();
  const add = (index: number, required = false) => {
    if (index < 0 || index >= lines.length) {
      return;
    }
    selected.add(index);
    if (required) {
      mandatory.add(index);
    }
  };

  for (let index = 0; index < Math.min(4, lines.length); index++) {
    add(index, true);
  }
  for (let index = Math.max(0, lines.length - 16); index < lines.length; index++) {
    add(index, true);
  }

  const highPriority = lines
    .map((line, index) => ({ index, score: lineScore(line) }))
    .filter((item) => item.score === 3)
    .map((item) => item.index);
  const mediumPriority = lines
    .map((line, index) => ({ index, score: lineScore(line) }))
    .filter((item) => item.score === 2)
    .map((item) => item.index);

  // Keep the head and tail no matter how many diagnostics a noisy tool emits;
  // fill the remaining budget by diagnostic priority, then by source order.
  selected.clear();
  for (const index of mandatory) {
    selected.add(index);
  }
  for (const index of highPriority.flatMap((value) => [value - 1, value, value + 1])) {
    if (selected.size >= maxLines) {
      break;
    }
    add(index);
  }
  for (const index of mediumPriority) {
    if (selected.size >= maxLines) {
      break;
    }
    add(index);
  }
  for (let index = 0; index < lines.length && selected.size < maxLines; index++) {
    add(index);
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index]);
}

function fitExcerpt(lines: string[], maxChars = MAX_RETAINED_OUTPUT_CHARS): string {
  const result: string[] = [];
  let length = 0;
  for (const line of lines) {
    const clipped = clipLine(line);
    const separatorLength = result.length === 0 ? 0 : 1;
    if (length + separatorLength + clipped.length > maxChars) {
      continue;
    }
    result.push(clipped);
    length += separatorLength + clipped.length;
  }
  return result.join("\n");
}

function compactedHeader(
  category: Exclude<ToolReduction["category"], null>,
  originalText: string,
  input: Record<string, unknown>,
  isError: boolean,
): string {
  const lines = originalText ? originalText.split("\n").length : 0;
  const command = getCommand(input);
  const status = isError ? parseExitStatus(originalText) : "0";
  const label = category === "failure" ? "failed command" : `${category} output`;
  const metadata = [
    `[local-context-manager] Reduced ${label}.`,
    command ? `Command: ${command}` : undefined,
    `Exit status: ${status}`,
    `Original size: ${lines} lines, ${originalText.length} characters.`,
  ].filter((line): line is string => line !== undefined);
  return metadata.join("\n");
}

function parseExitStatus(text: string): string {
  const match = text.match(/(?:exit(?:ed)?|status|code)\s*(?:code\s*)?[:=]?\s*(-?\d+)/i);
  return match?.[1] ?? "non-zero";
}

function buildExcerptText(
  category: Exclude<ToolReduction["category"], null>,
  originalText: string,
  input: Record<string, unknown>,
  isError: boolean,
): string {
  const lines = originalText.split("\n");
  const header = compactedHeader(category, originalText, input, isError);
  let body: string;

  if (category === "failure") {
    const excerpt = fitExcerpt(selectExcerpt(lines));
    body = excerpt ? `Key diagnostics and recent output:\n${excerpt}` : "No textual diagnostic was available.";
  } else if (category === "search") {
    const pattern = typeof input.pattern === "string" ? input.pattern : typeof input.query === "string" ? input.query : undefined;
    const excerpt = fitExcerpt(selectExcerpt(lines));
    body = [
      pattern ? `Search query: ${quote(pattern)}` : undefined,
      `Matching lines shown: ${lines.filter((line) => line.trim()).length}`,
      excerpt ? `Relevant matches:\n${excerpt}` : "No matching lines were returned.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  } else if (category === "diff") {
    body = formatDiffSummary(lines);
  } else {
    const important = lines.filter((line) => lineScore(line) >= 2);
    const excerpt = fitExcerpt(selectExcerpt(important.length > 0 ? important : lines));
    body = excerpt ? `Relevant output:\n${excerpt}` : "No textual output was returned.";
  }

  return `${header}\n${body}`;
}

function diffPathFromHeader(line: string): string | undefined {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match?.[2] ?? match?.[1];
}

function normalizeDiffPath(line: string): string | undefined {
  const match = line.match(/^\+\+\+ b\/(.+)$/);
  return match?.[1];
}

function formatDiffSummary(lines: string[]): string {
  const files = new Map<string, { added: number; deleted: number; hunks: string[] }>();
  let currentFile: string | undefined;
  const changedLines: string[] = [];

  for (const line of lines) {
    const headerPath = diffPathFromHeader(line);
    if (headerPath) {
      currentFile = headerPath;
      files.set(currentFile, files.get(currentFile) ?? { added: 0, deleted: 0, hunks: [] });
      continue;
    }

    const plusPath = normalizeDiffPath(line);
    if (plusPath) {
      currentFile = plusPath;
      files.set(currentFile, files.get(currentFile) ?? { added: 0, deleted: 0, hunks: [] });
      continue;
    }

    if (!currentFile) {
      continue;
    }

    const file = files.get(currentFile);
    if (!file) {
      continue;
    }
    if (line.startsWith("@@")) {
      file.hunks.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      file.added += 1;
      changedLines.push(`${currentFile}: ${line}`);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      file.deleted += 1;
      changedLines.push(`${currentFile}: ${line}`);
    }
  }

  const fileLines = [...files].map(([path, stats]) => `- ${path} (+${stats.added}/-${stats.deleted})`);
  const hunkLines = [...files].flatMap(([path, stats]) => stats.hunks.slice(0, 12).map((hunk) => `- ${path}: ${hunk}`));
  const changeExcerpt = fitExcerpt(selectExcerpt(changedLines, 80), 7_000);
  const sections = [
    `Files changed: ${files.size}`,
    fileLines.length > 0 ? fileLines.join("\n") : undefined,
    hunkLines.length > 0 ? `Hunks:\n${hunkLines.join("\n")}` : undefined,
    changeExcerpt ? `Changed-line excerpt:\n${changeExcerpt}` : undefined,
  ].filter((section): section is string => section !== undefined);
  return sections.join("\n");
}

function replaceTextBlocks(content: ReadonlyArray<ToolContentBlock>, text: string): ToolContentBlock[] {
  const firstTextIndex = content.findIndex((block) => block.type === "text");
  if (firstTextIndex < 0) {
    return [...content];
  }

  const result: ToolContentBlock[] = [];
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    if (block.type !== "text") {
      result.push(block);
    } else if (index === firstTextIndex) {
      result.push({ type: "text", text });
    }
  }
  return result;
}

function getCategory(toolName: string, input: Record<string, unknown>, isError: boolean, text: string): ToolReduction["category"] {
  const normalizedToolName = toolName.toLowerCase();
  if (normalizedToolName === "read") {
    return null;
  }
  if (normalizedToolName === "grep" || normalizedToolName === "find") {
    return text.length > MAX_RETAINED_OUTPUT_CHARS ? "search" : null;
  }

  const command = getCommand(input);
  if (!command) {
    return null;
  }
  if (GIT_DIFF_COMMAND_RE.test(command) && text.length > MAX_RETAINED_OUTPUT_CHARS) {
    return "diff";
  }
  if (isError && text.length > MAX_RETAINED_OUTPUT_CHARS) {
    return "failure";
  }
  if (SEARCH_COMMAND_RE.test(command) && text.length > MAX_RETAINED_OUTPUT_CHARS) {
    return "search";
  }
  if (text.length <= MAX_RETAINED_OUTPUT_CHARS) {
    return null;
  }
  if (SOURCE_COMMAND_RE.test(command)) {
    return null;
  }
  if (SUCCESSFUL_COMMAND_RE.test(command)) {
    return "build";
  }
  if (text.length > MAX_RETAINED_OUTPUT_CHARS * 2) {
    return "generic";
  }
  return null;
}

export function reduceToolOutput(result: ToolOutputInput): ToolReduction {
  const originalText = getText(result.content);
  const category = getCategory(result.toolName, result.input, result.isError, originalText);
  if (!category || !originalText) {
    return {
      changed: false,
      content: [...result.content],
      originalText,
      compactedText: originalText,
      originalTokens: estimateTextTokens(originalText),
      retainedTokens: estimateTextTokens(originalText),
      removedTokens: 0,
      category: null,
    };
  }

  const compactedText = buildExcerptText(category, originalText, result.input, result.isError);
  if (compactedText.length >= originalText.length) {
    return {
      changed: false,
      content: [...result.content],
      originalText,
      compactedText: originalText,
      originalTokens: estimateTextTokens(originalText),
      retainedTokens: estimateTextTokens(originalText),
      removedTokens: 0,
      category: null,
    };
  }

  const originalTokens = estimateTextTokens(originalText);
  const retainedTokens = estimateTextTokens(compactedText);
  return {
    changed: true,
    content: replaceTextBlocks(result.content, compactedText),
    originalText,
    compactedText,
    originalTokens,
    retainedTokens,
    removedTokens: Math.max(0, originalTokens - retainedTokens),
    category,
  };
}

export function extractFullOutputPath(details: unknown, text: string): string | undefined {
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
    if (typeof path === "string" && path.trim()) {
      return path;
    }
  }

  const match = text.match(/Full output:\s*(?:\[)?([^\]\n]+?)(?:\]|$)/i);
  return match?.[1]?.trim() || undefined;
}

export function appendFullOutputNotice(content: ReadonlyArray<ToolContentBlock>, path: string): ToolContentBlock[] {
  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex < 0) {
    return [...content];
  }

  return content.map((block, index) => {
    if (index !== textIndex || block.type !== "text") {
      return block;
    }
    return {
      type: "text",
      text: `${block.text}\nFull output saved to: ${path}`,
    };
  });
}
