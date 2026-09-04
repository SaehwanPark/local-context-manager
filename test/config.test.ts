import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.js";

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
