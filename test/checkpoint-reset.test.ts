import { readFile, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  class TestLoader {
    readonly signal = new AbortController().signal;
    onAbort: (() => void) | undefined;
    constructor(_tui: unknown, _theme: unknown, _message: string) {}
    dispose(): void {}
  }
  return { ...actual, BorderedLoader: TestLoader };
});

import {
  buildCapsuleDocument,
  buildCheckpointDocument,
  chooseCheckpointPath,
  generateCheckpointArtifacts,
  getCheckpointStorageDirectory,
  getLatestCheckpointResetRecord,
  getRepositoryState,
  listCheckpointFiles,
  makeCheckpointResetRecord,
  repositoryIdentifier,
  resolveCheckpointDirectory,
  runCheckpointReset,
  slugifyCheckpointReason,
  writeCheckpointAtomically,
  type CheckpointResetInput,
  type CommandRunner,
  type RepositoryState,
} from "../src/checkpoint-reset.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const repositoryState: RepositoryState = {
  workingDirectory: "/work/local-context-manager",
  repositoryRoot: "/work/local-context-manager",
  branch: "feat/checkpoint-reset",
  head: "0123456789abcdef",
  workingTree: "dirty",
};

const input: CheckpointResetInput = {
  createdAt: "2026-09-04T12:34:56.789Z",
  reason: "PR #123 merged",
  repositoryState,
  parentSession: "/home/test/.pi/agent/sessions/parent.jsonl",
  checkpointPath: "/home/test/.pi/agent/local-context-manager/checkpoints/repo-test/2026-checkpoint.md",
  conversationText: "The completed implementation changed src/index.ts and passed npm test.",
};

const checkpointSections = [
  "## Goals\n- Keep the cache prefix stable.",
  "## Standing Constraints\n- Use TypeScript and Node built-ins.",
  "## Decisions and Rationale\n- Keep archive files outside the repository.",
  "## Work Completed\n- Added the reset flow.",
  "## Relevant Files\n- src/index.ts\n- src/checkpoint-reset.ts",
  "## Verification\n- npm test passed.",
  "## Problems Encountered\n- unknown",
  "## Rejected Approaches\n- Do not use automatic retrieval.",
  "## Unresolved Issues\n- The next feature is not selected.",
  "## Follow-ups\n- Continue the same project.",
  "## Historical Notes\n- The detailed episode remains in the parent session.",
].join("\n\n");

const capsuleSections = [
  "## Active Goals\n- Continue maintaining the project.",
  "## Standing Constraints\n- Keep the active capsule small.",
  "## Durable Decisions\n- Historical details stay on disk.",
  "## Outstanding Work\n- Verify the next requested change.",
].join("\n\n");

function modelContext(firstResponse: string, secondResponse: string): ExtensionCommandContext {
  const responses = [firstResponse, secondResponse];
  return {
    model: { maxTokens: 16_384 },
    modelRegistry: {
      complete: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: responses.shift() ?? "" }],
      })),
    },
  } as unknown as ExtensionCommandContext;
}

function fakeRunner(outputs: Record<string, string>): CommandRunner {
  return async (_command, args) => {
    const key = args.join(" ");
    const output = outputs[key];
    return { stdout: output ?? "", stderr: output === undefined ? "not found" : "", code: output === undefined ? 1 : 0 };
  };
}

describe("checkpoint reset artifacts", () => {
  it("keeps the durable archive richer than the minimal capsule", async () => {
    const ctx = modelContext(checkpointSections, capsuleSections);
    const artifacts = await generateCheckpointArtifacts(ctx, input, new AbortController().signal);

    expect(artifacts.checkpoint).toContain("# Context Checkpoint");
    expect(artifacts.checkpoint).toContain("## Metadata");
    expect(artifacts.checkpoint).toContain("- Branch: feat/checkpoint-reset");
    expect(artifacts.checkpoint).toContain("## Rejected Approaches");
    expect(artifacts.checkpoint).toContain("src/checkpoint-reset.ts");
    expect(artifacts.capsule).toContain("## Current Repository State");
    expect(artifacts.capsule).toContain(input.checkpointPath);
    expect(artifacts.capsule).not.toContain("## Historical Notes");
    expect(artifacts.checkpoint.length).toBeGreaterThan(artifacts.capsule.length);

    const complete = (ctx.modelRegistry.complete as unknown as ReturnType<typeof vi.fn>);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[1].systemPrompt).not.toBe(complete.mock.calls[1]?.[1].systemPrompt);
    expect(complete.mock.calls[0]?.[2].cacheRetention).toBe("none");
    expect(complete.mock.calls[0]?.[2].sessionId).toEqual(expect.any(String));
  });

  it("fails closed when either generated artifact is incomplete", async () => {
    const incompleteCheckpoint = modelContext("## Goals\n- only one section", capsuleSections);
    await expect(
      generateCheckpointArtifacts(incompleteCheckpoint, input, new AbortController().signal),
    ).rejects.toThrow("Checkpoint generation returned incomplete structured output");

    const incompleteCapsule = modelContext(checkpointSections, "## Active Goals\n- only one section");
    await expect(
      generateCheckpointArtifacts(incompleteCapsule, input, new AbortController().signal),
    ).rejects.toThrow("Continuation capsule generation returned incomplete structured output");
  });

  it("keeps missing repository facts explicit", () => {
    const state: RepositoryState = { workingDirectory: "/not-a-repository", workingTree: "unknown" };
    const { parentSession: _parentSession, ...inputWithoutParentSession } = input;
    const minimalInput = { ...inputWithoutParentSession, repositoryState: state };
    const checkpoint = buildCheckpointDocument(minimalInput, checkpointSections);
    const capsule = buildCapsuleDocument(minimalInput, capsuleSections);

    expect(checkpoint).toContain("- Repository: unknown");
    expect(checkpoint).toContain("- Parent Pi session: unknown");
    expect(capsule).toContain("- Branch: unknown");
    expect(capsule).toContain(input.checkpointPath);
  });
});

describe("checkpoint storage", () => {
  it("uses a hashed repository directory and restrictive atomic files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-checkpoint-test-"));
    try {
      const state = { ...repositoryState, repositoryRoot: "/private/repository/path" };
      const storage = getCheckpointStorageDirectory(DEFAULT_CONFIG, directory, "/private/repository/path", state);
      expect(storage).toContain(join(directory, "local-context-manager", "checkpoints"));
      expect(storage).not.toContain("/private/repository/path");
      expect(repositoryIdentifier(state)).toMatch(/^repo-[a-f0-9]{16}$/);
      expect(resolveCheckpointDirectory(DEFAULT_CONFIG, directory, state.workingDirectory)).toContain(
        join(directory, "local-context-manager", "checkpoints"),
      );

      const path = await chooseCheckpointPath(storage, input.createdAt, "PR #123 merged / unsafe");
      expect(path).toMatch(/2026-09-04T12-34-56-789Z-pr-123-merged-unsafe\.md$/);
      expect(slugifyCheckpointReason("../../private notes")).toBe("private-notes");
      await writeCheckpointAtomically(path, `${buildCheckpointDocument(input, checkpointSections)}\n`);

      expect(await readFile(path, "utf8")).toContain("# Context Checkpoint");
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      const listed = await listCheckpointFiles(storage);
      expect(listed).toEqual([
        expect.objectContaining({
          createdAt: input.createdAt,
          reason: input.reason,
          path,
        }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replace an existing checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-checkpoint-test-"));
    try {
      const path = join(directory, "existing.md");
      await writeCheckpointAtomically(path, "first");
      await expect(writeCheckpointAtomically(path, "second")).rejects.toThrow("already exists");
      expect(await readFile(path, "utf8")).toBe("first");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("repository metadata and reset records", () => {
  it("reads git metadata when available and degrades when it is not", async () => {
    const runner = fakeRunner({
      "rev-parse --show-toplevel": "/repo",
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "abcdef",
      "status --porcelain": " M src/index.ts",
    });
    await expect(getRepositoryState("/repo", runner)).resolves.toEqual({
      workingDirectory: "/repo",
      repositoryRoot: "/repo",
      branch: "main",
      head: "abcdef",
      workingTree: "dirty",
    });
    await expect(getRepositoryState("/tmp/no-repo", fakeRunner({}))).resolves.toEqual({
      workingDirectory: "/tmp/no-repo",
      workingTree: "unknown",
    });
  });

  it("restores the latest reset record from session state", () => {
    const record = makeCheckpointResetRecord(input, 3);
    const entries = [
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "local-context-manager-checkpoint-reset", data: record },
    ] as never;
    expect(getLatestCheckpointResetRecord(entries)).toEqual(record);
  });
});

function makeResetContext(
  root: string,
  uiOverrides: Record<string, unknown> = {},
  newSessionMode: "success" | "throw" = "success",
): ExtensionCommandContext {
  const userEntry = {
    id: "user-1",
    parentId: null,
    type: "message" as const,
    timestamp: new Date().toISOString(),
    message: {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Continue this project after the completed episode." }],
      timestamp: Date.now(),
    },
  };
  const sessionManager = {
    buildContextEntries: () => [userEntry],
    getSessionFile: () => "/tmp/parent-session.jsonl",
    appendCustomEntry: vi.fn(),
  };
  const replacementUi = {
    setEditorText: vi.fn(),
    notify: vi.fn(),
  };
  const newSession = vi.fn(async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
    if (newSessionMode === "throw") {
      throw new Error("replacement unavailable");
    }
    await options?.setup?.(sessionManager as never);
    await options?.withSession?.({ ui: replacementUi } as never);
    return { cancelled: false };
  });
  let responses = [checkpointSections, capsuleSections];
  const defaultUi = {
    custom: vi.fn(async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => { dispose?: () => void }) => {
      let component: { dispose?: () => void } | undefined;
      return new Promise<unknown>((resolve) => {
        component = factory(
          undefined,
          { fg: (_name: string, text: string) => text },
          {},
          (value: unknown) => {
            component?.dispose?.();
            resolve(value);
          },
        );
      });
    }),
    editor: vi.fn(async (_title: string, prefill?: string) => prefill),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
  };
  const modelRegistry = {
    hasConfiguredAuth: () => true,
    complete: vi.fn(async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: responses.shift() ?? "" }],
    })),
  };
  return {
    mode: "tui",
    cwd: root,
    model: { maxTokens: 16_384 },
    modelRegistry,
    isIdle: () => true,
    waitForIdle: vi.fn(async () => undefined),
    sessionManager,
    ui: { ...defaultUi, ...uiOverrides },
    newSession,
  } as unknown as ExtensionCommandContext;
}

describe("reset transaction", () => {
  it("writes before starting a parent-linked fresh session and prepares the capsule", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-reset-test-"));
    try {
      const context = makeResetContext(directory);
      await runCheckpointReset("PR #123 merged", context, {
        config: { ...DEFAULT_CONFIG, checkpointDirectory: directory },
        agentDir: directory,
        runCommand: fakeRunner({
          "rev-parse --show-toplevel": directory,
          "rev-parse --abbrev-ref HEAD": "main",
          "rev-parse HEAD": "abcdef",
          "status --porcelain": "",
        }),
        previousResetCount: 0,
      });

      const files = await listCheckpointFiles(
        getCheckpointStorageDirectory(
          { ...DEFAULT_CONFIG, checkpointDirectory: directory },
          directory,
          directory,
          { workingDirectory: directory, repositoryRoot: directory, branch: "main", head: "abcdef", workingTree: "clean" },
        ),
      );
      expect(files).toHaveLength(1);
      expect(context.newSession).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the saved checkpoint when fresh-session creation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-reset-test-"));
    try {
      const context = makeResetContext(directory, {}, "throw");
      await runCheckpointReset("completed milestone", context, {
        config: { ...DEFAULT_CONFIG, checkpointDirectory: directory },
        agentDir: directory,
        runCommand: fakeRunner({ "rev-parse --show-toplevel": directory }),
        previousResetCount: 0,
      });

      expect(context.newSession).toHaveBeenCalledTimes(1);
      const storage = getCheckpointStorageDirectory(
        { ...DEFAULT_CONFIG, checkpointDirectory: directory },
        directory,
        directory,
        { workingDirectory: directory, repositoryRoot: directory, workingTree: "unknown" },
      );
      expect(await listCheckpointFiles(storage)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not write or switch when the user declines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-context-manager-reset-test-"));
    try {
      const context = makeResetContext(directory, {
        confirm: vi.fn(async () => false),
      });
      await runCheckpointReset("completed milestone", context, {
        config: { ...DEFAULT_CONFIG, checkpointDirectory: directory },
        agentDir: directory,
        runCommand: fakeRunner({ "rev-parse --show-toplevel": directory }),
        previousResetCount: 0,
      });

      expect((context.newSession as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      const storage = getCheckpointStorageDirectory(
        { ...DEFAULT_CONFIG, checkpointDirectory: directory },
        directory,
        directory,
        { workingDirectory: directory, repositoryRoot: directory, workingTree: "unknown" },
      );
      await expect(listCheckpointFiles(storage)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});