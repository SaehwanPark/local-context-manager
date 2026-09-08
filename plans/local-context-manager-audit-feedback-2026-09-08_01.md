# Audit Feedback: `local-context-manager`

**Repository:** `SaehwanPark/local-context-manager`  
**Audited branch:** `main`  
**Audited HEAD:** `374e9fbc7f05b121090e57d54b9319ff05edcd56`  
**Audit date:** 2026-09-08  
**Companion architecture considered:** `pi-safe-agent-team` as the sole subagent/orchestration extension, plus `pi-mono-context-guard`, `pi-computer-use`, `pi-web-access`, `pi-chrome`, `pi-mcp-adapter`, and `@narumitw/pi-goal`.

## Executive summary

The current `main` remains a strong standalone context-management extension, especially around compaction lifecycle safety, recovery behavior, checkpoint review, and conservative configuration handling. I did not find evidence that the newly specified ecosystem-integration work has landed in this repository yet, however.

That matters because `pi-safe-agent-team` has already merged its half of the interoperability design. Its managed children now look for a provider named `local-context-manager.embedded-context.v1`, but current LCM does not publish one. Consequently, the intended child-context integration currently degrades to native Pi behavior.

The highest-priority issue is more serious than a stale checkpoint summary: `/checkpoint-reset` creates a new Pi session, while `pi-safe-agent-team` treats root-session shutdown as a lifecycle boundary that cancels all managed descendants. A checkpoint reset while delegated work is active can therefore terminate in-flight child work. The eventual fabric-aware implementation should make non-quiescent reset a protected operation, not merely a warning.

### Overall assessment

| Area | Assessment |
| --- | --- |
| Standalone compaction lifecycle | Strong |
| Standalone checkpoint/reset safety | Strong |
| Tool-output reduction/recovery | Strong with provenance gap |
| Configuration/default UX | Strong |
| Safe-agent child integration | Not implemented on current `main` |
| Fabric-aware semantic boundaries | Not implemented |
| Isolated real-Pi testing | Not codified |
| Cross-project reset safety | **Needs P0 fix before cohesive multi-agent use** |

## What is already done well

### 1. Compaction lifecycle handling is unusually defensive

`src/index.ts` correlates requested compactions with a session generation, retires old compaction IDs, ignores stale asynchronous recovery work, and treats persisted `session_compact` events as the authoritative completion signal. This directly addresses the kinds of lifecycle races that occur when Pi replaces context objects or emits delayed callbacks.

Keep this architecture. Do not simplify it while extracting an embedded API.

### 2. Tool-output reduction preserves recoverability

`src/tool-output.ts` is conservative about which outputs it reduces:

- ordinary `read` is not reduced;
- source-reading shell commands are preserved;
- large build/failure/search/diff outputs are selectively reduced;
- a structured `fullOutputPath` is trusted in preference to stdout;
- stdout cannot impersonate a recovery path.

When no structured recovery path exists, `src/index.ts` writes a restrictive local recovery copy and preserves the original result if that fallback fails. This is the correct failure direction.

### 3. Checkpoint reset is user-reviewed and failure-safe

`src/checkpoint-reset.ts`:

- waits for Pi to become idle;
- gathers deterministic repository metadata;
- generates a durable checkpoint and a smaller continuation capsule separately;
- validates strict section structure and output limits;
- requires user review/editing;
- requires explicit confirmation;
- writes the checkpoint atomically with restrictive permissions;
- preserves the original session if generation, review, storage, or session replacement fails.

This is a strong basis for adding fabric awareness.

### 4. Configuration behavior is low-friction

The profile-based defaults plus automatic downward adaptation to constrained context windows are appropriate for the intended mix of Codex and local Qwen models. The documentation is also clear that `hardCeilingTokens` is currently a **status boundary**, while Pi retains emergency-compaction authority. That is internally consistent and should not be changed merely to make the field name sound more forceful.

---

# Findings

## P0 — Integration-hardening work is not present on current `main`

### Evidence

The current source tree has no embedded-context module or interop registry implementation. `src/index.ts` remains extension-wiring-centric, and there is no registration of:

```text
local-context-manager.embedded-context.v1
```

There is likewise no consumer for:

```text
safe-agent-team.fabric-state.v1
```

### Consequence

`pi-safe-agent-team` now preserves `noExtensions: true` for managed children and optionally asks the process-local registry for LCM's embedded provider. Because LCM currently publishes no provider, every child falls back to native Pi context management.

This recreates the original asymmetry:

```text
root
  -> LCM-managed

safe-agent child
  -> native Pi context only
```

For short delegated tasks this is acceptable. For long-running local-Qwen workers, it defeats one of the main reasons LCM exists.

### Required fix

Implement the previously specified reusable controller and register it through the versioned process-local interop registry. Keep managed-child mode narrower than root mode:

**Enable in managed-child mode**

- context telemetry;
- adaptive threshold policy;
- tool-output reduction;
- threshold compaction at a host-declared safe boundary;
- evidence-completeness provenance.

**Disable by default**

- slash commands;
- handoff;
- checkpoint reset;
- checkpoint file creation;
- root TUI mutation;
- semantic cold-memory reset.

Do **not** solve this by making safe-agent children inherit arbitrary extensions.

### Acceptance criteria

- LCM alone behaves exactly as today.
- Safe-agent-team alone behaves natively.
- When both are loaded into the same isolated Pi process, a managed child reports `lcm-embedded`.
- Failure of the embedded controller returns the child to native behavior without failing the task.

---

## P0 — `/checkpoint-reset` can cancel active safe-agent children

### Why this is higher severity than the earlier design assumed

LCM's reset path ultimately calls:

```text
ctx.newSession(...)
```

A Pi session replacement causes extension shutdown for the old session.

Current `pi-safe-agent-team` handles `session_shutdown` by stopping its runtime, and `FabricRuntime.stop()` explicitly cancels every managed child before disposing it.

Therefore this sequence is possible:

```text
child A still implementing
child B still testing
root user invokes /checkpoint-reset
LCM creates fresh Pi session
old root session shuts down
safe-agent-team cancels A and B
```

The risk is not merely "checkpoint metadata may be stale." Active delegated work can be terminated.

### Required fix

Before `/checkpoint-reset`, query `safe-agent-team.fabric-state.v1`.

Recommended policy:

```text
provider unavailable
  -> preserve standalone LCM behavior

provider active + quiescent
  -> normal reviewed reset

provider active + non-quiescent
  -> refuse normal reset
  -> explain what remains active
  -> offer an explicitly destructive force path only if desired

provider active but state uncertain/error
  -> fail closed for session replacement
```

If a force path is implemented, make the consequence unmistakable:

> Continuing will replace the root Pi session and cancel active managed children.

Require a second explicit confirmation. A flag such as `/checkpoint-reset --force ...` plus UI confirmation is preferable to a generic warning.

### Forced-reset metadata

If the user deliberately forces reset:

- include a bounded coordination snapshot in the durable checkpoint;
- mark it as point-in-time state;
- state that active descendants were subject to cancellation by session replacement;
- do not describe the episode as globally complete.

### Tests

Add an integration test with a fake fabric provider:

- non-quiescent -> normal reset cannot reach `newSession()`;
- quiescent -> reset can proceed;
- provider throws while known active -> reset does not replace session;
- force + confirmation -> reset may proceed and includes coordination metadata.

---

## P0 — Fabric-aware semantic compaction should treat uncertainty conservatively

Semantic compaction does not replace the Pi session, so it does not cancel children. It can still freeze a misleading phase boundary while children are actively changing task state.

Current `agent_settled` logic schedules a semantic compaction whenever `semanticRequested` is true and LCM is enabled. It has no fabric check.

### Required policy

For **semantic** compaction only:

```text
fabric inactive/unavailable
  -> standalone behavior

fabric active + quiescent
  -> compact

fabric active + non-quiescent
  -> retain semantic request and defer to a later natural settled boundary

fabric query fails while a fabric is known to be active
  -> defer conservatively
```

Threshold compaction should remain independent: context safety must not wait indefinitely for child completion.

Do not poll. Re-check at lifecycle boundaries LCM already observes.

---

## P1 — The embedded compaction contract must match Pi's actual `AgentSession` API

This is a cross-project contract concern.

Current Pi SDK exposes an `AgentSession.compact(customInstructions?: string)` API. Safe-agent-team's newly merged embedded adapter currently passes an object-shaped compaction request to that method; that side needs correction.

LCM should avoid publishing a contract that encourages unsupported parameters such as a `targetTokens` object unless the host can actually honor them.

### Recommendation

Keep the embedded request narrow:

```ts
interface EmbeddedCompactionRequest {
  reason?: string;
  customInstructions?: string;
}
```

or make the host method even simpler:

```ts
compact(customInstructions?: string): Promise<void>;
```

The reusable LCM controller should decide *when* to compact. The safe-agent host should map that decision onto the Pi SDK's actual method signature.

Do not cast across this boundary with `any`.

---

## P1 — Reduced output needs explicit non-exhaustiveness provenance

Current reduction correctly stores/references the full output, but the reduced text does not explicitly warn the model that the excerpt is unsafe for conclusions involving:

- ordering;
- absence;
- exact counts;
- exhaustive match sets;
- temporal races.

A local 27B model is particularly likely to treat a compact excerpt as if it were the complete observation.

### Required fix

For every transformed output, append a stable warning such as:

```text
This is a non-complete excerpt. Re-open the saved full output before conclusions
that depend on ordering, absence, exact counts, or exhaustive matches.
```

Track whether any output was reduced in the current compaction epoch. When a compaction is built after reductions occurred, deterministically retain one bounded evidence note:

```text
Evidence completeness: some earlier tool outputs were reduced. Re-read authoritative
full output before conclusions requiring exhaustiveness, exact counts, absence, or event ordering.
```

Do not let this note accumulate repeatedly across compactions.

---

## P1 — Token-source telemetry should distinguish Pi's estimate from LCM's local fallback

The earlier implementation plan used the labels `"reported"` and `"estimated"`. Current upstream Pi makes an important distinction: `ContextUsage.tokens` is itself documented as an **estimated context-token count**.

So `"reported"` would be misleading.

Current LCM telemetry does not track source at all: both `observe()` and `observeEstimate()` end in the same token state.

### Better terminology

Use:

```ts
type ContextTokenSource =
  | "pi-estimate"
  | "local-fallback"
  | "unknown";
```

Then:

- `ctx.getContextUsage()?.tokens` -> `pi-estimate`;
- LCM character/message fallback -> `local-fallback`;
- unavailable -> `unknown`.

### UI

Compact status could use:

```text
ctx ~27k/32k
```

and detailed status could state:

```text
Token source: Pi estimate
```

or:

```text
Token source: local fallback estimate
```

This matters when comparing Codex vs. Qwen behavior and debugging unexpected compaction timing without introducing model-specific knobs.

---

## P1 — Isolated real-Pi smoke testing is not codified

Current CI is Ubuntu-only and runs:

- `npm run check`;
- `npm run build`;
- `npm pack --dry-run`.

That is useful, but it does not prove the external-harness workflow requested for Codex CLI / Antigravity CLI:

```text
developer harness
  -> isolated Pi SUT
  -> --no-extensions
  -> explicit -e entrypoints
  -> disposable PI_CODING_AGENT_DIR
```

### Required additions

Add a script or documented test harness that can run:

```text
1. LCM alone
2. safe-agent-team alone
3. LCM + safe-agent-team
4. LCM + safe-agent-team + mono-context-guard + goal
```

At least one CI smoke should instantiate Pi with:

```bash
PI_CODING_AGENT_DIR="$TMP" \
pi --no-extensions \
  -e "$LCM_REPO/src/index.ts"
```

Cross-project smoke can remain optional/manual if credentials make CI impractical, but the harness itself should live in the repository so the verification is reproducible.

### CI portability

Because this extension is intended for macOS, Linux, and Windows environments, consider matching safe-agent-team's three-OS CI matrix for path/config/lifecycle code. At minimum, add macOS because default case-insensitive filesystem behavior is a meaningful compatibility dimension.

---

## P2 — Recovery copies can accumulate in the OS temp directory

When a reduced result lacks a structured `fullOutputPath`, LCM creates a new temporary directory and writes:

```text
tool-output.txt
```

with restrictive mode.

There is no session-level retention/cleanup tracking in current code.

### Consequence

Long agentic sessions with many large outputs can leave:

- many temp directories;
- duplicated large logs;
- potentially sensitive build/test output until OS cleanup.

This is not a correctness flaw because recoverability is intentionally prioritized, but it is worth managing.

### Recommendation

Prefer one session-scoped recovery directory with:

- restrictive directory permissions;
- unique output filenames;
- bounded count/size policy;
- cleanup on clean session shutdown where safe;
- documentation that abrupt process death may leave recoverable temp data.

Do not delete a recovery copy before the active session can re-open it.

---

# Cross-project behavior to test explicitly

## Scenario A — Long local-Qwen worker

```text
root: LCM active
child: Qwen 3.8 Flash Next
task: long refactor + repeated builds/tests
```

Expected after integration:

- child embedded controller uses child's own context window;
- large outputs are reduced recoverably;
- threshold compaction occurs only at a safe child boundary;
- provider failure degrades to native context behavior.

## Scenario B — Goal mode + active workers

Expected:

- normal progress messages do not force unnecessary root turns;
- semantic compaction does not declare a global phase complete while child tasks remain unresolved;
- threshold compaction still protects root context.

## Scenario C — Reset during active delegation

Expected:

- ordinary `/checkpoint-reset` refuses to replace the root session;
- UI identifies running tasks/holds in bounded form;
- user can wait for quiescence;
- any force path clearly states that managed children will be cancelled.

## Scenario D — Fabric unavailable mid-session

Expected:

- LCM does not interpret a temporary provider/broker failure as proof that the fabric is absent;
- destructive session replacement is conservative;
- ordinary threshold context protection continues.

---

# Suggested implementation order

- [ ] Implement process-local interop helper and publish `local-context-manager.embedded-context.v1`.
- [ ] Refactor policy/output/telemetry primitives so root and embedded modes share one source of truth.
- [ ] Consume `safe-agent-team.fabric-state.v1`.
- [ ] Gate `/checkpoint-reset` on fabric quiescence; add explicit destructive force semantics if desired.
- [ ] Defer semantic compaction while an active fabric is non-quiescent.
- [ ] Keep threshold compaction independent from fabric quiescence.
- [ ] Add bounded coordination metadata to forced/uncertain checkpoint archives.
- [ ] Add explicit reduced-output non-exhaustiveness warning.
- [ ] Add evidence-reduction provenance through compaction.
- [ ] Add `pi-estimate` vs. `local-fallback` telemetry source.
- [ ] Add fake-provider tests.
- [ ] Add isolated real-Pi smoke harness using `--no-extensions` and explicit `-e`.
- [ ] Consider multi-OS CI.
- [ ] Add bounded recovery-copy lifecycle/cleanup.
- [ ] Update README/reference docs and changelog.

# Release recommendation

The current release is reasonable as a **standalone root-context extension**. I would not yet describe it as fully integrated with `pi-safe-agent-team`.

For the intended always-on multi-agent stack, the release-blocking items are:

1. embedded child context provider;
2. fabric-aware semantic boundaries;
3. checkpoint-reset protection against cancelling active delegated work.

Once those are implemented and verified in an isolated Pi SUT, the two projects will have a substantially cleaner and safer joint lifecycle.

# Audit scope and verification note

This review inspected the current GitHub `main` source, tests, configuration, and documentation and compared them with the already-merged safe-agent-team interoperability surface. It also checked the current upstream Pi SDK contract relevant to context usage and compaction. This audit is primarily static/code-level; repository CI/test claims should still be validated by the implementation agent in the isolated Pi harness described above.
