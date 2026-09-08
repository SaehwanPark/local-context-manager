I re-audited both current `main` branches after the second round of fixes.

The result is materially better: **the previous P0 integration blockers are resolved, and I do not see a new P0 that requires redesign.** Both implementation commits also passed their GitHub Actions CI runs. The remaining issues are mostly P1 hardening, with one notable structural issue in safe-agent-team.

| Project | Current HEAD | Assessment |
|---|---|---|
| `local-context-manager` | `5377b743…` / v0.4.2 | **Strong; previous P0s fixed** |
| `pi-safe-agent-team` | `cff14f2f…` | **Strong; previous P1/P2 fixes landed** |
| Joint architecture | — | **Fundamentally sound; a few P1s remain** |

## `local-context-manager`: this repository

The second-round fixes are real rather than just documented.

LCM now cleanly separates `getSessionId()` for fabric identity from `getSessionFile()` for parent-session lineage. Its interop layer implements the current safe-agent V1 fields, validates malformed snapshots fail-closed, represents provider failures through `FabricObservation`, and uses `sessionReplacementSafe` for destructive reset decisions.  `/checkpoint-reset` now uses exactly this separation and refuses unsafe/uncertain replacement unless explicitly forced. 

Embedded recovery is also fixed properly. Each embedded controller owns a separate `SessionRecoveryStorage`, and reduction now returns the original tool output rather than a lossy excerpt if an authoritative recovery copy cannot be established. 

So the three prior P0s—session identity, fail-open fabric parsing, and unrecoverable embedded reduction—are **closed**.

### Remaining LCM P1: semantic quiescence logic duplicates only part of the provider contract

The current `agent_settled` code manually determines `hasActiveChildWork` from:

```text
runningChildren
unresolvedChildTasks
mutableHolds
activeWriteFences
pendingRootDeliveries
```

but notably omits `pendingRootRequests`. It then decides whether semantic compaction/reset recommendation should defer from this manually maintained subset. 

That creates a contract-maintenance problem. Safe-agent-team explicitly considers `pendingRootRequests > 0` non-quiescent, as well as any future quiescence reason it may add. 

For example, a child without a primary task could send a decision/clarification request to root:

```text
runningChildren       = 0
unresolvedChildTasks  = 0
mutableHolds          = 0
activeWriteFences     = 0
pendingRootDeliveries = 0
pendingRootRequests   = 1

safe-agent:
  quiescent = false

LCM current derived state:
  hasActiveChildWork = false
  deferFabricWork = false
```

The destructive `/checkpoint-reset` command remains safe because it correctly uses `sessionReplacementSafe`; the flaw concerns **automatic semantic operations**.

I would simplify it to:

```ts
const isRootOnlyLag =
  observation.kind === "known" &&
  observation.snapshot.active &&
  !observation.snapshot.quiescent &&
  observation.snapshot.quiescenceReasons?.length === 1 &&
  observation.snapshot.quiescenceReasons[0] ===
    "root_agent_active_or_running";

const deferFabricWork =
  observation.kind === "uncertain" ||
  (
    observation.kind === "known" &&
    observation.snapshot.active &&
    !observation.snapshot.quiescent &&
    !isRootOnlyLag
  );
```

In other words: **trust safe-agent's `quiescent` projection rather than reproducing its definition inside LCM**, with only the narrowly justified root-settlement-lag exception.

That would also automatically handle future additions to safe-agent quiescence.

### Cross-project P1: embedded recovery files disappear when safe-agent degrades to native

This is an interesting interaction between two individually sensible fixes.

LCM's embedded controller now owns its own recovery directory, and `dispose()` cleans that directory. 

safe-agent-team now correctly disposes the embedded manager when an LCM callback fails and it degrades the still-running child to native context mode. 

Suppose earlier tool output was reduced:

```text
child context
  "Full output saved to:
   /tmp/pi-lcm-recovery-XYZ/output-4-bash.txt"
```

Then later LCM experiences an unrelated embedded error:

```text
degradeToNativeContext()
  -> embeddedManager.dispose()
  -> LCM deletes /tmp/pi-lcm-recovery-XYZ/
  -> child continues running in native mode
```

The retained conversation now contains dead recovery references.

I would change the lifecycle API rather than give up per-child storage. For example:

```ts
manager.deactivate();   // stop LCM behavior; retain recovery data

// when child truly ends:
manager.dispose();      // final cleanup
```

Or otherwise separate policy shutdown from recovery-storage cleanup.

This is the most important **joint** issue I found in this pass.

---

# `pi-safe-agent-team` : located and approved to access via `../pi-safe-agent-team/`

The previous second-round issues are also genuinely fixed.

The root shell guard now sees actual fence records and checks path overlap, including the case where a lease expires but an in-flight fence survives. It fails closed when active fences exist but detailed fence paths are unavailable.   

Case-sensitivity detection is cached rather than repeatedly creating `.pi-case-*` files, and the broker synchronizes that policy into coordinator configuration.  

Wrapper-aware shell classification now recognizes common forms such as `npx`, `pnpm exec`, `uv run`, `poetry run`, and `python -m`, while unknown commands remain explicitly part of the trusted-root escape hatch. 

Embedded-manager degradation now disposes/clears the manager and preserves `contextMode` across broker reconnects. 

So the previous safe-agent P1/P2 list is mostly closed.

## New/now-confirmed P1: two simultaneous Pi roots in the same repository can alias one fabric

This is the largest remaining safe-agent concern.

Default fabric identity is still derived entirely from `cwd`:

```text
fabricId
  = hash(cwd)

stateDirectory
  = <agentDir>/safe-agents/hash(cwd)

broker endpoint
  = derived from that stateDirectory
```



Now consider opening **two Pi sessions simultaneously in the same repository**, using the same normal `PI_CODING_AGENT_DIR`.

The second `FabricRuntime` finds the same state directory and endpoint. If it cannot start another broker, `ensureBroker()` deliberately connects to the existing one and loads the same persisted root token. 

The coordinator treats registration of an existing agent with the reconnect credential as a legitimate reconnect and updates its session information.  

Meanwhile the broker authentication layer does not appear to enforce **one live connection per actor identity**; multiple authenticated connections can coexist and visible events are broadcast to matching connections. 

So:

```text
Pi process A ─┐
              ├─ same cwd
Pi process B ─┘
       ↓
same fabric hash
same broker
same root actor ID
same reconnect credential
```

This can potentially lead to:

- one session overwriting the root's registered `sessionId`;
- both processes seeing fabric events;
- duplicate/competing message delivery;
- competing `agent.begin_turn` / `agent.end_turn`;
- one root affecting the other's child/task state.

This concern was previously somewhat speculative; after tracing broker registration and connection handling, I think it is **real enough to fix**.

### Preferred design

Scope implicit fabric identity by **repository + Pi session ID**:

```text
safe-agents/
  <repo-hash>/
    <session-hash>/
```

Conceptually:

```ts
fabricId = hash(
  canonicalWorkspace +
  "\0" +
  rootPiSessionId
);
```

This has a useful semantic match:

- same Pi session resumed/reconnected → same fabric;
- separate concurrent Pi session in same repo → separate fabric;
- checkpoint reset/new session → new fabric;
- explicit `options.fabricId` can remain an advanced override when intentional sharing is desired.

Because the session ID is not known in the constructor today, default fabric identity would preferably become lazily finalized at root attachment.

This is the one remaining issue I would classify as **structural P1**, rather than routine polishing.

---

## Testing gap: `smoke:pi:integration` still is not a managed-child integration test

The safe-agent smoke script is much more portable now and the explicit `with-lcm` mode correctly fails if the companion checkout is missing. 

But the `integration` mode currently does essentially:

```bash
pi \
  --no-extensions \
  -e safe-agent-team \
  --model "$PI_SMOKE_MODEL" \
  -p "echo 'pi-safe-agent-team smoke test'"
```

It neither loads LCM nor instructs Pi to spawn a child. 

So it verifies a model-backed root session, not:

```text
root
  -> safe-agent fabric
  -> ManagedChild
  -> noExtensions:true
  -> discovers LCM embedded provider
  -> context=lcm-embedded
  -> completes task
```

For your Codex/Antigravity testing workflow, I would add a true opt-in joint integration smoke that:

1. provisions opaque auth/model files into disposable `PI_CODING_AGENT_DIR`;
2. explicitly loads both repositories;
3. asks root to spawn one trivial worker;
4. verifies the child becomes `lcm-embedded`;
5. waits for task completion;
6. checks quiescence;
7. confirms no test state appeared under normal `~/.pi/agent`.

The existing credential-free load smokes should remain because they are fast and useful.

One smaller point: the canonical-agent-directory test now asserts that *constructed child/auth/model paths* fall under the temporary directory, but it still does not actually instantiate a managed child.  That's a P2 test-strength issue, not a runtime defect.

---

## A couple of P2 cleanups

LCM's V1 sanitizer is now safely strict on the important fields, but counter validation accepts any finite non-negative number and then floors it. Requiring `Number.isSafeInteger()` would make protocol validation more literal. It could also reject inconsistent `known` snapshots such as `sessionReplacementSafe=true` with contradictory quiescence state. 

Also, safe-agent's embedded host still maps:

```ts
const instructions =
  request.customInstructions ?? request.reason;

await session.compact(instructions);
```



For an ordinary LCM threshold compaction this may send the literal word `"threshold"` as Pi's custom compaction instructions. `reason` is better treated as diagnostic metadata; Pi should receive `request.customInstructions` only unless the reason itself is deliberately written as an instruction.

Neither warrants delaying normal use.

---

# Where I think the projects now stand

The trajectory over the last rounds is good:

```text
Round 1:
  architecture established
  several real integration hazards

Round 2:
  core contracts implemented
  P0 interoperability defects found

Current:
  P0s resolved
  architecture coherent
  remaining work mostly lifecycle/concurrency hardening
```

My current assessment would be:

| Dimension | Assessment |
|---|---|
| LCM standalone | **Very strong** |
| LCM embedded child policy | **Strong** |
| Safe-agent borrowing/fencing | **Strong** |
| LCM ↔ safe-agent protocol | **Strong; no P0 remaining** |
| Context/reset safety | **Strong** |
| Root shell safety | **Appropriately best-effort and much improved** |
| Concurrent root sessions | **Needs P1 fix** |
| Recovery lifetime across embedded degradation | **Needs P1 fix** |
| Codex/Antigravity isolated testing | **Good load testing; true child E2E still missing** |

So I would **not do another architectural redesign**. The two extensions now fit together in the intended way. I would make three more focused changes before considering this integration phase essentially complete:

1. make LCM semantic deferral rely directly on safe-agent `quiescent`, except the explicit root-only settlement-lag case;
2. preserve embedded recovery files across LCM→native degradation until the child itself terminates;
3. session-scope safe-agent's default fabric identity so concurrent Pi roots in the same repo cannot alias each other.

After those, I think the remaining concerns fall comfortably into ordinary incremental hardening rather than integration correctness.
