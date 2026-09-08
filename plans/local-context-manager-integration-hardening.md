# local-context-manager: Integration Hardening Implementation Plan

Repository: `SaehwanPark/local-context-manager`  
Target branch baseline: current `main` audited 2026-09-08  
Primary companion: `SaehwanPark/pi-safe-agent-team`  
Expected always-on root extensions: `pi-mono-context-guard`, `pi-computer-use`, `pi-web-access`, `pi-chrome`, `pi-mcp-adapter`, `@narumitw/pi-goal`, and `pi-safe-agent-team`  
Expected models: OpenAI Codex subscription models (GPT-5.6 Luna/Sol, GPT-6 Astra) and local Qwen 3.8 Flash Next / Qwen 3.8-27B.

## 1. Purpose

Harden `local-context-manager` for long-running, multi-agent Pi development without weakening its current conservative behavior.

The implementation must solve four integration problems:

1. Safe-agent children currently run with `noExtensions: true`, so they do not benefit from LCM even when LCM is active at the root.
2. Automatic semantic checkpoint/reset can occur while delegated work is still in flight, producing a stale or misleading continuation capsule.
3. Reduced tool output can preserve the wrong evidence granularity for tasks where ordering, absence, exact counts, or exhaustive matches matter.
4. Fallback context-token estimates are presented too similarly to host-reported usage, which makes model/window heterogeneity harder to diagnose.

The project must remain useful by itself. It must not acquire a hard dependency on `pi-safe-agent-team`.

## 2. Current implementation anchors

The current implementation already has strong primitives that should be reused rather than rewritten:

- `src/index.ts`
  - Pi lifecycle hooks for `turn_start`, `turn_end`, `agent_settled`, compaction events, and `tool_result`.
  - active-context estimation and threshold decisions.
  - custom compaction construction.
- `src/config.ts`
  - adaptive thresholds derived from the advertised model context window.
  - user profiles (`aggressive`, `balanced`, `relaxed`).
- `src/tool-output.ts`
  - selective reduction for build, failure, search, diff, and generic command output.
  - recovery-path support.
  - deliberate non-reduction of ordinary `read`.
- `src/checkpoint-reset.ts`
  - durable checkpoint archive.
  - compact hot continuation capsule.
  - deterministic repository metadata.
  - bounded generated output and strict headings.
- `src/telemetry.ts`
  - context/output telemetry.
- `src/policy.ts`
  - compaction trigger/rearm policy.

Preserve those responsibilities and extract reusable pieces instead of creating a second implementation path.

## 3. Non-goals

Do not:

- load arbitrary root Pi extensions into managed child agents;
- import `pi-safe-agent-team` directly;
- introduce model-specific hand-tuned thresholds for OpenAI vs. Qwen;
- require users to tune new numeric knobs for ordinary use;
- parse arbitrary tool stdout looking for fake file/recovery paths;
- silently drop recovery access to original tool output;
- block explicit user-requested checkpoint/reset solely because agents are active;
- make normal threshold compaction depend on safe-agent fabric quiescence.

The default user experience should remain "install and use."


## 1.1 Development and test execution contract

Implementation is expected to be performed by an **external coding harness** such as Codex CLI or Antigravity CLI. Do not develop or validate these changes from inside a normal long-running Pi session that has the user's global extensions active.

Treat Pi as the **system under test (SUT)**:

```text
Codex CLI / Antigravity CLI
  |
  +-- edits this repository
  +-- runs npm/unit tests directly
  |
  `-- spawns short-lived isolated Pi processes for smoke/integration tests
        |
        +-- global extension discovery disabled
        +-- only explicitly requested extension entrypoints loaded
        `-- disposable Pi state when full isolation is required
```

This separation is mandatory for integration tests intended to prove extension behavior. A passing test must not depend on another globally installed extension accidentally providing hooks, tools, configuration, or process-global state.

### A. Default extension-isolated Pi invocation

For LCM-only smoke tests, use an explicit entrypoint path:

```bash
pi \
  --no-extensions \
  -e "$LCM_REPO/src/index.ts"
```

For LCM + safe-agent-team interoperability tests:

```bash
pi \
  --no-extensions \
  -e "$LCM_REPO/src/index.ts" \
  -e "$SAFE_AGENT_REPO/index.ts"
```

Pi's `-e/--extension` flag is repeatable and `--no-extensions` disables ordinary extension discovery. Do not temporarily install the development checkout into the user's normal Pi settings merely to test it.

### B. Strict deterministic Pi invocation

When a test must isolate not only extensions but also unrelated Pi prompt resources, use:

```bash
pi \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e "$LCM_REPO/src/index.ts" \
  -e "$SAFE_AGENT_REPO/index.ts"
```

Keep Pi built-in tools enabled unless the test specifically targets tool absence.

### C. Full Pi-state isolation

For lifecycle, checkpoint, session, state-directory, or cross-extension integration tests, create a disposable Pi config directory:

```bash
TEST_PI_DIR="$(mktemp -d)"

PI_CODING_AGENT_DIR="$TEST_PI_DIR" \
pi \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e "$LCM_REPO/src/index.ts" \
  -e "$SAFE_AGENT_REPO/index.ts"
```

Use `PI_CODING_AGENT_DIR`; do not invent a parallel environment-variable convention.

If a model-backed smoke test requires existing authentication/model configuration, provision only the minimum required files into the disposable directory (for example, an opaque `auth.json` and, if needed, `models.json`). Do **not** copy normal `settings.json`, extension directories, project extension configuration, or package state into the isolated directory.

Credential files are test fixtures only:

- never print them;
- never parse/summarize them in test output;
- never modify them;
- never commit them;
- prefer a read-only copy/link or a local-model route when practical.

Always delete the disposable directory after the test.

### D. Test pyramid

Prefer:

```text
many pure/unit tests
  -> fake-host embedded-context tests
  -> fake interop-provider tests
  -> a small number of real Pi process tests
  -> selected full-stack smoke tests
```

Do not use an LLM-backed Pi run to test logic that can be proven deterministically with Vitest.

### E. Required isolated smoke matrix

At minimum, before completion run:

```text
1. LCM alone
2. safe-agent-team alone
3. LCM + safe-agent-team
4. LCM + safe-agent-team + pi-mono-context-guard + @narumitw/pi-goal
```

For case 4, load companion packages explicitly with `-e npm:<package>` rather than through global discovery.

`pi-web-access`, `pi-chrome`, `pi-computer-use`, and `pi-mcp-adapter` need only targeted compatibility smoke tests for the capability-boundary behavior under test; do not make every CI run depend on external browser/MCP state.

### F. Process-local interop implication

The proposed `Symbol.for("pi.extension-interop.v1")` registry is intentionally process-local. This works in the required harness because both LCM and safe-agent-team are explicitly loaded into the **same isolated Pi process**. Codex CLI/Antigravity does not need access to that registry.

Do not redesign the registry into filesystem or network IPC merely because the development harness itself runs in a different process.

---

# 4. P0: Extract an embeddable context-management API

## 4.1 Goal

Allow a controlled host such as `pi-safe-agent-team` to reuse LCM's safe context policy inside a manually created `AgentSession` without loading the LCM extension itself and without loading any unrelated extension.

This is the key integration feature.

## 4.2 Architecture

Split extension-specific wiring from context-management logic.

Create a reusable module, for example:

```text
src/embedded/
  types.ts
  controller.ts
  interop.ts
```

The exact file names may differ, but preserve the separation:

```text
Pi ExtensionAPI adapter
        |
        v
Reusable context controller
        |
        +-- threshold policy
        +-- telemetry
        +-- tool-output reduction
        +-- compaction planning
        +-- evidence provenance
```

The controller must not depend on `ExtensionAPI`.

## 4.3 Public API

Expose a stable API from the npm package.

Suggested shape:

```ts
export interface EmbeddedContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  source: "reported" | "estimated";
}

export interface EmbeddedContextHost {
  getContextUsage(): EmbeddedContextUsage | null;
  getContextEntries(): SessionEntry[];

  /**
   * Called only at a host-declared safe boundary.
   * The host remains authoritative about whether compaction is currently legal.
   */
  compact(request: EmbeddedCompactionRequest): Promise<void>;

  /**
   * Optional host notification. Must never be required for correctness.
   */
  onStatus?(snapshot: EmbeddedContextSnapshot): void;
  onDiagnostic?(diagnostic: EmbeddedContextDiagnostic): void;
}

export interface EmbeddedContextManagerOptions {
  config?: Partial<LocalContextManagerConfig>;

  /**
   * Child-safe mode disables root-session-only features by default.
   */
  mode?: "root" | "managed-child";

  /**
   * Optional advertised model context window.
   */
  contextWindow?: number;
}

export interface EmbeddedToolResult {
  toolName: string;
  input: Record<string, unknown>;
  content: ReadonlyArray<ToolContentBlock>;
  details?: unknown;
  isError: boolean;
}

export interface EmbeddedContextManager {
  observeTurnStart(): void;
  observeTurnEnd(): void;

  /**
   * Host calls this only when the model/session is settled.
   * May request threshold compaction through host.compact().
   */
  observeSettled(): Promise<void>;

  /**
   * Returns transformed output when reduction is appropriate.
   * Must preserve current LCM recovery semantics.
   */
  transformToolResult(result: EmbeddedToolResult): Promise<EmbeddedToolResult>;

  snapshot(): EmbeddedContextSnapshot;
  dispose(): void;
}

export function createEmbeddedContextManager(
  host: EmbeddedContextHost,
  options?: EmbeddedContextManagerOptions,
): EmbeddedContextManager;
```

The final API may be smaller, but it must support:

- telemetry;
- output reduction;
- threshold decisions;
- safe-boundary compaction;
- explicit token-source reporting;
- cleanup.

## 4.4 Managed-child defaults

`mode: "managed-child"` must be deliberately narrower than root mode.

Default ON:

- context usage telemetry;
- adaptive threshold policy;
- tool-output reduction;
- threshold compaction at host-safe boundaries;
- evidence-completeness provenance.

Default OFF:

- user-facing slash commands;
- handoff;
- checkpoint reset;
- semantic checkpoint/reset;
- writing durable cold-memory files;
- root TUI status manipulation.

This preserves safe-agent's capability boundary.

## 4.5 Refactor requirement

The Pi extension implementation in `src/index.ts` should consume the same reusable core wherever practical.

Do not allow:

```text
root policy implementation
+
different embedded-child policy implementation
```

to drift independently.

Pure helpers such as token estimation, threshold resolution, output reduction, and compaction-slice planning should have one source of truth.

## 4.6 Failure behavior

Embedded mode must fail soft.

If an embedded host adapter throws:

- do not crash the child model session;
- emit a bounded diagnostic through `onDiagnostic`;
- leave native Pi behavior authoritative;
- do not retry in a tight loop;
- do not manufacture a compaction entry.

A context-manager integration failure must degrade to "native child context behavior," not "child task failure."

---

# 5. P0: Add an optional process-local extension interoperability registry

## 5.1 Goal

Permit cooperation with safe-agent-team without either package importing the other.

Use a tiny process-local capability registry until/unless Pi provides an official extension service registry.

## 5.2 Registry contract

Use a global symbol, not a common global string property:

```ts
const PI_EXTENSION_INTEROP = Symbol.for("pi.extension-interop.v1");
```

Suggested structural shape:

```ts
export interface PiExtensionInteropRegistryV1 {
  version: 1;
  providers: Map<string, unknown>;
}
```

Provider names:

```text
local-context-manager.embedded-context.v1
safe-agent-team.fabric-state.v1
```

Requirements:

- versioned;
- structural typing;
- no secrets;
- no auth tokens;
- no broker handles exposed;
- provider absence is normal;
- provider failure is non-fatal;
- duplicate incompatible providers must be detected and ignored with a diagnostic;
- do not mutate another provider's registration.

If an official Pi mechanism exists that provides the same semantics, prefer that and keep the provider interface conceptually equivalent.

## 5.3 LCM provider

Register:

```text
local-context-manager.embedded-context.v1
```

The provider should expose a factory for the embedded controller.

Registration should be idempotent.

The provider is a stateless factory, so it may remain available across root session changes as long as the extension module remains loaded.

---

# 6. P0: Make automatic semantic reset fabric-aware

## 6.1 Goal

Do not declare a semantic episode complete while coordinated child work is still materially in flight.

Only semantic checkpoint/reset behavior needs quiescence awareness. Normal threshold compaction must continue to protect the root context regardless of fabric activity.

## 6.2 Consume safe-agent fabric state optionally

Look up:

```text
safe-agent-team.fabric-state.v1
```

Suggested provider:

```ts
export interface FabricSnapshotRequest {
  cwd: string;
  sessionId?: string;
}

export interface FabricStateSnapshotV1 {
  active: boolean;
  quiescent: boolean;
  runningChildren: number;
  unresolvedChildTasks: number;
  mutableHolds: number;
  pendingRootRequests: number;
  pendingRootDeliveries: number;

  activeTasks: Array<{
    id: string;
    status: string;
    owner?: string;
    description?: string;
  }>;

  mutableResources: Array<{
    id: string;
    path?: string;
    holder?: string;
  }>;
}
```

The provider may return fewer bounded details but must expose enough information for a deterministic quiescence decision and checkpoint metadata.

## 6.3 Automatic semantic-reset policy

For an automatic semantic checkpoint/reset:

```text
fabric unavailable/inactive
  -> existing behavior

fabric active + quiescent
  -> existing behavior

fabric active + not quiescent
  -> defer semantic reset
  -> keep request pending
  -> re-evaluate at later settled boundaries
```

Do not busy-poll.

Do not schedule timers merely to recheck quiescence.

Use natural lifecycle boundaries already observed by LCM.

## 6.4 Hard-ceiling behavior

Context safety wins over semantic neatness.

If the root reaches the hard ceiling while fabric activity remains:

```text
perform required compaction/reset
+
deterministically embed a bounded fabric snapshot
+
mark that coordinated work was active
```

Never let quiescence deferral cause context exhaustion.

## 6.5 Explicit user command behavior

If the user explicitly invokes checkpoint/reset while the fabric is active:

- do not block the request;
- warn once that delegated work is still active;
- include a deterministic fabric snapshot;
- proceed.

User intent overrides the automatic deferral rule.

## 6.6 Persist coordination state deterministically

Do not ask the checkpoint model to infer fabric state from conversation text.

Add deterministic host metadata.

Preferred approach: extend existing repository metadata sections without creating a fragile model-generated heading requirement.

Example:

```markdown
## Current Repository State
- Repository: ...
- Branch: ...
- HEAD: ...
- Working tree: dirty

### Coordination State
- Fabric: active
- Quiescent: no
- Running children: 2
- Unresolved child tasks: 2
- Mutable holds: 1
- Pending root requests: 0
- Active task T-12 [active], owner agent-4
- Active task T-13 [blocked], owner agent-7
- Mutable resource src/parser, holder agent-4
```

Apply the same bounded metadata to the durable checkpoint.

Do not persist message bodies or secrets merely to describe fabric status.

## 6.7 Stale snapshot protection

Treat the snapshot as point-in-time metadata.

Include a capture timestamp if available.

Do not claim the checkpoint is a live representation of agents after reset.

---

# 7. P0: Preserve evidence-completeness provenance

## 7.1 Problem

LCM correctly retains important diagnostic lines, but reduced output is unsafe as an exhaustive source for questions involving:

- ordering;
- absence;
- exact counts;
- complete match sets;
- chronological races;
- "nothing else happened" conclusions.

## 7.2 Change reduced-output notices

Whenever LCM transforms an output, make incompleteness explicit.

Append a concise, stable warning such as:

```text
This is a non-complete excerpt. Re-open the saved full output before conclusions
that depend on ordering, absence, exact counts, or exhaustive matches.
```

When a recovery path exists, keep the existing full-output pointer adjacent to this warning.

Do not imply the excerpt is exhaustive.

## 7.3 Track per-episode reduction provenance

Maintain bounded session state such as:

```ts
interface EvidenceReductionState {
  reducedOutputs: number;
  categories: Set<"build" | "failure" | "search" | "diff" | "generic">;
  sinceLastCompaction: boolean;
}
```

When building a compaction summary after reductions occurred, deterministically add a short instruction or retained note:

```text
Evidence completeness: some prior tool outputs were reduced. Re-read authoritative
full output if a later conclusion requires exhaustive matches, exact counts,
absence, or event ordering.
```

This note should survive compaction but not grow cumulatively.

Reset the "since last compaction" counter after successful compaction while preserving any already-materialized summary note.

## 7.4 Companion extension behavior

Do not hard-code parsing of `pi-mono-context-guard` textual messages.

If a future upstream tool result exposes structured truncation metadata, support it through a generic optional field.

Until then, reliably track only LCM's own reductions.

---

# 8. P1: Distinguish reported from estimated token usage

## 8.1 Goal

Make it obvious when threshold decisions are based on host-reported context usage versus LCM's character-based fallback estimate.

## 8.2 Telemetry change

Add a token-source field:

```ts
type ContextTokenSource = "reported" | "estimated" | "unknown";
```

Expose it in `ContextTelemetry` snapshots.

When `context.getContextUsage()` supplies actual tokens:

```text
source = reported
```

When LCM calculates from active session entries:

```text
source = estimated
```

## 8.3 UI

Make estimated values visually explicit, for example:

```text
ctx ~27k / 128k · compact 32k
```

or:

```text
ctx 27k est. / 128k
```

Do not add noisy warnings every turn.

## 8.4 Policy

Do not introduce model-name-specific thresholds.

Continue deriving effective thresholds from:

```text
configured profile
+
advertised context window
```

Use real reported usage whenever available.

If later evidence shows the estimator systematically undercounts a model family, fix the estimator or use a generic conservative uncertainty treatment; do not create a user-maintained provider/model lookup table.

---

# 9. P1: Improve compaction safety for temporal diagnostics

Current line-priority heuristics are good for conventional compiler/test failures. Add a conservative escape hatch rather than trying to infer every log format.

Possible implementation:

- keep current scoring;
- always preserve head/tail;
- preserve the explicit non-exhaustive warning;
- when the command name or output metadata indicates a known event/log stream, prefer contiguous temporal windows around high-priority lines over isolated lines.

Do not substantially increase retained output by default.

Tests should include concurrency traces where benign-looking lines are causally important.

---

# 10. P1: Expose integration diagnostics without configuration burden

Extend `/context-status` or the existing status surface to report:

```text
context source: reported|estimated
embedded provider: available|unavailable
fabric provider: active|inactive|unavailable
semantic reset: ready|deferred by active fabric
reduced outputs since compaction: N
```

Keep normal status compact; put detail behind the existing detailed status command if possible.

No new setup workflow should be required.

---

# 11. Configuration changes

Prefer behavioral defaults over knobs.

If configuration additions are necessary, keep them boolean and default-on:

```ts
interface LocalContextManagerConfig {
  // existing...
  fabricAwareSemanticReset: boolean; // default true
  evidenceCompletenessNotice: boolean; // default true
}
```

However, if these can safely be unconditional, do not expose configuration at all.

Do not add:

- per-provider thresholds;
- per-model thresholds;
- user-configured deferral polling intervals;
- hand-tuned "Qwen mode";
- numeric child-context tuning.

Managed-child mode should use the same context profile logic and adapt automatically to its model's advertised context window.

---

# 12. Cross-project contract tests

Add tests that use a fake interop registry; do not require installing safe-agent-team in LCM's unit-test suite.

Required cases:

- no registry -> exact standalone behavior;
- registry exists but fabric provider absent -> exact standalone behavior;
- provider throws -> warning/diagnostic, no root failure;
- inactive fabric -> semantic reset proceeds;
- active + quiescent fabric -> proceeds;
- active + non-quiescent fabric -> automatic semantic reset defers;
- active + non-quiescent + hard ceiling -> context safety proceeds and snapshot is embedded;
- explicit user reset + non-quiescent -> warning and proceed;
- stale/different cwd or session snapshot -> ignore rather than cross-contaminate sessions;
- provider returns oversized task/resource lists -> clamp deterministically;
- embedded controller provider can be discovered and instantiated;
- embedded controller failure does not crash host.

---

# 13. Tool-output tests

Add explicit tests for:

- reduced failure output includes non-exhaustive warning;
- reduced search output never claims complete matches;
- reduced diff output preserves recovery pointer;
- full output remains mode `0600` when LCM creates the recovery copy;
- chronological race log still tells model to inspect full output;
- normal `read` remains untouched;
- source-reading shell commands remain untouched under current policy;
- structured `fullOutputPath` remains preferred over parsing stdout;
- arbitrary stdout cannot inject a fake recovery path.

---

# 14. Checkpoint/reset tests

Required regression scenarios:

### Scenario A: clean episode

```text
root settled
fabric quiescent
semantic reset requested
```

Expected: normal checkpoint/reset.

### Scenario B: child still writing

```text
root settled
child active
mutable hold present
semantic reset requested automatically
```

Expected: defer, no archive yet.

### Scenario C: child blocked on root

```text
pending root clarification/request
```

Expected: automatic semantic reset defers.

### Scenario D: hard ceiling during active child work

Expected:

- root context is protected;
- checkpoint/reset or required compaction occurs;
- deterministic coordination snapshot is included;
- no claim that the episode was globally complete.

### Scenario E: user explicitly requests reset during child activity

Expected:

- one warning;
- reset proceeds;
- coordination snapshot included.

---

# 15. Compatibility requirements

The implementation is acceptable only if:

- LCM still works with no companion extensions installed;
- existing config files continue to parse unchanged;
- existing checkpoint archives remain readable;
- existing profiles retain their current defaults unless a bug requires correction;
- `pi-mono-context-guard` remains complementary;
- existing `tool_result` recovery semantics remain secure;
- no direct import from `pi-safe-agent-team` is added;
- embedded mode cannot write checkpoint files unless explicitly enabled by its host;
- root ExtensionAPI behavior remains the canonical reference implementation.
- real-Pi tests must use `--no-extensions` with explicit `-e` paths; full-state tests must use a disposable `PI_CODING_AGENT_DIR`.

---

# 16. Suggested implementation order

- [ ] Introduce token-source telemetry (`reported` vs `estimated`).
- [ ] Extract pure/reusable policy primitives from `src/index.ts` where necessary.
- [ ] Implement `createEmbeddedContextManager`.
- [ ] Add package exports for the embedded API.
- [ ] Add process-local interop registry helper.
- [ ] Add isolated real-Pi smoke harness using `--no-extensions` and explicit `-e` entrypoints.
- [ ] Register `local-context-manager.embedded-context.v1`.
- [ ] Add optional discovery of `safe-agent-team.fabric-state.v1`.
- [ ] Add automatic semantic-reset quiescence gate.
- [ ] Add forced/user-reset coordination snapshots.
- [ ] Add evidence-reduction provenance and non-exhaustive notices.
- [ ] Add status/diagnostic visibility.
- [ ] Add unit tests for embedded mode.
- [ ] Add fake-provider interoperability tests.
- [ ] Add checkpoint/reset integration tests.
- [ ] Update README/reference docs.
- [ ] Add changelog entry documenting behavior and compatibility.

---

# 17. Definition of done

The work is complete when all of the following are true:

1. LCM can be embedded in a managed Pi child session without loading global extensions.
2. The standalone Pi extension and embedded controller share the same policy primitives.
3. LCM does not automatically declare a semantic episode complete while safe-agent coordinated work is non-quiescent.
4. Context hard-ceiling protection can never be indefinitely blocked by fabric activity.
5. Explicit user reset remains possible at all times.
6. Any reset during active fabric work preserves a bounded deterministic coordination snapshot.
7. Reduced output explicitly states when it is non-exhaustive and remains recoverable.
8. Compacted context retains a bounded evidence-completeness caveat when relevant.
9. Estimated context usage is visibly distinguished from host-reported usage.
10. No new routine manual tuning is required for OpenAI vs local Qwen models.
11. Existing standalone behavior remains compatible when safe-agent-team is absent.
12. CI includes regression tests covering the cross-project scenarios above.
13. Real-Pi smoke tests run with global extension discovery disabled and explicit development entrypoints.
14. Full-isolation tests use `PI_CODING_AGENT_DIR` rather than the user's normal Pi state.

## Final engineering principle

Treat context state as part of the multi-agent runtime, but do not make LCM an orchestrator. LCM owns context policy; safe-agent-team owns actors, resources, and execution coordination. Their integration should exchange bounded state and reusable policy through a narrow optional protocol, not through implicit extension inheritance.
