import {
  ManagedTextResourceBody,
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceKey,
  ManagedTextResourceName,
  type ManagedTextResourceKind,
  type ManagedTextResourceProjectSetOverrideInput,
  type ManagedTextResourceSummary,
  type ProjectId,
} from "@t3tools/contracts";

export type ManagedTextResourceForm = {
  readonly operation: "create" | "edit" | "override";
  readonly kind: ManagedTextResourceKind;
  readonly key: string;
  readonly name: string;
  readonly body: string;
  readonly entry: ManagedTextResourceSummary | null;
  readonly expectedCatalogRevision: typeof ManagedTextResourceCatalogRevision.Type;
};

export function createManagedTextResourceForm(
  form: Omit<ManagedTextResourceForm, "expectedCatalogRevision">,
  expectedCatalogRevision: typeof ManagedTextResourceCatalogRevision.Type,
): ManagedTextResourceForm {
  return { ...form, expectedCatalogRevision };
}

export function buildManagedTextResourceProjectOverrideInput(
  form: ManagedTextResourceForm,
  projectId: ProjectId,
): ManagedTextResourceProjectSetOverrideInput {
  const key = ManagedTextResourceKey.make(form.key.trim());
  const name = form.name.trim();
  return {
    projectId,
    kind: form.kind,
    expectedCatalogRevision: form.expectedCatalogRevision,
    key,
    ...(name ? { name: ManagedTextResourceName.make(name) } : {}),
    body: ManagedTextResourceBody.make(form.body),
  };
}

export type ManagedTextResourceManagementAction =
  | "create-project-override"
  | "disable-project"
  | "reset-project"
  | "edit-project-override"
  | "edit-environment"
  | "disable-environment"
  | "restore-environment"
  | "delete-environment";

export function getManagedTextResourceManagementActions(
  entry: ManagedTextResourceSummary,
  hasProjectContext: boolean,
): readonly ManagedTextResourceManagementAction[] {
  if (!hasProjectContext) {
    if (entry.scope !== "environment") return [];
    return [
      "edit-environment",
      entry.environmentState === "disabled" ? "restore-environment" : "disable-environment",
      "delete-environment",
    ];
  }

  if (entry.projectState === "invalid" || entry.projectState === "orphan") {
    return ["reset-project"];
  }

  if (entry.projectState === "inherit" && entry.scope === "environment") {
    return ["create-project-override", "disable-project"];
  }

  if (entry.scope === "project" && entry.projectState === "override") {
    return ["reset-project", "edit-project-override", "disable-project"];
  }

  return ["reset-project"];
}
