import { readFile } from "node:fs/promises";

export type ContextProfile = "aggressive" | "balanced" | "relaxed";

export interface ContextThresholds {
  softWarningTokens: number;
  compactThresholdTokens: number;
  hardCeilingTokens: number;
  keepRecentTokens: number;
}

export interface LocalContextManagerConfig {
  enabled: boolean;
  contextProfile: ContextProfile;
  softWarningTokens: number;
  compactThresholdTokens: number;
  hardCeilingTokens: number;
  keepRecentTokens: number;
  toolOutputReduction: boolean;
  semanticCompaction: boolean;
  handoff: boolean;
  checkpointReset: boolean;
  checkpointDirectory: string | null;
  debug: boolean;
}

export const CONTEXT_PROFILE_THRESHOLDS: Readonly<Record<ContextProfile, Readonly<ContextThresholds>>> = Object.freeze({
  aggressive: Object.freeze({
    keepRecentTokens: 8_000,
    softWarningTokens: 16_000,
    compactThresholdTokens: 24_000,
    hardCeilingTokens: 36_000,
  }),
  balanced: Object.freeze({
    keepRecentTokens: 10_000,
    softWarningTokens: 24_000,
    compactThresholdTokens: 32_000,
    hardCeilingTokens: 48_000,
  }),
  relaxed: Object.freeze({
    keepRecentTokens: 12_000,
    softWarningTokens: 36_000,
    compactThresholdTokens: 48_000,
    hardCeilingTokens: 72_000,
  }),
});

export const DEFAULT_CONFIG: Readonly<LocalContextManagerConfig> = Object.freeze({
  enabled: true,
  contextProfile: "balanced",
  softWarningTokens: CONTEXT_PROFILE_THRESHOLDS.balanced.softWarningTokens,
  compactThresholdTokens: CONTEXT_PROFILE_THRESHOLDS.balanced.compactThresholdTokens,
  hardCeilingTokens: CONTEXT_PROFILE_THRESHOLDS.balanced.hardCeilingTokens,
  keepRecentTokens: CONTEXT_PROFILE_THRESHOLDS.balanced.keepRecentTokens,
  toolOutputReduction: true,
  semanticCompaction: true,
  handoff: true,
  checkpointReset: true,
  checkpointDirectory: null,
  debug: false,
});

export interface LoadedConfig {
  config: LocalContextManagerConfig;
  errors: string[];
  files: string[];
}

export interface LoadConfigOptions {
  globalConfigPath: string;
  projectConfigPath?: string;
  allowProjectConfig?: boolean;
}

const CONTEXT_PROFILE_KEYS = ["aggressive", "balanced", "relaxed"] as const;
const BOOLEAN_KEYS = [
  "enabled",
  "toolOutputReduction",
  "semanticCompaction",
  "handoff",
  "checkpointReset",
  "debug",
] as const;
const NUMBER_KEYS = [
  "softWarningTokens",
  "compactThresholdTokens",
  "hardCeilingTokens",
  "keepRecentTokens",
] as const;

type RecordValue = Record<string, unknown>;
type NumberConfigKey = (typeof NUMBER_KEYS)[number];

function isContextProfile(value: unknown): value is ContextProfile {
  return typeof value === "string" && (CONTEXT_PROFILE_KEYS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Four ordered positive thresholds need a little room; real model windows are far larger.
const MIN_ADAPTIVE_CONTEXT_WINDOW = 8;
const CONTEXT_WINDOW_FRACTIONS = Object.freeze({
  keepRecentTokens: 0.125,
  softWarningTokens: 0.25,
  compactThresholdTokens: 0.5,
  hardCeilingTokens: 0.75,
});

/**
 * Keep the configured policy as-is for normal and large windows, while reserving
 * room for the next turn on constrained models. The fractions deliberately only
 * lower thresholds; a large advertised window must not silently expand a user's
 * preferred working context.
 */
export function getEffectiveThresholds(
  config: LocalContextManagerConfig,
  contextWindow?: number,
): ContextThresholds {
  const configured: ContextThresholds = {
    keepRecentTokens: config.keepRecentTokens,
    softWarningTokens: config.softWarningTokens,
    compactThresholdTokens: config.compactThresholdTokens,
    hardCeilingTokens: config.hardCeilingTokens,
  };
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow < MIN_ADAPTIVE_CONTEXT_WINDOW
  ) {
    return configured;
  }

  return {
    keepRecentTokens: Math.min(
      configured.keepRecentTokens,
      Math.floor(contextWindow * CONTEXT_WINDOW_FRACTIONS.keepRecentTokens),
    ),
    softWarningTokens: Math.min(
      configured.softWarningTokens,
      Math.floor(contextWindow * CONTEXT_WINDOW_FRACTIONS.softWarningTokens),
    ),
    compactThresholdTokens: Math.min(
      configured.compactThresholdTokens,
      Math.floor(contextWindow * CONTEXT_WINDOW_FRACTIONS.compactThresholdTokens),
    ),
    hardCeilingTokens: Math.min(
      configured.hardCeilingTokens,
      Math.floor(contextWindow * CONTEXT_WINDOW_FRACTIONS.hardCeilingTokens),
    ),
  };
}

function configObject(value: unknown): RecordValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value.localContextManager;
  return isRecord(nested) ? nested : value;
}

function describeSource(source: string): string {
  return source ? ` in ${source}` : "";
}

function applyLayer(
  base: LocalContextManagerConfig,
  raw: unknown,
  source: string,
  errors: string[],
): LocalContextManagerConfig {
  const values = configObject(raw);
  if (!values) {
    errors.push(`Ignoring malformed configuration${describeSource(source)}: expected a JSON object`);
    return { ...base };
  }

  const candidate = { ...base };
  const changedNumbers = new Set<NumberConfigKey>();

  if ("contextProfile" in values) {
    const value = values.contextProfile;
    if (!isContextProfile(value)) {
      errors.push(`Ignoring contextProfile${describeSource(source)}: expected aggressive, balanced, or relaxed`);
    } else {
      candidate.contextProfile = value;
      Object.assign(candidate, CONTEXT_PROFILE_THRESHOLDS[value]);
    }
  }

  const numericBase: ContextThresholds = {
    keepRecentTokens: candidate.keepRecentTokens,
    softWarningTokens: candidate.softWarningTokens,
    compactThresholdTokens: candidate.compactThresholdTokens,
    hardCeilingTokens: candidate.hardCeilingTokens,
  };

  for (const key of BOOLEAN_KEYS) {
    if (!(key in values)) {
      continue;
    }
    if (typeof values[key] !== "boolean") {
      errors.push(`Ignoring ${key}${describeSource(source)}: expected a boolean`);
      continue;
    }
    candidate[key] = values[key];
  }

  if ("checkpointDirectory" in values) {
    const value = values.checkpointDirectory;
    if (
      value !== null &&
      (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value))
    ) {
      errors.push(
        `Ignoring checkpointDirectory${describeSource(source)}: expected a non-empty string or null`,
      );
    } else {
      candidate.checkpointDirectory = value === null ? null : value.trim();
    }
  }

  for (const key of NUMBER_KEYS) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      errors.push(`Ignoring ${key}${describeSource(source)}: expected a positive integer`);
      continue;
    }
    candidate[key] = value;
    changedNumbers.add(key);
  }

  const ordering = [
    ["keepRecentTokens", "softWarningTokens", "keepRecentTokens must be below softWarningTokens"],
    ["softWarningTokens", "compactThresholdTokens", "softWarningTokens must be below compactThresholdTokens"],
    ["compactThresholdTokens", "hardCeilingTokens", "compactThresholdTokens must be below hardCeilingTokens"],
  ] as const;
  const reported = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [lowerKey, upperKey, message] of ordering) {
      if (candidate[lowerKey] < candidate[upperKey]) {
        continue;
      }
      if (!reported.has(message)) {
        errors.push(`Invalid token ordering${describeSource(source)}: ${message}`);
        reported.add(message);
      }

      const lowerChanged = changedNumbers.has(lowerKey);
      const upperChanged = changedNumbers.has(upperKey);
      if (lowerChanged && !upperChanged) {
        candidate[lowerKey] = numericBase[lowerKey];
        changedNumbers.delete(lowerKey);
      } else if (upperChanged && !lowerChanged) {
        candidate[upperKey] = numericBase[upperKey];
        changedNumbers.delete(upperKey);
      } else {
        if (!lowerChanged && !upperChanged) {
          changed = false;
          break;
        }
        candidate[lowerKey] = numericBase[lowerKey];
        candidate[upperKey] = numericBase[upperKey];
        changedNumbers.delete(lowerKey);
        changedNumbers.delete(upperKey);
      }
      changed = true;
    }
  }

  return candidate;
}

export function parseConfig(
  raw: unknown,
  base: LocalContextManagerConfig = DEFAULT_CONFIG,
  source = "",
): { config: LocalContextManagerConfig; errors: string[] } {
  const errors: string[] = [];
  const config = applyLayer(base, raw, source, errors);
  return { config, errors };
}

async function readConfigFile(path: string): Promise<{ value?: unknown; error?: string; found: boolean }> {
  try {
    const text = await readFile(path, "utf8");
    try {
      return { value: JSON.parse(text) as unknown, found: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Ignoring malformed JSON in ${path}: ${message}`, found: true };
    }
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "ENOENT") {
      return { found: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unable to read ${path}: ${message}`, found: true };
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  let config: LocalContextManagerConfig = { ...DEFAULT_CONFIG };
  const errors: string[] = [];
  const files: string[] = [];

  const global = await readConfigFile(options.globalConfigPath);
  if (global.found) {
    files.push(options.globalConfigPath);
  }
  if (global.error) {
    errors.push(global.error);
  } else if (global.found) {
    const parsed = parseConfig(global.value, config, options.globalConfigPath);
    config = parsed.config;
    errors.push(...parsed.errors);
  }

  if (options.allowProjectConfig !== false && options.projectConfigPath) {
    const project = await readConfigFile(options.projectConfigPath);
    if (project.found) {
      files.push(options.projectConfigPath);
    }
    if (project.error) {
      errors.push(project.error);
    } else if (project.found) {
      const parsed = parseConfig(project.value, config, options.projectConfigPath);
      config = parsed.config;
      errors.push(...parsed.errors);
    }
  }

  return { config, errors, files };
}
