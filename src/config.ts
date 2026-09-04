import { readFile } from "node:fs/promises";

export interface LocalContextManagerConfig {
  enabled: boolean;
  softWarningTokens: number;
  compactThresholdTokens: number;
  hardCeilingTokens: number;
  keepRecentTokens: number;
  toolOutputReduction: boolean;
  semanticCompaction: boolean;
  handoff: boolean;
  debug: boolean;
}

export const DEFAULT_CONFIG: Readonly<LocalContextManagerConfig> = Object.freeze({
  enabled: true,
  softWarningTokens: 24_000,
  compactThresholdTokens: 32_000,
  hardCeilingTokens: 48_000,
  keepRecentTokens: 10_000,
  toolOutputReduction: true,
  semanticCompaction: true,
  handoff: true,
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

const BOOLEAN_KEYS = ["enabled", "toolOutputReduction", "semanticCompaction", "handoff", "debug"] as const;
const NUMBER_KEYS = [
  "softWarningTokens",
  "compactThresholdTokens",
  "hardCeilingTokens",
  "keepRecentTokens",
] as const;

type RecordValue = Record<string, unknown>;
type NumberConfigKey = (typeof NUMBER_KEYS)[number];

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
        candidate[lowerKey] = base[lowerKey];
        changedNumbers.delete(lowerKey);
      } else if (upperChanged && !lowerChanged) {
        candidate[upperKey] = base[upperKey];
        changedNumbers.delete(upperKey);
      } else {
        if (!lowerChanged && !upperChanged) {
          changed = false;
          break;
        }
        candidate[lowerKey] = base[lowerKey];
        candidate[upperKey] = base[upperKey];
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
