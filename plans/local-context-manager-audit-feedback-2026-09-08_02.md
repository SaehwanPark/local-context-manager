# Re-audit Feedback: `local-context-manager`

**Repository:** `SaehwanPark/local-context-manager`  
**Audited branch:** `main`  
**Audited HEAD:** `458ef08a866b1946bed6abd201259253d0b9aeba`  
**Version:** `0.4.1`  
**Audit date:** 2026-09-08  
**Companion contract checked against:** current `SaehwanPark/pi-safe-agent-team`

## Executive summary

The update is a substantial improvement. Most of the planned integration-hardening architecture has landed:

- reusable embedded context management;
- process-local extension interoperability;
- child-safe managed mode;
- fabric-aware semantic behavior;
- explicit force-gated checkpoint reset;
- non-exhaustive evidence provenance;
- adaptive context thresholds;
- Pi-estimate vs local-fallback telemetry;
- bounded recovery storage;
- macOS + Linux CI;
- isolated-Pi smoke infrastructure.

The standalone/root LCM design remains strong.

However, the current LCM ↔ safe-agent-team integration still has **two release-blocking P0 contract defects** and one high-severity embedded-recoverability defect:

1. LCM passes `getSessionFile()` as the safe-agent fabric provider's `sessionId`; safe-agent scopes on `getSessionId()`. This can make every integrated fabric query appear uncertain.
2. LCM implements an older, permissive `FabricStateSnapshotV1` shape, drops the current V1 safety fields, and sanitizes malformed snapshots in a fail-open direction.
3. Embedded child output reduction can discard the authoritative full output when recovery-copy creation fails, unlike the root LCM path.

I would fix those before describing v0.4.1 as fully integrated with the current safe-agent-team.

---

# What was fixed well

## Embedded child context policy

`src/embedded/controller.ts` successfully separates child-safe context policy from the root Pi extension.

Managed-child mode disables root-only checkpoint/handoff behavior while retaining:

- adaptive threshold policy;
- token telemetry;
- output reduction;
- threshold compaction;
- evidence provenance.

This is the right architecture. Safe-agent-team can keep `noExtensions: true`.

## Evidence provenance

Reduced output now explicitly says it is non-complete and identifies the classes of conclusions that require re-opening authoritative output:

- ordering;
- absence;
- exact counts;
- exhaustive matches.

Compaction also retains one bounded evidence-completeness note when reduced evidence existed before compaction.

## Root output recoverability

The root `tool_result` path preserves the original result when a recovery copy cannot be created. This is the correct failure direction.

## Fabric-aware semantics

Automatic semantic reset recommendation and semantic compaction now defer while the fabric is active/non-quiescent, while ordinary threshold compaction remains independent. This preserves the important distinction:

```text
semantic boundary
  -> wait for coordination boundary

context pressure
  -> protect context even during delegated work
```

## Checkpoint reset UX

Normal `/checkpoint-reset` refuses to replace the Pi session when active/uncertain coordinated work is detected.

`--force` requires a second explicit UI confirmation warning that root session replacement cancels managed children.

That is materially safer than the earlier warn-and-proceed design.

## Recovery storage

Recovery storage is now bounded by count/bytes, uses restrictive permissions where supported, and cleans on root session shutdown.

## Testing direction

The repository now contains substantial fabric-aware, embedded-context, evidence, telemetry, output-reduction, and isolated-Pi test coverage. The previous audit's lack of integration-focused tests has been substantially addressed.

---

# P0 findings

## P0.1 — Wrong identifier is passed as `FabricSnapshotRequest.sessionId`

### Current LCM behavior

In multiple fabric queries, LCM does effectively:

```ts
const sessionFile = context.sessionManager.getSessionFile();

queryFabricState({
  cwd: context.cwd,
  sessionId: sessionFile,
});
```

`runCheckpointReset()` likewise derives `parentSession` from `getSessionFile()` and passes that value as `sessionId`.

### Current safe-agent contract

safe-agent-team registers its root using:

```ts
ctx.sessionManager.getSessionId()
```

and scopes interop requests with:

```ts
if (request.sessionId && rootSessionId && request.sessionId !== rootSessionId) {
  return null;
}
```

A session file path and a Pi session ID are different identities.

### Failure mode

In an ordinary persisted session:

```text
LCM request.sessionId
  = /.../sessions/<something>.jsonl

safe-agent rootSessionId
  = actual Pi session ID

mismatch
  -> provider returns null
  -> LCM query returns undefined
  -> provider exists, therefore LCM treats fabric as uncertain
```

Consequences can include:

- `/checkpoint-reset` blocked unless `--force`, even when fabric is actually quiescent;
- semantic compaction repeatedly deferred;
- semantic reset recommendation repeatedly deferred;
- context diagnostics reporting the fabric incorrectly;
- users learning to use `--force` as a normal workflow, weakening the safety design.

### Required fix

Use the exact session ID:

```ts
const sessionId = context.sessionManager.getSessionId();
```

Use `getSessionFile()` only where Pi actually expects a session-file lineage pointer, such as `newSession({ parentSession })`.

Centralize this in one helper so all fabric queries use identical scope semantics.

### Required regression test

Use a strict fake provider:

```ts
getSnapshot(req) {
  if (req.sessionId !== "session-id-123") return null;
  return quiescentSnapshot;
}
```

and a context where:

```ts
getSessionId()   -> "session-id-123"
getSessionFile() -> "/tmp/session-id-123.jsonl"
```

Verify reset/semantic behavior uses the ID, not the path.

---

## P0.2 — LCM's fabric V1 schema is stale and sanitization can fail open

### Current LCM type

LCM currently models roughly:

```ts
interface FabricStateSnapshotV1 {
  active: boolean;
  quiescent: boolean;
  runningChildren: number;
  unresolvedChildTasks: number;
  mutableHolds: number;
  pendingRootRequests: number;
  pendingRootDeliveries: number;
  activeTasks?: ...;
  mutableResources?: ...;
  timestamp?: number;
}
```

### Current safe-agent V1 contract

The provider currently returns:

```ts
interface FabricStateSnapshotV1 {
  version: 1;
  active: boolean;
  quiescent: boolean;
  state: "known" | "uncertain";
  sessionReplacementSafe: boolean;
  capturedAt: number;
  rootSessionId?: string;
  cwd?: string;

  runningChildren: number;
  unresolvedChildTasks: number;
  mutableHolds: number;
  activeWriteFences: number;
  pendingRootRequests: number;
  pendingRootDeliveries: number;

  activeTasks: ...[];
  mutableResources: ...[];
  quiescenceReasons: string[];
}
```

LCM discards the fields that most explicitly describe whether session replacement is safe.

### Fail-open sanitizer behavior

`sanitizeFabricSnapshot({})` currently becomes approximately:

```text
active = false
quiescent = true
all counters = 0
```

because missing values are coerced rather than rejected.

If a registered provider returns a malformed/incompatible object, LCM can interpret it as an inactive/safe fabric instead of uncertainty.

For a context manager that may replace the root Pi session, malformed interop data must fail closed.

### Required fix

Implement the exact current V1 contract and validate it structurally.

At minimum require:

```text
version === 1
typeof active === boolean
typeof quiescent === boolean
state is known|uncertain
typeof sessionReplacementSafe === boolean
valid capturedAt
valid counters
```

A malformed V1 provider response should produce an explicit:

```text
provider present + snapshot uncertain/invalid
```

state, never an inactive/quiescent snapshot.

### Reset policy

Use:

```text
snapshot.sessionReplacementSafe
```

as the authoritative session-replacement decision.

Do not re-derive destructive-reset safety independently from:

```text
active && quiescent
```

Even though those currently coincide in safe-agent-team, the explicit field is the protocol contract.

### Metadata

Preserve:

- `state`;
- `capturedAt`;
- `activeWriteFences`;
- `quiescenceReasons`;
- optionally `rootSessionId` and scoped `cwd`.

These are especially valuable in forced checkpoint archives.

---

## P0.3 — Embedded output reduction can lose authoritative output if recovery storage fails

### Root path

The root LCM correctly does:

```text
reduction wanted
full output path unavailable
recovery copy creation fails
  -> preserve original tool result
```

### Embedded path

`EmbeddedContextController.transformToolResult()` currently:

1. reduces the output;
2. records evidence reduction;
3. tries to obtain/save full output;
4. if saving fails, emits a diagnostic;
5. still returns the reduced result.

This can leave the child with:

```text
"This is a non-complete excerpt..."
```

but no recoverable full output.

### Why this matters

This violates the embedded API's own intended invariant and can destroy information needed for:

- exact failure diagnosis;
- chronological race analysis;
- exhaustive search results;
- counts/absence claims.

### Required fix

Match the root semantics exactly:

```text
if reduction changed:
  resolve authoritative full-output path
  if none:
    attempt recovery save

  if recovery still unavailable:
    return original result
    do not record a successful reduction

  otherwise:
    record reduction
    return reduced result + recovery pointer
```

Add a test that injects a failing recovery store and asserts byte-for-byte preservation of the original content.

---

# P1 findings

## P1.1 — `agent_settled` fabric query is extension-order/race sensitive

LCM queries fabric quiescence inside its `agent_settled` handler.

safe-agent-team marks its broker root ready from its own `agent_settled` callback through an asynchronous lifecycle queue.

Therefore LCM can observe:

```text
Pi: agent_settled
safe-agent broker: root still "running"
```

especially when LCM's handler runs before safe-agent's completion update.

The safe-agent provider correctly reports:

```text
quiescent = false
quiescenceReasons includes root_agent_active_or_running
```

but this can be a transient projection lag rather than actual delegated work.

### Recommendation

After aligning to the full V1 snapshot, make semantic evaluation independent of extension load order.

Good options:

1. defer the fabric query to a guarded post-settlement boundary;
2. re-check once after all `agent_settled` handlers have had a chance to publish state;
3. for non-destructive semantic compaction only, recognize a snapshot whose **only** reason is transient root-active state while Pi itself has emitted `agent_settled`.

Do not weaken `/checkpoint-reset`; destructive session replacement should still require `sessionReplacementSafe === true`.

---

## P1.2 — Recovery storage is global across root and all embedded children

`saveRecoveryCopy()` uses one module-global `activeRecoveryStorage`.

That means:

```text
root LCM
child A embedded LCM
child B embedded LCM
...
```

all share the same:

- recovery directory;
- 50-file quota;
- 50 MB quota;
- prune order.

### Failure mode

A noisy child can create enough large outputs to prune an authoritative recovery file that belongs to:

- the root;
- another worker;
- an earlier but still relevant tool result.

A finished child also leaves its files consuming the global quota until root shutdown.

### Recommendation

Make recovery storage context-owned:

```text
root session -> one recovery store
each embedded manager -> one recovery store
```

`EmbeddedContextController.dispose()` should clean its own recovery directory.

The root session should retain its existing shutdown cleanup.

This eliminates cross-agent recovery interference while retaining bounded storage.

---

## P1.3 — Forced reset under provider-query failure is not durably marked as uncertain

When a fabric provider is registered but its query fails:

```text
isFabricUncertain = true
fabricState = undefined
```

`--force` correctly requires confirmation.

But `CheckpointResetInput` then has:

```text
forced = true
fabricState absent
```

and the durable metadata only emits forced-coordination warnings inside the `if (input.fabricState)` branch.

So the checkpoint can omit the fact that it was force-created while fabric state was unknown.

### Required fix

Represent provider-query failure explicitly, for example:

```ts
fabricObservation:
  | { kind: "absent" }
  | { kind: "known"; snapshot: FabricStateSnapshotV1 }
  | { kind: "uncertain"; reason: string };
```

Then forced checkpoint metadata can always record whether safety state was unknown.

With the full safe-agent V1 contract, provider-returned `state: "uncertain"` and `quiescenceReasons` should also be preserved.

---

## P1.4 — Isolated smoke tests contain user-machine absolute paths

`test/smoke-isolated-pi.test.ts` hard-codes paths such as:

```text
/Users/saehwan/repos/pi-safe-agent-team/index.ts
/Users/saehwan/.pi/agent/npm/node_modules/...
```

This conflicts with the stated Codex CLI / Antigravity CLI workflow and with Fedora development.

### Failure modes

- Fedora with Pi installed: safe-agent scenarios fail because the macOS path does not exist.
- Another macOS checkout: same problem.
- CI usually skips the test because Pi is absent, so the portability flaw can remain hidden.

### Fix

Use explicit environment/sibling discovery:

```text
SAFE_AGENT_DIR
MONO_GUARD_ENTRYPOINT
PI_GOAL_ENTRYPOINT
```

For a required joint smoke:

- fail clearly if the companion path is missing.

For optional ecosystem smoke:

- mark it explicitly skipped with a reason.

Do not encode a developer home directory in repository tests.

Also use a separate disposable `PI_CODING_AGENT_DIR` per scenario.

---

## P1.5 — Context diagnostics can label an uncertain query as "inactive"

`reportContextStats()` effectively does:

```ts
const snap = await queryFabricState(...);
fabricStatus = snap?.active ? "active" : "inactive";
```

If the provider exists but `queryFabricState()` returns `undefined`, the status becomes `"inactive"` rather than `"uncertain"`/`"unavailable"`.

This will be particularly visible because of the current session-ID mismatch.

### Fix

Expose at least:

```text
unavailable
inactive
active/quiescent
active/busy
uncertain
```

Prefer the provider's `state` and `quiescenceReasons`.

---

# P2 findings

## P2.1 — Embedded provider is registered twice with different object identities

`src/index.ts` registers the provider once at module scope and again inside the default extension factory, each time creating a new object.

The first succeeds; the second conflicts and returns `false`, which is ignored.

It works accidentally because the first provider remains in the global registry.

### Recommendation

Use one stable provider instance:

```ts
const embeddedProvider = {
  version: 1,
  createEmbeddedContextManager,
};
```

Register it exactly once per intended lifecycle.

Also decide and document whether the provider:

- intentionally persists for the Pi process lifetime; or
- is registered/unregistered with extension session lifecycle.

Avoid silent duplicate registration.

---

## P2.2 — Post-compaction token source has a null/undefined bug

Current logic is effectively:

```ts
const tokenSource =
  usage?.tokens !== null
    ? "pi-estimate"
    : "local-fallback";
```

If `usage` is `undefined`:

```text
undefined !== null
  -> true
```

so the code labels the local fallback estimate as `pi-estimate`.

### Fix

Use:

```ts
usage?.tokens != null
```

or the same explicit validity test used elsewhere.

Add a regression where `getContextUsage()` returns `undefined`.

---

## P2.3 — Embedded compaction type still exposes unsupported `targetTokens`

The current cross-project host ultimately maps to:

```ts
AgentSession.compact(customInstructions?: string)
```

LCM no longer needs:

```ts
targetTokens?: number;
```

in `EmbeddedCompactionRequest`.

It is currently unused, but keeping unsupported protocol fields encourages future callers to believe the host honors them.

Remove it unless Pi gains a real target-token compaction API.

---

## P2.4 — Full fabric metadata should include pending deliveries and fences

Current checkpoint coordination formatting includes:

- running children;
- unresolved tasks;
- mutable holds;
- pending root requests.

It does not include the current V1 fields:

- active write fences;
- pending root deliveries;
- quiescence reasons;
- known/uncertain state.

Those can be exactly why a forced reset was unsafe.

Once the schema is aligned, preserve them in bounded metadata.

---

# Test gaps that explain the P0 misses

The new test suite is broad, but its fake providers are permissive.

In particular, current fabric-aware tests generally return a snapshot regardless of the request's `sessionId`, so they do not detect the `getSessionFile()` vs `getSessionId()` mismatch.

Add one small **cross-project contract fixture** that uses the exact safe-agent V1 request/response shape rather than a generic mock.

Recommended invariant tests:

- [ ] `getSessionId()` is supplied to fabric provider.
- [ ] `getSessionFile()` is never supplied as `FabricSnapshotRequest.sessionId`.
- [ ] malformed provider object -> uncertain/fail-closed.
- [ ] wrong `version` -> uncertain/fail-closed.
- [ ] `state: uncertain` -> reset blocked.
- [ ] `sessionReplacementSafe: false` -> reset blocked even if other counters look zero.
- [ ] `activeWriteFences > 0` survives sanitization/metadata.
- [ ] provider-query failure + forced reset is durably marked uncertain.
- [ ] embedded recovery-save failure returns original result.
- [ ] concurrent embedded managers cannot prune each other's recovery copies.
- [ ] semantic settled query is not permanently sensitive to extension load order.
- [ ] smoke test contains no developer-specific absolute path.

---

# Suggested fix order

- [ ] **P0:** replace fabric-query `getSessionFile()` with `getSessionId()`.
- [ ] **P0:** adopt the exact current safe-agent `FabricStateSnapshotV1`.
- [ ] **P0:** validate provider snapshots fail-closed and gate resets on `sessionReplacementSafe`.
- [ ] **P0:** preserve original embedded tool output when recovery cannot be established.
- [ ] Fix post-`agent_settled` ordering/race sensitivity.
- [ ] Give each embedded manager its own recovery store.
- [ ] Persist forced-reset uncertainty even when no usable snapshot exists.
- [ ] Fix diagnostics so undefined/uncertain is not shown as inactive.
- [ ] Remove hard-coded smoke-test paths.
- [ ] Consolidate provider registration into one stable instance/lifecycle.
- [ ] Fix post-compaction token-source null/undefined test.
- [ ] Remove unsupported `targetTokens`.
- [ ] Expand checkpoint coordination metadata to current V1 fields.

---

# Release assessment

## Standalone LCM

**Strong.**

The context lifecycle, compaction safeguards, evidence handling, user-reviewed checkpoint flow, adaptive defaults, and recovery design are materially improved.

## Embedded LCM in safe-agent children

**Architecturally correct, but not yet fully safe.**

The missing fail-safe recovery behavior should be fixed before relying on reduced child outputs during long-running/debug-heavy tasks.

## LCM + current `pi-safe-agent-team`

**Not yet ready to call frictionless.**

The session-ID mismatch alone can make the safe fabric appear uncertain during ordinary use, and the stale/fail-open V1 sanitizer is too weak for a protocol controlling destructive root-session replacement.

After the four top fixes:

1. correct session ID;
2. exact fail-closed V1 contract;
3. `sessionReplacementSafe` gating;
4. embedded recovery preservation;

I would consider the architecture fundamentally sound and move the remaining items into normal hardening rather than redesign.
