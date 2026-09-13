import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export const NON_EXHAUSTIVE_NOTICE =
  "This is a non-complete excerpt. Re-open the saved full output before conclusions that depend on ordering, absence, exact counts, or exhaustive matches.";

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
const MAX_HEADER_COMMAND_CHARS = 300;
// `${header}\n${body}\n\n${notice}` leaves three separator characters outside every section.
const RETENTION_SEPARATORS = 3;
const TRUNCATION_MARKER = "\n[truncated to fit the retained-output budget]";

const HIGH_PRIORITY_RE =
  /\b(?:error|errors|failed|failure|exception|traceback|panic|fatal|undefined|cannot|could not|command exited|exit code)\b|(?:^|\s)(?:at\s+[^\s:]+:\d+(?::\d+)?|(?![\[\d\sT:-]+:\d+)(?:[a-zA-Z0-9_.~/-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_.~-]*\/[^\s:]+):\d+(?::\d+)?)/i;
const MEDIUM_PRIORITY_RE =
  /\b(?:warning|warnings|warn|passed|passing|failed|skipped|tests?|suites?|summary|assert(?:ion)?s?)\b/i;
export const LOG_LINE_TIMESTAMP_RE =
  /(?:^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}|\[\d{2}:\d{2}:\d{2}\]|\b(?:trace|span)id=)/i;

interface CommandSubject {
  program: string;
  subcommand: string;
}

const BUILD_PROGRAMS = new Set([
  "build",
  "cargo",
  "clippy",
  "dotnet",
  "gradle",
  "jest",
  "make",
  "maturin",
  "mocha",
  "mvn",
  "npm",
  "pnpm",
  "pytest",
  "swift",
  "vitest",
  "xcodebuild",
  "yarn",
  "bun",
]);
const BUILD_SUBCOMMANDS = new Set(["build", "check", "clippy", "compile", "lint", "test", "typecheck"]);
const WRAPPER_PROGRAMS = new Set([
  "bun",
  "cargo",
  "dotnet",
  "gradle",
  "mix",
  "mvn",
  "npm",
  "npx",
  "perl",
  "pnpm",
  "poetry",
  "python",
  "python3",
  "ruby",
  "swift",
  "uv",
  "go",
  "yarn",
]);
const SOURCE_PROGRAMS = new Set(["cat", "get-content", "head", "less", "more", "sed", "tail", "type"]);
const SEARCH_PROGRAMS = new Set(["ag", "fd", "fgrep", "find", "egrep", "grep", "rg", "ripgrep"]);
const LOG_STREAM_PROGRAMS = new Set(["journalctl"]);
const LOG_SUBCOMMAND_PROGRAMS = new Set(["docker", "heroku", "kubectl", "nerdctl", "pm2", "podman"]);

function normalizeProgram(word: string): string {
  const basename = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return basename.replace(/\.(?:exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
}

interface ShellSegment {
  words: string[];
  quoted: boolean[];
}

/**
 * Splits on shell metacharacters while honouring single, double, and backquote
 * quotes. Recording which words were quoted is the point: a quoted argument is
 * data, never the command that decides how its output is reduced.
 */
function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let quoted: boolean[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | undefined;
  let started = false;
  let isQuoted = false;

  const flushWord = () => {
    if (!started) {
      return;
    }
    words.push(current);
    quoted.push(isQuoted);
    current = "";
    started = false;
    isQuoted = false;
  };
  const flushSegment = () => {
    flushWord();
    if (words.length > 0) {
      segments.push({ words, quoted });
    }
    words = [];
    quoted = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote !== "'" && index + 1 < command.length) {
        current += command[index + 1];
        index++;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      started = true;
      isQuoted = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index++;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")") {
      flushSegment();
      continue;
    }
    current += char;
    started = true;
  }
  flushSegment();

  return segments;
}

function commandSubjects(command: string): CommandSubject[] {
  const subjects: CommandSubject[] = [];
  for (const segment of splitShellSegments(command)) {
    let index = 0;
    while (index < segment.words.length && /^[a-z_][a-z0-9_]*=/i.test(segment.words[index])) {
      index += 1;
    }
    const programWord = segment.words[index];
    if (!programWord) {
      continue;
    }
    let subcommand = "";
    for (let next = index + 1; next < segment.words.length; next += 1) {
      const word = segment.words[next];
      if (!word || segment.quoted[next] || word.startsWith("-")) {
        continue;
      }
      subcommand = word.toLowerCase();
      break;
    }
    subjects.push({ program: normalizeProgram(programWord), subcommand });
  }
  return subjects;
}

function hasSubject(
  subjects: CommandSubject[],
  matches: (subject: CommandSubject) => boolean,
): boolean {
  return subjects.some(matches);
}

function isBuildCommand(subjects: CommandSubject[]): boolean {
  return hasSubject(
    subjects,
    (subject) =>
      BUILD_PROGRAMS.has(subject.program) ||
      (WRAPPER_PROGRAMS.has(subject.program) && BUILD_SUBCOMMANDS.has(subject.subcommand)),
  );
}

function isSourceCommand(subjects: CommandSubject[]): boolean {
  return hasSubject(
    subjects,
    (subject) => SOURCE_PROGRAMS.has(subject.program) || (subject.program === "git" && subject.subcommand === "show"),
  );
}

function isSearchCommand(subjects: CommandSubject[]): boolean {
  return hasSubject(
    subjects,
    (subject) => SEARCH_PROGRAMS.has(subject.program) || (subject.program === "git" && subject.subcommand === "grep"),
  );
}

function isDiffCommand(subjects: CommandSubject[]): boolean {
  return hasSubject(subjects, (subject) => subject.program === "git" && subject.subcommand === "diff");
}

function isLogStreamCommand(subjects: CommandSubject[]): boolean {
  return hasSubject(
    subjects,
    (subject) =>
      LOG_STREAM_PROGRAMS.has(subject.program) ||
      (LOG_SUBCOMMAND_PROGRAMS.has(subject.program) && subject.subcommand === "logs"),
  );
}

export function isLogOrEventStream(command?: string, lines: string[] = []): boolean {
  if (command && isLogStreamCommand(commandSubjects(command))) {
    return true;
  }
  let timestampCount = 0;
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    if (LOG_LINE_TIMESTAMP_RE.test(lines[i])) {
      timestampCount++;
      if (timestampCount >= 3) return true;
    }
  }
  return false;
}

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

function selectExcerpt(
  lines: string[],
  maxLines = MAX_RETAINED_OUTPUT_LINES,
  isLogStream = false,
): string[] {
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

  const windowOffsets = isLogStream ? [-3, -2, -1, 0, 1, 2, 3] : [-1, 0, 1];
  for (const index of highPriority.flatMap((value) => windowOffsets.map((offset) => value + offset))) {
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

function clipTo(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let end = Math.max(0, maxChars);
  const trailing = text.charCodeAt(end - 1);
  if (trailing >= 0xd800 && trailing <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function clipCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_HEADER_COMMAND_CHARS) {
    return singleLine;
  }
  return `${clipTo(singleLine, MAX_HEADER_COMMAND_CHARS - 1)} […]`;
}

// `tool_result` exposes only the `isError` flag, so the numeric status is never
// observable here. Asserting a concrete code manufactures a fact the header then
// carries through compaction; report only the flag and keep any harvested number
// visibly separate as an unverified hint.
const SUCCESSFUL_EXIT_STATUS = "reported successful (the tool reported no error)";
const FAILED_EXIT_STATUS = "non-zero (the tool reports failure without a numeric exit code)";

function describeExitStatus(isError: boolean): string {
  return isError ? FAILED_EXIT_STATUS : SUCCESSFUL_EXIT_STATUS;
}

function guessStatusCodeFromOutput(text: string): string | undefined {
  const match = text.match(/(?:exit(?:ed)?|status|code)\s*(?:code\s*)?[:=]?\s*(-?\d+)/i);
  if (!match) {
    return undefined;
  }
  return clipTo(match[0].replace(/\s+/g, " ").trim(), 80);
}

/**
 * Every reduction ends up here, which is what makes the retained-output budget a
 * guarantee rather than an aspiration: the header and notice are kept whole, and
 * the body is clipped so the replacement is always smaller than the budget.
 */
function assembleRetainedText(header: string, body: string, notice: string): string {
  const budget = MAX_RETAINED_OUTPUT_CHARS - header.length - notice.length - RETENTION_SEPARATORS;
  if (body.length <= budget) {
    return `${header}\n${body}\n\n${notice}`;
  }
  const capped = Math.max(0, budget - TRUNCATION_MARKER.length);
  return `${header}\n${clipTo(body, capped)}${TRUNCATION_MARKER}\n\n${notice}`;
}

function compactedHeader(
  category: Exclude<ToolReduction["category"], null>,
  originalText: string,
  input: Record<string, unknown>,
  isError: boolean,
): string {
  const lines = originalText ? originalText.split("\n").length : 0;
  const command = getCommand(input);
  const hint = isError ? guessStatusCodeFromOutput(originalText) : undefined;
  const label = category === "failure" ? "failed command" : `${category} output`;
  const metadata = [
    `[local-context-manager] Reduced ${label}.`,
    command ? `Command: ${clipCommand(command)}` : undefined,
    `Exit status: ${describeExitStatus(isError)}`,
    hint
      ? `Code-like text in output: ${quote(hint)} (not verified as the process exit status)`
      : undefined,
    `Original size: ${lines} lines, ${originalText.length} characters.`,
  ].filter((line): line is string => line !== undefined);
  return metadata.join("\n");
}

function buildExcerptText(
  category: Exclude<ToolReduction["category"], null>,
  originalText: string,
  input: Record<string, unknown>,
  isError: boolean,
): string {
  const lines = originalText.split("\n");
  const command = getCommand(input);
  const isLogStream = isLogOrEventStream(command, lines);
  const header = compactedHeader(category, originalText, input, isError);
  let body: string;

  if (category === "failure") {
    const excerpt = fitExcerpt(selectExcerpt(lines, MAX_RETAINED_OUTPUT_LINES, isLogStream));
    body = excerpt ? `Key diagnostics and recent output:\n${excerpt}` : "No textual diagnostic was available.";
  } else if (category === "search") {
    const pattern = typeof input.pattern === "string" ? input.pattern : typeof input.query === "string" ? input.query : undefined;
    const excerpt = fitExcerpt(selectExcerpt(lines, MAX_RETAINED_OUTPUT_LINES, isLogStream));
    body = [
      pattern ? `Search query: ${quote(pattern)}` : undefined,
      `Sampled matching lines: ${lines.filter((line) => line.trim()).length}`,
      excerpt ? `Relevant matches:\n${excerpt}` : "No matching lines were returned.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  } else if (category === "diff") {
    body = formatDiffSummary(lines);
  } else {
    const important = lines.filter((line) => lineScore(line) >= 2);
    const excerpt = fitExcerpt(selectExcerpt(important.length > 0 ? important : lines, MAX_RETAINED_OUTPUT_LINES, isLogStream));
    body = excerpt ? `Relevant output:\n${excerpt}` : "No textual output was returned.";
  }

  return assembleRetainedText(header, body, NON_EXHAUSTIVE_NOTICE);
}

function diffPathFromHeader(line: string): string | undefined {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  return match?.[2] ?? match?.[1];
}

function normalizeDiffPath(line: string): string | undefined {
  const match = line.match(/^\+\+\+ b\/(.+)$/);
  return match?.[1];
}

// A repository-wide diff has one line per changed file and an unbounded number of
// hunks per file, so the per-section budgets below are the only thing standing
// between a large branch and a "reduction" larger than the output it replaced.
const DIFF_FILES_BUDGET = 3_500;
const DIFF_HUNK_BUDGET = 2_000;
const DIFF_EXCERPT_BUDGET = 3_400;
const MAX_HUNKS_PER_FILE = 12;

function countShownLines(text: string): number {
  return text.length > 0 ? text.split("\n").filter((line) => line.length > 0).length : 0;
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
  const hunkLines = [...files].flatMap(([path, stats]) =>
    stats.hunks.slice(0, MAX_HUNKS_PER_FILE).map((hunk) => `- ${path}: ${hunk}`),
  );
  const cappedFileLines = fitExcerpt(fileLines, DIFF_FILES_BUDGET);
  const omittedFiles = Math.max(0, files.size - countShownLines(cappedFileLines));
  const cappedHunkLines = fitExcerpt(hunkLines, DIFF_HUNK_BUDGET);
  const totalHunks = [...files].reduce((total, [, stats]) => total + stats.hunks.length, 0);
  const omittedHunks = Math.max(0, totalHunks - countShownLines(cappedHunkLines));
  const changeExcerpt = fitExcerpt(selectExcerpt(changedLines, 80), DIFF_EXCERPT_BUDGET);
  const sections = [
    `Files changed: ${files.size}${
      omittedFiles > 0 ? ` (per-file details truncated for ${omittedFiles} files)` : ""
    }`,
    cappedFileLines.length > 0 ? cappedFileLines : undefined,
    hunkLines.length > 0
      ? `Hunk headers${omittedHunks > 0 ? ` (${omittedHunks} not shown)` : ""}:\n${cappedHunkLines}`
      : undefined,
    changeExcerpt.length > 0 ? `Changed-line excerpt:\n${changeExcerpt}` : undefined,
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
  const subjects = commandSubjects(command);
  if (isDiffCommand(subjects) && text.length > MAX_RETAINED_OUTPUT_CHARS) {
    return "diff";
  }
  if (isError && text.length > MAX_RETAINED_OUTPUT_CHARS) {
    return "failure";
  }
  if (isSearchCommand(subjects) && text.length > MAX_RETAINED_OUTPUT_CHARS) {
    return "search";
  }
  if (text.length <= MAX_RETAINED_OUTPUT_CHARS) {
    return null;
  }
  if (isSourceCommand(subjects)) {
    return null;
  }
  if (isBuildCommand(subjects)) {
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

  const built = buildExcerptText(category, originalText, result.input, result.isError);
  // Every category is assembled by assembleRetainedText, which holds the budget;
  // this backstop keeps a future category from reintroducing a path that retains
  // more than the extension promises.
  const compactedText =
    built.length <= MAX_RETAINED_OUTPUT_CHARS ? built : clipTo(built, MAX_RETAINED_OUTPUT_CHARS);
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

export function extractFullOutputPath(details: unknown, _text: string): string | undefined {
  // Only trust structured tool metadata. A command's stdout can contain arbitrary
  // text that impersonates a recovery path, including a path to sensitive data.
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

export function appendFullOutputNotice(
  content: ReadonlyArray<ToolContentBlock>,
  path: string,
  retentionNote?: string,
): ToolContentBlock[] {
  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex < 0) {
    return [...content];
  }

  const pointer = retentionNote ? `${path} (${retentionNote})` : path;
  return content.map((block, index) => {
    if (index !== textIndex || block.type !== "text") {
      return block;
    }
    return {
      type: "text",
      text: `${block.text}\nFull output saved to: ${pointer}`,
    };
  });
}

/**
 * Reports a recovery copy that this process already deleted. A reduced tool
 * result can still name the path, and a failed read of it is indistinguishable
 * from a lost file unless the model is told the pointer expired on purpose.
 */
export function appendPrunedOutputNotice(
  content: ReadonlyArray<ToolContentBlock>,
  paths: ReadonlyArray<string>,
): ToolContentBlock[] {
  if (paths.length === 0) {
    return [...content];
  }
  const textIndex = content.findIndex((block) => block.type === "text");
  const note = `The local-context-manager recovery copy at ${paths.join(", ")} was pruned by this session; the full output is no longer available. Re-run the command if the complete output is required.`;
  if (textIndex < 0) {
    return [...content, { type: "text", text: note }];
  }
  return content.map((block, index) =>
    index === textIndex && block.type === "text"
      ? { type: "text", text: `${block.text}\n${note}` }
      : block,
  );
}

function smallStringValues(value: unknown): string[] {
  const values: string[] = [];
  if (typeof value === "string") {
    if (value.length <= 4_096) values.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.length <= 4_096) values.push(item);
    }
  }
  return values;
}

/** Cheap haystack of the small strings in a tool input, where a cited path lives. */
function inputHaystack(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(input ?? {})) {
    parts.push(...smallStringValues(value));
  }
  return parts.join("\n");
}

const DEFAULT_BASE_RECOVERY_DIR = join(tmpdir(), "pi-lcm-recovery");
const LEGACY_RECOVERY_DIR_PREFIX = "pi-lcm-recovery-";
const STALE_RECOVERY_DIR_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_PRUNED = 256;
let staleSweepStarted = false;

export interface RecoveryManifest {
  version: 1;
  sessionId: string;
  updatedAt: number;
  fileSeq: number;
  managedFiles: Array<{ path: string; size: number }>;
  prunedPaths: string[];
}

/**
 * A crash or a killed process leaves recovery directories holding full,
 * unredacted tool output in the shared temp tree, and nothing else reaps them.
 * Only directories untouched for days are removed, so a live session's copies
 * are never swept. Heartbeat and manifest updates keep active directories alive.
 */
export async function sweepStaleRecoveryDirectories(
  baseDir = DEFAULT_BASE_RECOVERY_DIR,
): Promise<void> {
  const now = Date.now();
  // 1. Sweep session directories under baseDir
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDir = join(baseDir, entry.name);
    let lastActive: number | undefined;

    // Check heartbeat first
    try {
      const hb = await readFile(join(sessionDir, "heartbeat"), "utf8");
      const ts = Number.parseInt(hb.trim(), 10);
      if (!Number.isNaN(ts)) {
        lastActive = ts;
      }
    } catch {
      // No heartbeat file
    }

    // If no heartbeat, check manifest.json
    if (lastActive === undefined) {
      try {
        const raw = await readFile(join(sessionDir, "manifest.json"), "utf8");
        const manifest = JSON.parse(raw) as Partial<RecoveryManifest>;
        if (typeof manifest.updatedAt === "number") {
          lastActive = manifest.updatedAt;
        }
      } catch {
        // No manifest
      }
    }

    // Fallback to directory mtime
    if (lastActive === undefined) {
      const info = await stat(sessionDir).catch(() => undefined);
      if (info) {
        lastActive = info.mtimeMs;
      }
    }

    if (lastActive !== undefined && now - lastActive > STALE_RECOVERY_DIR_MS) {
      await rm(sessionDir, { recursive: true, force: true, maxRetries: 1 }).catch(() => undefined);
    }
  }

  // 2. Also sweep any legacy "pi-lcm-recovery-*" directories in tmpdir()
  const tmp = tmpdir();
  if (baseDir !== tmp) {
    const tmpEntries = await readdir(tmp, { withFileTypes: true }).catch(() => []);
    for (const entry of tmpEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith(LEGACY_RECOVERY_DIR_PREFIX)) {
        continue;
      }
      const legacyPath = join(tmp, entry.name);
      const info = await stat(legacyPath).catch(() => undefined);
      if (info && now - info.mtimeMs > STALE_RECOVERY_DIR_MS) {
        await rm(legacyPath, { recursive: true, force: true, maxRetries: 1 }).catch(() => undefined);
      }
    }
  }
}

export interface RecoveryStorageOptions {
  sessionId?: string;
  baseDirectory?: string;
  maxFiles?: number;
  maxBytes?: number;
  onDiagnostic?: ((message: string, level: "info" | "warning") => void) | undefined;
}

export class SessionRecoveryStorage {
  readonly sessionId: string;
  readonly baseDirectory: string;
  private readonly isAnonymous: boolean;
  private directory: string | null = null;
  // Oldest reference first; reading a copy moves it to the back so eviction
  // follows actual use instead of insertion order.
  private readonly managedFiles: Array<{ path: string; size: number }> = [];
  private readonly prunedPaths = new Set<string>();
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private onDiagnostic: ((message: string, level: "info" | "warning") => void) | undefined;
  private prunedCount = 0;
  private fileSeq = 0;
  private manifestLoaded = false;

  constructor(options: RecoveryStorageOptions = {}) {
    this.isAnonymous = !options.sessionId?.trim();
    this.sessionId = options.sessionId?.trim() || `anon-${randomUUID().slice(0, 12)}`;
    this.baseDirectory = options.baseDirectory ?? DEFAULT_BASE_RECOVERY_DIR;
    this.maxFiles = options.maxFiles ?? 50;
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024; // 50MB
    this.onDiagnostic = options.onDiagnostic;

    const sessionHash = createHash("sha256").update(this.sessionId).digest("hex").slice(0, 16);
    const targetDir = join(this.baseDirectory, sessionHash);
    if (existsSync(targetDir)) {
      this.directory = targetDir;
      this.loadManifestSync(targetDir);
    }
  }

  setDiagnostics(onDiagnostic?: (message: string, level: "info" | "warning") => void): void {
    this.onDiagnostic = onDiagnostic;
  }

  /** Text the retained tool result shows alongside the path, so an expired
   *  pointer reads as an expected outcome rather than a contradiction. */
  get retentionNote(): string {
    const megabytes = Math.max(1, Math.round(this.maxBytes / (1024 * 1024)));
    return `kept for this session only; pruned after ${this.maxFiles} newer outputs or ${megabytes} MB accumulate`;
  }

  get prunedFileCount(): number {
    return Math.max(this.prunedCount, this.prunedPaths.size);
  }

  private loadManifestSync(dir: string): void {
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      return;
    }
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as Partial<RecoveryManifest>;
      if (manifest && manifest.version === 1) {
        if (typeof manifest.fileSeq === "number" && manifest.fileSeq > this.fileSeq) {
          this.fileSeq = manifest.fileSeq;
        }
        if (Array.isArray(manifest.prunedPaths)) {
          for (const p of manifest.prunedPaths) {
            if (typeof p === "string") {
              this.rememberPruned(p);
            }
          }
        }
        if (Array.isArray(manifest.managedFiles)) {
          for (const entry of manifest.managedFiles) {
            if (entry && typeof entry.path === "string" && typeof entry.size === "number") {
              if (existsSync(entry.path)) {
                if (!this.managedFiles.some((f) => f.path === entry.path)) {
                  this.managedFiles.push({ path: entry.path, size: entry.size });
                }
              } else {
                this.rememberPruned(entry.path);
              }
            }
          }
        }
      }
      this.manifestLoaded = true;
    } catch (error) {
      this.onDiagnostic?.(`could not read recovery manifest: ${describeError(error)}`, "warning");
    }
  }

  private async loadManifest(): Promise<void> {
    if (!this.directory) {
      return;
    }
    this.manifestLoaded = true;
    const manifestPath = join(this.directory, "manifest.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as Partial<RecoveryManifest>;
      if (manifest && manifest.version === 1) {
        if (typeof manifest.fileSeq === "number" && manifest.fileSeq > this.fileSeq) {
          this.fileSeq = manifest.fileSeq;
        }
        if (Array.isArray(manifest.prunedPaths)) {
          for (const p of manifest.prunedPaths) {
            if (typeof p === "string") {
              this.rememberPruned(p);
            }
          }
        }
        if (Array.isArray(manifest.managedFiles)) {
          for (const entry of manifest.managedFiles) {
            if (entry && typeof entry.path === "string" && typeof entry.size === "number") {
              const exists = await stat(entry.path).then(() => true).catch(() => false);
              if (exists) {
                if (!this.managedFiles.some((f) => f.path === entry.path)) {
                  this.managedFiles.push({ path: entry.path, size: entry.size });
                }
              } else {
                this.rememberPruned(entry.path);
              }
            }
          }
        }
      }
    } catch (error) {
      const isEnoent = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      if (!isEnoent) {
        this.onDiagnostic?.(`could not read recovery manifest: ${describeError(error)}`, "warning");
      }
    }
  }

  private async persistManifest(): Promise<void> {
    if (!this.directory) {
      return;
    }
    const manifestPath = join(this.directory, "manifest.json");
    const manifest: RecoveryManifest = {
      version: 1,
      sessionId: this.sessionId,
      updatedAt: Date.now(),
      fileSeq: this.fileSeq,
      managedFiles: this.managedFiles,
      prunedPaths: Array.from(this.prunedPaths),
    };
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.onDiagnostic?.(`could not save recovery manifest: ${describeError(error)}`, "warning");
    }
  }

  private async touchLease(): Promise<void> {
    if (!this.directory) {
      return;
    }
    const heartbeatPath = join(this.directory, "heartbeat");
    try {
      await writeFile(heartbeatPath, String(Date.now()), { encoding: "utf8", mode: 0o600 });
    } catch {
      // Non-fatal
    }
  }

  async getDirectory(): Promise<string> {
    if (this.directory) {
      const exists = await stat(this.directory).then(() => true).catch(() => false);
      if (!exists) {
        const lost = this.managedFiles.map((entry) => entry.path);
        this.directory = null;
        this.manifestLoaded = false;
        this.managedFiles.length = 0;
        if (this.isAnonymous) {
          (this as { sessionId: string }).sessionId = `anon-${randomUUID().slice(0, 12)}`;
        }
        for (const path of lost) {
          this.rememberPruned(path);
        }
        this.onDiagnostic?.(
          `recovery directory was removed externally; dropping ${lost.length} tracked files that are now unreachable`,
          "info",
        );
      }
    }

    if (!this.directory) {
      if (!staleSweepStarted) {
        staleSweepStarted = true;
        void sweepStaleRecoveryDirectories(this.baseDirectory).catch(() => undefined);
      }

      const sessionHash = createHash("sha256").update(this.sessionId).digest("hex").slice(0, 16);
      const targetDir = join(this.baseDirectory, sessionHash);

      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      // POSIX mode bits are a no-op on NTFS, where the directory inherits the
      // temp tree's ACL. The claim that this holds is documented as POSIX-only.
      await chmod(targetDir, 0o700).catch((error: unknown) => {
        this.onDiagnostic?.(`could not restrict the recovery directory: ${describeError(error)}`, "warning");
      });

      this.directory = targetDir;
      if (!this.manifestLoaded) {
        await this.loadManifest();
      }
      await this.touchLease();
    }

    return this.directory;
  }

  async save(text: string, toolHint = "tool"): Promise<string | undefined> {
    try {
      const dir = await this.getDirectory();
      this.fileSeq++;
      const safeTool = toolHint.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
      const filename = `output-${this.fileSeq}-${safeTool}.txt`;
      const path = join(dir, filename);
      const buffer = Buffer.from(text, "utf8");
      if (buffer.length > this.maxBytes) {
        this.onDiagnostic?.(
          `tool output (${buffer.length} bytes) exceeds recovery storage budget (${this.maxBytes} bytes); cannot save recovery copy`,
          "warning",
        );
        return undefined;
      }
      await writeFile(path, buffer, { encoding: "utf8", mode: 0o600 });
      this.managedFiles.push({ path, size: buffer.length });
      await this.prune();
      await this.persistManifest();
      await this.touchLease();
      return path;
    } catch (error) {
      this.onDiagnostic?.(`could not save a recovery copy: ${describeError(error)}`, "warning");
      return undefined;
    }
  }

  /**
   * Marks every managed copy named by a tool input as recently used.
   */
  noteReferences(input: Record<string, unknown>): void {
    if (this.managedFiles.length === 0) {
      return;
    }
    const haystack = inputHaystack(input);
    if (!haystack) {
      return;
    }
    let matched = false;
    for (let index = this.managedFiles.length - 1; index >= 0; index--) {
      const entry = this.managedFiles[index];
      if (!haystack.includes(entry.path)) {
        continue;
      }
      this.managedFiles.splice(index, 1);
      this.managedFiles.push(entry);
      matched = true;
    }
    if (matched) {
      void this.persistManifest().catch(() => undefined);
      void this.touchLease().catch(() => undefined);
    }
  }

  findPrunedReferences(input: Record<string, unknown>): string[] {
    if (this.prunedPaths.size === 0) {
      return [];
    }
    const haystack = inputHaystack(input);
    if (!haystack) {
      return [];
    }
    const found: string[] = [];
    for (const path of this.prunedPaths) {
      if (haystack.includes(path)) {
        found.push(path);
      }
    }
    return found;
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.managedFiles) {
      total += entry.size;
    }
    return total;
  }

  private overBudget(): boolean {
    return this.managedFiles.length > this.maxFiles || this.totalBytes() > this.maxBytes;
  }

  private rememberPruned(path: string): void {
    this.prunedPaths.add(path);
    if (this.prunedPaths.size > MAX_REMEMBERED_PRUNED) {
      const oldest = this.prunedPaths.values().next();
      if (!oldest.done) {
        this.prunedPaths.delete(oldest.value);
      }
    }
  }

  private async prune(): Promise<void> {
    if (!this.overBudget()) {
      return;
    }

    // A partial external deletion must not leave dead bytes in the accounting,
    // or later evictions remove live copies earlier than the configured ceiling.
    for (let index = 0; index < this.managedFiles.length && this.overBudget(); index++) {
      const entry = this.managedFiles[index];
      const info = await stat(entry.path).catch(() => undefined);
      if (info) {
        continue;
      }
      this.managedFiles.splice(index, 1);
      index -= 1;
      this.rememberPruned(entry.path);
      this.onDiagnostic?.(`recovery copy ${entry.path} is gone; removed from the accounting`, "info");
    }

    while (this.overBudget() && this.managedFiles.length > 0) {
      const oldest = this.managedFiles.shift();
      if (!oldest) {
        break;
      }
      await rm(oldest.path, { force: true }).catch(() => undefined);
      this.prunedCount += 1;
      this.rememberPruned(oldest.path);
      this.onDiagnostic?.(
        `pruned recovery copy ${oldest.path} (${this.prunedCount} pruned this session)`,
        "info",
      );
    }
  }

  async cleanup(): Promise<void> {
    if (this.directory) {
      const dir = this.directory;
      this.directory = null;
      this.manifestLoaded = false;
      const paths = this.managedFiles.map((entry) => entry.path);
      this.managedFiles.length = 0;
      for (const path of paths) {
        this.rememberPruned(path);
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  get activeFilesCount(): number {
    return this.managedFiles.length;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let globalDiagnosticHandler: ((message: string, level: "info" | "warning") => void) | undefined;
const sessionStorages = new Map<string, SessionRecoveryStorage>();
let defaultStorage: SessionRecoveryStorage | undefined;

export function getSessionRecoveryStorage(sessionId?: string): SessionRecoveryStorage {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    if (!defaultStorage) {
      defaultStorage = new SessionRecoveryStorage({
        sessionId: "default",
        onDiagnostic: globalDiagnosticHandler,
      });
    }
    return defaultStorage;
  }
  let storage = sessionStorages.get(trimmed);
  if (!storage) {
    storage = new SessionRecoveryStorage({
      sessionId: trimmed,
      onDiagnostic: globalDiagnosticHandler,
    });
    sessionStorages.set(trimmed, storage);
  }
  return storage;
}

export function resetSessionRecoveryStorage(sessionId?: string): SessionRecoveryStorage {
  const trimmed = sessionId?.trim();
  if (trimmed) {
    sessionStorages.delete(trimmed);
    const fresh = new SessionRecoveryStorage({
      sessionId: trimmed,
      onDiagnostic: globalDiagnosticHandler,
    });
    sessionStorages.set(trimmed, fresh);
    return fresh;
  }
  sessionStorages.clear();
  defaultStorage = new SessionRecoveryStorage({
    sessionId: "default",
    onDiagnostic: globalDiagnosticHandler,
  });
  return defaultStorage;
}

export function setRecoveryStorageDiagnostics(
  onDiagnostic?: (message: string, level: "info" | "warning") => void,
  sessionId?: string,
): void {
  globalDiagnosticHandler = onDiagnostic;
  if (sessionId?.trim()) {
    sessionStorages.get(sessionId.trim())?.setDiagnostics(onDiagnostic);
  } else {
    defaultStorage?.setDiagnostics(onDiagnostic);
    for (const storage of sessionStorages.values()) {
      storage.setDiagnostics(onDiagnostic);
    }
  }
}

export async function cleanupRecoveryStorage(sessionId?: string): Promise<void> {
  const trimmed = sessionId?.trim();
  if (trimmed) {
    const storage = sessionStorages.get(trimmed);
    if (storage) {
      sessionStorages.delete(trimmed);
      await storage.cleanup();
    }
    return;
  }
  if (defaultStorage) {
    await defaultStorage.cleanup();
    defaultStorage = undefined;
  }
  for (const storage of sessionStorages.values()) {
    await storage.cleanup();
  }
  sessionStorages.clear();
}

export async function saveRecoveryCopy(
  text: string,
  toolHint?: string,
  sessionId?: string,
): Promise<string | undefined> {
  return getSessionRecoveryStorage(sessionId).save(text, toolHint);
}

