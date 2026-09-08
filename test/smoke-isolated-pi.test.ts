import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LCM_ENTRYPOINT = join(__dirname, "../src/index.ts");
const SAFE_AGENT_ENTRYPOINT = "/Users/saehwan/repos/pi-safe-agent-team/index.ts";
const MONO_GUARD_ENTRYPOINT = "/Users/saehwan/.pi/agent/npm/node_modules/pi-mono-context-guard/index.ts";
const PI_GOAL_ENTRYPOINT = "/Users/saehwan/.pi/agent/npm/node_modules/@narumitw/pi-goal/src/index.ts";

function hasPiBinary(): boolean {
  try {
    const result = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

describe("isolated real-Pi smoke matrix", () => {
  const piAvailable = hasPiBinary();

  it.runIf(piAvailable)("Case 1: LCM alone loads cleanly with --no-extensions", async () => {
    const disposableDir = await mkdtemp(join(tmpdir(), "pi-smoke-1-"));
    try {
      const result = spawnSync(
        "pi",
        [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "-e",
          LCM_ENTRYPOINT,
          "--list-models",
        ],
        {
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: disposableDir,
            PI_OFFLINE: "1",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(0);
    } finally {
      await rm(disposableDir, { recursive: true, force: true });
    }
  });

  it.runIf(piAvailable)("Case 2: safe-agent-team alone loads cleanly with --no-extensions", async () => {
    const disposableDir = await mkdtemp(join(tmpdir(), "pi-smoke-2-"));
    try {
      const result = spawnSync(
        "pi",
        [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "-e",
          SAFE_AGENT_ENTRYPOINT,
          "--list-models",
        ],
        {
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: disposableDir,
            PI_OFFLINE: "1",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(0);
    } finally {
      await rm(disposableDir, { recursive: true, force: true });
    }
  });

  it.runIf(piAvailable)("Case 3: LCM + safe-agent-team load together cleanly with --no-extensions", async () => {
    const disposableDir = await mkdtemp(join(tmpdir(), "pi-smoke-3-"));
    try {
      const result = spawnSync(
        "pi",
        [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "-e",
          LCM_ENTRYPOINT,
          "-e",
          SAFE_AGENT_ENTRYPOINT,
          "--list-models",
        ],
        {
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: disposableDir,
            PI_OFFLINE: "1",
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(0);
    } finally {
      await rm(disposableDir, { recursive: true, force: true });
    }
  });

  it.runIf(piAvailable)(
    "Case 4: LCM + safe-agent-team + pi-mono-context-guard + @narumitw/pi-goal load cleanly together",
    async () => {
      const disposableDir = await mkdtemp(join(tmpdir(), "pi-smoke-4-"));
      try {
        const result = spawnSync(
          "pi",
          [
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "-e",
            LCM_ENTRYPOINT,
            "-e",
            SAFE_AGENT_ENTRYPOINT,
            "-e",
            MONO_GUARD_ENTRYPOINT,
            "-e",
            PI_GOAL_ENTRYPOINT,
            "--list-models",
          ],
          {
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: disposableDir,
              PI_OFFLINE: "1",
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.status).toBe(0);
      } finally {
        await rm(disposableDir, { recursive: true, force: true });
      }
    },
  );
});
