import { createEmbeddedContextManager } from "./controller.js";
import type { EmbeddedContextHost, EmbeddedContextManager, EmbeddedContextManagerOptions } from "./types.js";

export const PI_EXTENSION_INTEROP = Symbol.for("pi.extension-interop.v1");

export interface PiExtensionInteropRegistryV1 {
  version: 1;
  providers: Map<string, unknown>;
}

export const LCM_EMBEDDED_CONTEXT_PROVIDER_NAME = "local-context-manager.embedded-context.v1";
export const SAFE_AGENT_FABRIC_PROVIDER_NAME = "safe-agent-team.fabric-state.v1";

export interface FabricSnapshotRequest {
  cwd: string;
  sessionId?: string;
  /**
   * Optional cancellation for the provider call. Providers that support it can
   * stop broker work early; LCM bounds the wait either way.
   */
  signal?: AbortSignal;
}

export interface FabricTaskSnapshot {
  id: string;
  status: string;
  owner?: string;
  description?: string;
}

export interface FabricResourceSnapshot {
  id: string;
  path?: string;
  holder?: string;
}

export interface FabricStateSnapshotV1 {
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

  activeTasks?: FabricTaskSnapshot[];
  mutableResources?: FabricResourceSnapshot[];
  quiescenceReasons?: string[];
  timestamp?: number;
}

export interface FabricStateProviderV1 {
  getSnapshot?(request: FabricSnapshotRequest): FabricStateSnapshotV1 | Promise<FabricStateSnapshotV1 | null>;
}

export type FabricStateProviderFunction = (
  request: FabricSnapshotRequest,
) => FabricStateSnapshotV1 | Promise<FabricStateSnapshotV1 | null>;

export type FabricObservation =
  | { kind: "absent" }
  | { kind: "known"; snapshot: FabricStateSnapshotV1 }
  | { kind: "uncertain"; reason: string; snapshot?: FabricStateSnapshotV1 };

export function resolveSessionId(sessionManager: unknown): string | undefined {
  if (!sessionManager || typeof sessionManager !== "object") {
    return undefined;
  }
  const mgr = sessionManager as { getSessionId?: () => unknown; sessionId?: unknown };
  if (typeof mgr.getSessionId === "function") {
    try {
      const id = mgr.getSessionId();
      if (typeof id === "string" && id.trim()) {
        return id.trim();
      }
    } catch {
      // Ignore accessor failure
    }
  }
  if (typeof mgr.sessionId === "string" && mgr.sessionId.trim()) {
    return mgr.sessionId.trim();
  }
  return undefined;
}

export function resolveSessionFile(sessionManager: unknown): string | undefined {
  if (!sessionManager || typeof sessionManager !== "object") {
    return undefined;
  }
  const mgr = sessionManager as { getSessionFile?: () => unknown; sessionFile?: unknown };
  if (typeof mgr.getSessionFile === "function") {
    try {
      const file = mgr.getSessionFile();
      if (typeof file === "string" && file.trim()) {
        return file.trim();
      }
    } catch {
      // Ignore accessor failure
    }
  }
  if (typeof mgr.sessionFile === "string" && mgr.sessionFile.trim()) {
    return mgr.sessionFile.trim();
  }
  return undefined;
}

interface RegistryView {
  registry: PiExtensionInteropRegistryV1;
  /** False when the published registry belongs to a peer protocol LCM does not understand. */
  shared: boolean;
  publishedVersion: number | null;
}

// Handed out when a foreign registry occupies the shared symbol, so LCM keeps
// working inside its own module graph without destroying the peer's state.
let privateRegistry: PiExtensionInteropRegistryV1 | undefined;

function createRegistry(): PiExtensionInteropRegistryV1 {
  return { version: 1, providers: new Map<string, unknown>() };
}

function registryView(): RegistryView {
  const globalObj = globalThis as unknown as Record<symbol, unknown>;
  const published = globalObj[PI_EXTENSION_INTEROP];

  if (published === undefined || published === null) {
    const registry = createRegistry();
    globalObj[PI_EXTENSION_INTEROP] = registry;
    return { registry, shared: true, publishedVersion: 1 };
  }

  const record =
    typeof published === "object" && published !== null
      ? (published as { version?: unknown; providers?: unknown })
      : undefined;
  const version =
    typeof record?.version === "number" && Number.isFinite(record.version) ? record.version : null;

  if (version !== null && version !== 1) {
    // A well-formed foreign registry is another extension's object. Replacing it
    // would leave both extensions holding private, diverging registries, and the
    // resulting "absent" answer would read as "nothing to protect" on the
    // destructive path. Keep it and fail closed instead.
    privateRegistry ??= createRegistry();
    return { registry: privateRegistry, shared: false, publishedVersion: version };
  }

  if (version === 1 && record?.providers instanceof Map) {
    return {
      registry: published as PiExtensionInteropRegistryV1,
      shared: true,
      publishedVersion: 1,
    };
  }

  // Unversioned or malformed: there is no peer state worth preserving.
  const registry = createRegistry();
  globalObj[PI_EXTENSION_INTEROP] = registry;
  return { registry, shared: true, publishedVersion: 1 };
}

export function getInteropRegistry(): PiExtensionInteropRegistryV1 {
  return registryView().registry;
}

/**
 * Whether LCM's provider table is the one peers can see, plus the version it
 * found. Reported by `/context-stats` so a silent protocol mismatch is diagnosable.
 */
export function getInteropStatus(): { publishedVersion: number | null; shared: boolean } {
  const view = registryView();
  return { publishedVersion: view.publishedVersion, shared: view.shared };
}

export function registerInteropProvider(name: string, provider: unknown): boolean {
  if (!name || provider === undefined || provider === null) {
    return false;
  }
  const view = registryView();
  const existing = view.registry.providers.get(name);
  if (existing !== undefined && existing !== provider) {
    // Incompatible duplicate provider detected
    return false;
  }
  view.registry.providers.set(name, provider);
  // Registration is recorded locally, but a foreign registry means no peer can
  // observe it, which callers must report rather than assume succeeded.
  return view.shared;
}

export function registerEmbeddedContextManagerProvider(
  factory: (host: EmbeddedContextHost, options?: EmbeddedContextManagerOptions) => EmbeddedContextManager = createEmbeddedContextManager,
): boolean {
  return registerInteropProvider(LCM_EMBEDDED_CONTEXT_PROVIDER_NAME, {
    createEmbeddedContextManager: factory,
  });
}

export function unregisterInteropProvider(name: string, provider?: unknown): boolean {
  const registry = getInteropRegistry();
  if (provider !== undefined) {
    if (registry.providers.get(name) === provider) {
      return registry.providers.delete(name);
    }
    return false;
  }
  return registry.providers.delete(name);
}

export function getInteropProvider<T>(name: string): T | undefined {
  const registry = getInteropRegistry();
  return registry.providers.get(name) as T | undefined;
}

function clampString(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function isValidCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function sanitizeFabricSnapshot(raw: unknown): FabricStateSnapshotV1 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  // Fail closed if version is not 1
  if (record.version !== 1) {
    return undefined;
  }

  // Active and quiescent must be explicit booleans
  if (typeof record.active !== "boolean" || typeof record.quiescent !== "boolean") {
    return undefined;
  }

  // State must be known or uncertain
  if (record.state !== "known" && record.state !== "uncertain") {
    return undefined;
  }

  // sessionReplacementSafe must be explicit boolean
  if (typeof record.sessionReplacementSafe !== "boolean") {
    return undefined;
  }

  // A known active fabric cannot claim that session replacement is safe while
  // simultaneously reporting non-quiescence. Treat contradictory snapshots as
  // malformed rather than allowing a destructive caller to infer safety.
  if (record.state === "known" && record.active && !record.quiescent && record.sessionReplacementSafe) {
    return undefined;
  }

  // capturedAt or legacy timestamp alias must be positive finite number
  const capturedAtRaw = record.capturedAt ?? record.timestamp;
  if (typeof capturedAtRaw !== "number" || !Number.isFinite(capturedAtRaw) || capturedAtRaw <= 0) {
    return undefined;
  }
  const capturedAt = capturedAtRaw;

  // Validate all required counters fail-closed
  if (
    !isValidCounter(record.runningChildren) ||
    !isValidCounter(record.unresolvedChildTasks) ||
    !isValidCounter(record.mutableHolds) ||
    !isValidCounter(record.activeWriteFences) ||
    !isValidCounter(record.pendingRootRequests) ||
    !isValidCounter(record.pendingRootDeliveries)
  ) {
    return undefined;
  }

  const runningChildren = Math.floor(record.runningChildren);
  const unresolvedChildTasks = Math.floor(record.unresolvedChildTasks);
  const mutableHolds = Math.floor(record.mutableHolds);
  const activeWriteFences = Math.floor(record.activeWriteFences);
  const pendingRootRequests = Math.floor(record.pendingRootRequests);
  const pendingRootDeliveries = Math.floor(record.pendingRootDeliveries);

  let quiescenceReasons: string[] = [];
  if (record.quiescenceReasons !== undefined) {
    if (!Array.isArray(record.quiescenceReasons)) {
      return undefined;
    }
    quiescenceReasons = record.quiescenceReasons
      .filter((item): item is string => typeof item === "string")
      .map((s) => clampString(s, 120) ?? "")
      .filter(Boolean);
  }

  let activeTasks: FabricTaskSnapshot[] | undefined;
  if (record.activeTasks !== undefined) {
    if (!Array.isArray(record.activeTasks)) {
      return undefined;
    }
    activeTasks = [];
    for (const item of record.activeTasks.slice(0, 50)) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const taskRecord = item as Record<string, unknown>;
        const id = clampString(taskRecord.id, 64) ?? "unknown";
        const status = clampString(taskRecord.status, 32) ?? "active";
        const owner = clampString(taskRecord.owner, 64);
        const description = clampString(taskRecord.description, 120);
        const task: FabricTaskSnapshot = { id, status };
        if (owner !== undefined) task.owner = owner;
        if (description !== undefined) task.description = description;
        activeTasks.push(task);
      }
    }
  }

  let mutableResources: FabricResourceSnapshot[] | undefined;
  if (record.mutableResources !== undefined) {
    if (!Array.isArray(record.mutableResources)) {
      return undefined;
    }
    mutableResources = [];
    for (const item of record.mutableResources.slice(0, 50)) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const resRecord = item as Record<string, unknown>;
        const id = clampString(resRecord.id, 64) ?? "unknown";
        const path = clampString(resRecord.path, 120);
        const holder = clampString(resRecord.holder, 64);
        const res: FabricResourceSnapshot = { id };
        if (path !== undefined) res.path = path;
        if (holder !== undefined) res.holder = holder;
        mutableResources.push(res);
      }
    }
  }

  const rootSessionId = clampString(record.rootSessionId, 128);
  const cwd = clampString(record.cwd, 512);

  const result: FabricStateSnapshotV1 = {
    version: 1,
    active: record.active,
    quiescent: record.quiescent,
    state: record.state,
    sessionReplacementSafe: record.sessionReplacementSafe,
    capturedAt,
    runningChildren,
    unresolvedChildTasks,
    mutableHolds,
    activeWriteFences,
    pendingRootRequests,
    pendingRootDeliveries,
    quiescenceReasons,
    timestamp: capturedAt,
  };

  if (rootSessionId !== undefined) {
    result.rootSessionId = rootSessionId;
  }
  if (cwd !== undefined) {
    result.cwd = cwd;
  }
  if (activeTasks && activeTasks.length > 0) {
    result.activeTasks = activeTasks;
  }
  if (mutableResources && mutableResources.length > 0) {
    result.mutableResources = mutableResources;
  }

  return result;
}

export const FABRIC_QUERY_TIMEOUT_MS = 2_000;
// Deliberately generous. A peer may serve a cached projection, and a false
// "stale" only defers a recommendation, while trusting a projection that is
// actually old enough to have missed the whole child lifecycle would not.
export const FABRIC_SNAPSHOT_MAX_AGE_MS = 60_000;
export const FABRIC_SNAPSHOT_FUTURE_TOLERANCE_MS = 5_000;

export interface FabricQueryOptions {
  timeoutMs?: number;
  maxSnapshotAgeMs?: number;
  futureToleranceMs?: number;
  now?: () => number;
}

class FabricQueryTimeoutError extends Error {}

/**
 * Providers are other extensions' code and can hang; an unbounded await here
 * keeps the root session from becoming idle, which also stalls LCM's own
 * settled-boundary work. `catch` alone cannot help a promise that never settles.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${label} aborted`));
      return;
    }
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(new Error(`${label} aborted`)));
    const timer = setTimeout(
      () => settle(() => {
        onTimeout?.();
        reject(new FabricQueryTimeoutError(`${label} timed out after ${timeoutMs} ms`));
      }),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

export async function queryFabricObservation(
  request: FabricSnapshotRequest,
  options: FabricQueryOptions = {},
): Promise<FabricObservation> {
  const status = getInteropStatus();
  if (!status.shared) {
    return {
      kind: "uncertain",
      reason: `Extension interop registry v${status.publishedVersion} is not understood by local-context-manager, so fabric state cannot be verified`,
    };
  }

  const provider = getInteropProvider<FabricStateProviderV1 | FabricStateProviderFunction>(
    SAFE_AGENT_FABRIC_PROVIDER_NAME,
  );
  if (!provider) {
    return { kind: "absent" };
  }

  const callProvider: ((request: FabricSnapshotRequest) => unknown) | undefined =
    typeof (provider as FabricStateProviderV1).getSnapshot === "function"
      ? (request: FabricSnapshotRequest) => (provider as FabricStateProviderV1).getSnapshot!(request)
      : typeof provider === "function"
        ? (request: FabricSnapshotRequest) => (provider as FabricStateProviderFunction)(request)
        : undefined;
  if (!callProvider) {
    return { kind: "uncertain", reason: "Fabric provider has no callable getSnapshot method" };
  }

  const timeoutMs = options.timeoutMs ?? FABRIC_QUERY_TIMEOUT_MS;
  const abortController = new AbortController();
  const callerSignal = request.signal;
  if (callerSignal?.aborted) {
    abortController.abort(callerSignal.reason);
  } else if (callerSignal) {
    callerSignal.addEventListener("abort", () => abortController.abort(callerSignal.reason), { once: true });
  }

  const effectiveRequest: FabricSnapshotRequest = {
    ...request,
    signal: abortController.signal,
  };

  let rawSnapshot: unknown;
  try {
    rawSnapshot = await withTimeout(
      Promise.resolve(callProvider(effectiveRequest)),
      timeoutMs,
      "Fabric state query",
      abortController.signal,
      () => abortController.abort(new FabricQueryTimeoutError(`Fabric state query timed out after ${timeoutMs} ms`)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "uncertain",
      reason: error instanceof FabricQueryTimeoutError ? message : `Fabric query threw error: ${message}`,
    };
  }

  if (rawSnapshot === null || rawSnapshot === undefined) {
    return { kind: "uncertain", reason: "Fabric provider returned null or undefined snapshot" };
  }

  const snapshot = sanitizeFabricSnapshot(rawSnapshot);
  if (!snapshot) {
    return { kind: "uncertain", reason: "Fabric provider returned malformed or incompatible snapshot" };
  }

  if (snapshot.state === "uncertain") {
    const reason =
      snapshot.quiescenceReasons && snapshot.quiescenceReasons.length > 0
        ? snapshot.quiescenceReasons.join(", ")
        : "Fabric provider reported uncertain state";
    return { kind: "uncertain", reason, snapshot };
  }

  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxSnapshotAgeMs ?? FABRIC_SNAPSHOT_MAX_AGE_MS;
  const futureToleranceMs = options.futureToleranceMs ?? FABRIC_SNAPSHOT_FUTURE_TOLERANCE_MS;
  const ageMs = now - snapshot.capturedAt;
  if (ageMs < -futureToleranceMs) {
    return {
      kind: "uncertain",
      reason: `Fabric snapshot is dated ${Math.round(-ageMs / 1000)}s in the future`,
      snapshot,
    };
  }
  if (ageMs > maxAgeMs) {
    return {
      kind: "uncertain",
      reason: `Fabric snapshot is stale (captured ${Math.round(ageMs / 1000)}s ago; limit ${Math.round(maxAgeMs / 1000)}s)`,
      snapshot,
    };
  }
  // Only the destructive claim needs the identity match: a legitimate peer may
  // report the fabric root while a child session asks about quiescence.
  // For the destructive path, require presence AND equality whenever the caller supplied a session ID.
  if (snapshot.sessionReplacementSafe && request.sessionId) {
    if (!snapshot.rootSessionId) {
      return {
        kind: "uncertain",
        reason: `Fabric snapshot claims session replacement is safe but does not identify a rootSessionId to match ${JSON.stringify(request.sessionId)}`,
        snapshot,
      };
    }
    if (snapshot.rootSessionId !== request.sessionId) {
      return {
        kind: "uncertain",
        reason: `Fabric snapshot claims session replacement is safe but names root session ${JSON.stringify(snapshot.rootSessionId)}`,
        snapshot,
      };
    }
  }

  return { kind: "known", snapshot };
}

export async function queryFabricState(
  request: FabricSnapshotRequest,
  options: FabricQueryOptions = {},
): Promise<FabricStateSnapshotV1 | undefined> {
  const observation = await queryFabricObservation(request, options);
  if (observation.kind === "known" || observation.kind === "uncertain") {
    return observation.snapshot;
  }
  return undefined;
}

export function isFabricQuiescent(snapshot?: FabricStateSnapshotV1): boolean {
  if (!snapshot || !snapshot.active) {
    return true;
  }
  return snapshot.quiescent;
}

export function isSessionReplacementSafe(observation: FabricObservation): boolean {
  if (observation.kind === "absent") {
    return true;
  }
  if (observation.kind === "uncertain") {
    return false;
  }
  return observation.snapshot.sessionReplacementSafe && observation.snapshot.state === "known";
}
