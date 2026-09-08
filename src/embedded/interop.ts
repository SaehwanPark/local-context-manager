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
  active: boolean;
  quiescent: boolean;
  runningChildren: number;
  unresolvedChildTasks: number;
  mutableHolds: number;
  pendingRootRequests: number;
  pendingRootDeliveries: number;
  activeTasks?: FabricTaskSnapshot[];
  mutableResources?: FabricResourceSnapshot[];
  timestamp?: number;
}

export interface FabricStateProviderV1 {
  getSnapshot?(request: FabricSnapshotRequest): FabricStateSnapshotV1 | Promise<FabricStateSnapshotV1>;
}

export type FabricStateProviderFunction = (
  request: FabricSnapshotRequest,
) => FabricStateSnapshotV1 | Promise<FabricStateSnapshotV1>;

export function getInteropRegistry(): PiExtensionInteropRegistryV1 {
  const globalObj = globalThis as unknown as Record<symbol, PiExtensionInteropRegistryV1 | undefined>;
  let registry = globalObj[PI_EXTENSION_INTEROP];
  if (!registry || typeof registry !== "object" || registry.version !== 1 || !(registry.providers instanceof Map)) {
    registry = {
      version: 1,
      providers: new Map<string, unknown>(),
    };
    globalObj[PI_EXTENSION_INTEROP] = registry;
  }
  return registry;
}

export function registerInteropProvider(name: string, provider: unknown): boolean {
  if (!name || provider === undefined || provider === null) {
    return false;
  }
  const registry = getInteropRegistry();
  const existing = registry.providers.get(name);
  if (existing !== undefined && existing !== provider) {
    // Incompatible duplicate provider detected
    return false;
  }
  registry.providers.set(name, provider);
  return true;
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

function clampNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

export function sanitizeFabricSnapshot(raw: unknown): FabricStateSnapshotV1 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;

  const active = Boolean(record.active);
  const quiescent = active ? Boolean(record.quiescent) : true;
  const runningChildren = clampNumber(record.runningChildren);
  const unresolvedChildTasks = clampNumber(record.unresolvedChildTasks);
  const mutableHolds = clampNumber(record.mutableHolds);
  const pendingRootRequests = clampNumber(record.pendingRootRequests);
  const pendingRootDeliveries = clampNumber(record.pendingRootDeliveries);

  const rawTasks = Array.isArray(record.activeTasks) ? record.activeTasks : [];
  const activeTasks: FabricTaskSnapshot[] = [];
  for (const item of rawTasks.slice(0, 10)) {
    if (item && typeof item === "object") {
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

  const rawResources = Array.isArray(record.mutableResources) ? record.mutableResources : [];
  const mutableResources: FabricResourceSnapshot[] = [];
  for (const item of rawResources.slice(0, 10)) {
    if (item && typeof item === "object") {
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

  const timestamp =
    typeof record.timestamp === "number" && Number.isFinite(record.timestamp) && record.timestamp > 0
      ? record.timestamp
      : Date.now();

  const result: FabricStateSnapshotV1 = {
    active,
    quiescent,
    runningChildren,
    unresolvedChildTasks,
    mutableHolds,
    pendingRootRequests,
    pendingRootDeliveries,
    timestamp,
  };
  if (activeTasks.length > 0) {
    result.activeTasks = activeTasks;
  }
  if (mutableResources.length > 0) {
    result.mutableResources = mutableResources;
  }
  return result;
}

export async function queryFabricState(
  request: FabricSnapshotRequest,
): Promise<FabricStateSnapshotV1 | undefined> {
  const provider = getInteropProvider<FabricStateProviderV1 | FabricStateProviderFunction>(
    SAFE_AGENT_FABRIC_PROVIDER_NAME,
  );
  if (!provider) {
    return undefined;
  }

  try {
    let rawSnapshot: unknown;
    if (typeof (provider as FabricStateProviderV1).getSnapshot === "function") {
      rawSnapshot = await (provider as FabricStateProviderV1).getSnapshot!(request);
    } else if (typeof provider === "function") {
      rawSnapshot = await (provider as FabricStateProviderFunction)(request);
    } else {
      return undefined;
    }
    return sanitizeFabricSnapshot(rawSnapshot);
  } catch {
    return undefined;
  }
}

export function isFabricQuiescent(snapshot?: FabricStateSnapshotV1): boolean {
  if (!snapshot || !snapshot.active) {
    return true;
  }
  return snapshot.quiescent;
}
