export type ManagedTextResourceKind = "command" | "snippet";

export interface ManagedTextResourceCandidate {
  readonly id: string;
  readonly scope: "environment" | "project";
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly name: string;
  readonly revision: string;
  readonly state: "active" | "disabled" | "invalid";
}

export interface ManagedTextResourceOverlay {
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly enabled: boolean;
}

export interface ResolvedManagedTextResource {
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly winner?: ManagedTextResourceCandidate;
  readonly projectState: "inherit" | "override" | "disabled" | "invalid" | "orphan";
  readonly effective: boolean;
  readonly threadEnabled?: boolean;
  readonly diagnostics: ReadonlyArray<string>;
}

const identity = (kind: ManagedTextResourceKind, key: string) => `${kind}:${key}`;

/** Project entries with a known key block inheritance even when their body is invalid. */
export function resolveManagedTextResources(input: {
  readonly environment: ReadonlyArray<ManagedTextResourceCandidate>;
  readonly project?: ReadonlyArray<ManagedTextResourceCandidate>;
  readonly thread?: ReadonlyArray<ManagedTextResourceOverlay>;
}): ReadonlyMap<string, ResolvedManagedTextResource> {
  const environment = new Map<string, ManagedTextResourceCandidate[]>();
  const project = new Map<string, ManagedTextResourceCandidate[]>();
  const overlays = new Map(
    input.thread?.map((entry) => [identity(entry.kind, entry.key), entry.enabled]),
  );

  for (const entry of input.environment) {
    const id = identity(entry.kind, entry.key);
    environment.set(id, [...(environment.get(id) ?? []), entry]);
  }
  for (const entry of input.project ?? []) {
    const id = identity(entry.kind, entry.key);
    project.set(id, [...(project.get(id) ?? []), entry]);
  }

  const resolved = new Map<string, ResolvedManagedTextResource>();
  for (const id of [...new Set([...environment.keys(), ...project.keys()])].sort()) {
    const environmentEntries = environment.get(id) ?? [];
    const projectEntries = project.get(id) ?? [];
    const environmentWinner =
      environmentEntries.length === 1 && environmentEntries[0]?.state !== "invalid"
        ? environmentEntries[0]
        : undefined;
    const projectWinner =
      projectEntries.length === 1 && projectEntries[0]?.state !== "invalid"
        ? projectEntries[0]
        : undefined;
    const projectDisabled = projectWinner?.state === "disabled";
    const winner =
      projectWinner?.state === "active"
        ? projectWinner
        : projectEntries.length === 0
          ? environmentWinner
          : undefined;
    const projectState =
      projectEntries.length === 0
        ? "inherit"
        : projectEntries.length !== 1 || projectEntries.some((entry) => entry.state === "invalid")
          ? "invalid"
          : environmentWinner === undefined && projectWinner?.state !== "active"
            ? "orphan"
            : projectDisabled
              ? "disabled"
              : "override";
    const threadEnabled = overlays.get(id);
    const [kind, key] = id.split(":", 2) as [ManagedTextResourceKind, string];
    resolved.set(id, {
      kind,
      key,
      ...(winner === undefined ? {} : { winner }),
      projectState,
      effective:
        winner?.state === "active" &&
        (threadEnabled === undefined ? !projectDisabled : threadEnabled),
      ...(threadEnabled === undefined ? {} : { threadEnabled }),
      diagnostics: [
        ...(environmentEntries.length > 1 ? ["duplicate_environment_key"] : []),
        ...(projectEntries.length > 1 ? ["duplicate_project_key"] : []),
        ...(environmentEntries.some((entry) => entry.state === "invalid")
          ? ["invalid_environment_entry"]
          : []),
        ...(projectEntries.some((entry) => entry.state === "invalid")
          ? ["invalid_project_entry"]
          : []),
        ...(projectDisabled ? ["project_disabled"] : []),
      ],
    });
  }
  return resolved;
}
