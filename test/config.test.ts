import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_PROFILE_THRESHOLDS,
  DEFAULT_CONFIG,
  getEffectiveThresholds,
  loadConfig,
  parseConfig,
} from "../src/config.js";

describe("configuration", () => {
  it("uses safe defaults and rejects invalid token ordering", () => {
    const parsed = parseConfig({
      softWarningTokens: 40_000,
      compactThresholdTokens: 30_000,
      hardCeilingTokens: 20_000,
      keepRecentTokens: 30_000,
      debug: "yes",
    });

    expect(parsed.config).toEqual(DEFAULT_CONFIG);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("applies a profile bundle while allowing valid advanced overrides", () => {
    const aggressive = parseConfig({ contextProfile: "aggressive" });
    expect(aggressive.config.contextProfile).toBe("aggressive");
    expect(aggressive.config).toMatchObject(CONTEXT_PROFILE_THRESHOLDS.aggressive);

    const custom = parseConfig({
      contextProfile: "aggressive",
      compactThresholdTokens: 20_000,
    });
    expect(custom.config.contextProfile).toBe("aggressive");
    expect(custom.config.keepRecentTokens).toBe(8_000);
    expect(custom.config.compactThresholdTokens).toBe(20_000);
    expect(custom.errors).toEqual([]);

    const invalid = parseConfig({ contextProfile: "turbo" });
    expect(invalid.config).toEqual(DEFAULT_CONFIG);
    expect(invalid.errors.join(" ")).toContain("contextProfile");
  });

  it("scales thresholds down for small context windows but never up", () => {
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 16_000)).toEqual({
      keepRecentTokens: 2_000,
      softWarningTokens: 4_000,
      compactThresholdTokens: 8_000,
      hardCeilingTokens: 12_000,
    });
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 64_000)).toEqual({
      keepRecentTokens: 8_000,
      softWarningTokens: 16_000,
      compactThresholdTokens: 32_000,
      hardCeilingTokens: 48_000,
    });
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 128_000)).toEqual({
      keepRecentTokens: DEFAULT_CONFIG.keepRecentTokens,
      softWarningTokens: DEFAULT_CONFIG.softWarningTokens,
      compactThresholdTokens: DEFAULT_CONFIG.compactThresholdTokens,
      hardCeilingTokens: DEFAULT_CONFIG.hardCeilingTokens,
    });
    expect(getEffectiveThresholds(DEFAULT_CONFIG, 1_000_000)).toEqual(
      getEffectiveThresholds(DEFAULT_CONFIG),
    );
  });

  it("parses checkpoint reset settings and rejects an invalid directory", () => {
    const parsed = parseConfig({ checkpointReset: false, checkpointDirectory: "~/private-checkpoints" });
    expect(parsed.config.checkpointReset).toBe(false);
    expect(parsed.config.checkpointDirectory).toBe("~/private-checkpoints");

    const invalid = parseConfig({ checkpointDirectory: 42 });
    expect(invalid.config.checkpointDirectory).toBe(null);
    expect(invalid.errors.join(" ")).toContain("checkpointDirectory");
  });

  it("layers global and trusted project JSON, with project values winning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-test-"));
    try {
      const globalPath = join(directory, "global.json");
      const projectPath = join(directory, "project.json");
      await writeFile(globalPath, JSON.stringify({ softWarningTokens: 20_000, debug: true }));
      await writeFile(projectPath, JSON.stringify({ compactThresholdTokens: 28_000, debug: false }));

      const loaded = await loadConfig({
        globalConfigPath: globalPath,
        projectConfigPath: projectPath,
        allowProjectConfig: true,
      });

      expect(loaded.config.softWarningTokens).toBe(20_000);
      expect(loaded.config.compactThresholdTokens).toBe(28_000);
      expect(loaded.config.debug).toBe(false);
      expect(loaded.files).toEqual([globalPath, projectPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores project configuration when the project is untrusted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-test-"));
    try {
      const globalPath = join(directory, "global.json");
      const projectPath = join(directory, "project.json");
      await writeFile(globalPath, JSON.stringify({ debug: true }));
      await writeFile(projectPath, JSON.stringify({ debug: false }));

      const loaded = await loadConfig({
        globalConfigPath: globalPath,
        projectConfigPath: projectPath,
        allowProjectConfig: false,
      });

      expect(loaded.config.debug).toBe(true);
      expect(loaded.files).toEqual([globalPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps layered token ordering valid when a later layer lowers a threshold", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-test-"));
    try {
      const globalPath = join(directory, "global.json");
      const projectPath = join(directory, "project.json");
      await writeFile(globalPath, JSON.stringify({ keepRecentTokens: 10_000 }));
      await writeFile(projectPath, JSON.stringify({ softWarningTokens: 8_000 }));

      const loaded = await loadConfig({
        globalConfigPath: globalPath,
        projectConfigPath: projectPath,
        allowProjectConfig: true,
      });

      expect(loaded.config.keepRecentTokens).toBeLessThan(loaded.config.softWarningTokens);
      expect(loaded.config.softWarningTokens).toBe(DEFAULT_CONFIG.softWarningTokens);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports malformed JSON without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-test-"));
    try {
      const path = join(directory, "broken.json");
      await writeFile(path, "{ broken");
      const loaded = await loadConfig({ globalConfigPath: path });
      expect(loaded.config).toEqual(DEFAULT_CONFIG);
      expect(loaded.errors.join(" ")).toContain("malformed JSON");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
