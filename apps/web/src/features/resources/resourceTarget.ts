import type {
  EnvironmentId,
  ManagedTextResourceKind,
  ManagedTextResourceKey,
  ProjectId,
} from "@t3tools/contracts";

export type ResourceTargetKind = "mcp" | "skill" | "command" | "snippet";
export type ResourceTargetScope = "environment" | "project";
export type ResourceTargetIntent = "item" | "create";

interface ResourceTargetBase {
  readonly namespace: "t3-resource";
  readonly version: 1;
  readonly kind: ResourceTargetKind;
  readonly scope: ResourceTargetScope;
  readonly scopeId: string;
  readonly intent: ResourceTargetIntent;
}

export type ResourceTarget =
  | (ResourceTargetBase & {
      readonly kind: "mcp";
      readonly intent: "item";
      readonly identity: "definition" | "override" | "orphan-override";
      readonly id: string;
    })
  | (ResourceTargetBase & {
      readonly kind: "mcp";
      readonly intent: "create";
    })
  | (ResourceTargetBase & {
      readonly kind: "skill";
      readonly intent: "item";
      readonly identity: "skill" | "diagnostic";
      readonly id: string;
    })
  | (ResourceTargetBase & {
      readonly kind: "skill";
      readonly intent: "create";
    })
  | (ResourceTargetBase & {
      readonly kind: "command" | "snippet";
      readonly intent: "item";
      readonly identity: "summary";
      readonly id: string;
    })
  | (ResourceTargetBase & {
      readonly kind: "command" | "snippet";
      readonly intent: "create";
    });

const RESOURCE_TARGET_PREFIX = "t3-resource-v1:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Encode a small, validated editor destination for settings deep links. */
export function buildResourceTarget(target: ResourceTarget): string {
  return `${RESOURCE_TARGET_PREFIX}${encodeURIComponent(JSON.stringify(target))}`;
}

/** Reject malformed, unsupported, and incomplete resource destinations. */
export function parseResourceTarget(value: unknown): ResourceTarget | null {
  if (typeof value !== "string" || !value.startsWith(RESOURCE_TARGET_PREFIX)) return null;
  try {
    const decoded: unknown = JSON.parse(
      decodeURIComponent(value.slice(RESOURCE_TARGET_PREFIX.length)),
    );
    if (
      !isRecord(decoded) ||
      decoded.namespace !== "t3-resource" ||
      decoded.version !== 1 ||
      !["mcp", "skill", "command", "snippet"].includes(String(decoded.kind)) ||
      !["environment", "project"].includes(String(decoded.scope)) ||
      typeof decoded.scopeId !== "string" ||
      decoded.scopeId.length === 0 ||
      !["item", "create"].includes(String(decoded.intent))
    ) {
      return null;
    }
    const targetFields =
      decoded.intent === "create"
        ? ["namespace", "version", "kind", "scope", "scopeId", "intent"]
        : ["namespace", "version", "kind", "scope", "scopeId", "intent", "identity", "id"];
    if (Object.keys(decoded).some((key) => !targetFields.includes(key))) return null;
    if (decoded.intent === "create") {
      if (Object.hasOwn(decoded, "identity") || Object.hasOwn(decoded, "id")) return null;
      return decoded as unknown as ResourceTarget;
    }
    if (typeof decoded.id !== "string" || decoded.id.length === 0) return null;
    const validIdentity =
      (decoded.kind === "mcp" &&
        ["definition", "override", "orphan-override"].includes(String(decoded.identity))) ||
      (decoded.kind === "skill" && ["skill", "diagnostic"].includes(String(decoded.identity))) ||
      ((decoded.kind === "command" || decoded.kind === "snippet") &&
        decoded.identity === "summary");
    return validIdentity ? (decoded as unknown as ResourceTarget) : null;
  } catch {
    return null;
  }
}

export function isResourceTargetFor(
  target: ResourceTarget | null,
  kind: ResourceTargetKind,
  scope: ResourceTargetScope,
  scopeId: string,
): target is ResourceTarget {
  return (
    target !== null && target.kind === kind && target.scope === scope && target.scopeId === scopeId
  );
}

export function makeSkillItemTarget(
  scope: ResourceTargetScope,
  scopeId: string,
  identity: "skill" | "diagnostic",
  id: string,
): ResourceTarget {
  return {
    namespace: "t3-resource",
    version: 1,
    kind: "skill",
    scope,
    scopeId,
    intent: "item",
    identity,
    id,
  };
}

export function makeTextItemTarget(entry: {
  readonly kind: ManagedTextResourceKind;
  readonly key: ManagedTextResourceKey;
  readonly scope: ResourceTargetScope;
  readonly scopeId: string;
}): ResourceTarget {
  return {
    namespace: "t3-resource",
    version: 1,
    kind: entry.kind,
    scope: entry.scope,
    scopeId: entry.scopeId,
    intent: "item",
    identity: "summary",
    id: `${entry.kind}:${entry.key}:${entry.scope}:${entry.scopeId}`,
  };
}

export function makeEnvironmentCreateTarget(
  kind: ResourceTargetKind,
  environmentId: EnvironmentId,
): ResourceTarget {
  const base = {
    namespace: "t3-resource",
    version: 1,
    scope: "environment",
    scopeId: environmentId,
    intent: "create",
  } as const;
  if (kind === "mcp") return { ...base, kind, intent: "create" };
  if (kind === "skill") return { ...base, kind, intent: "create" };
  return { ...base, kind, intent: "create" };
}

export function makeProjectCreateTarget(
  kind: ResourceTargetKind,
  projectId: ProjectId,
): ResourceTarget {
  const base = {
    namespace: "t3-resource",
    version: 1,
    scope: "project",
    scopeId: projectId,
    intent: "create",
  } as const;
  if (kind === "mcp") return { ...base, kind, intent: "create" };
  if (kind === "skill") return { ...base, kind, intent: "create" };
  return { ...base, kind, intent: "create" };
}
