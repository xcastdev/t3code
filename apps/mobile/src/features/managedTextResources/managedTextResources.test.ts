import {
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  ProjectId,
  type ManagedTextResourceSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildManagedTextResourceProjectOverrideInput,
  createManagedTextResourceForm,
  getManagedTextResourceManagementActions,
} from "./managedTextResourcesModel";

function summary(overrides: Partial<ManagedTextResourceSummary> = {}): ManagedTextResourceSummary {
  return {
    kind: "command",
    id: ManagedTextResourceId.make("review-command"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: "environment-1",
    projectState: "inherit",
    revision: ManagedTextResourceRevision.make("revision-1"),
    effective: true,
    ...overrides,
  };
}

describe("managed text resource management actions", () => {
  it("lets a project override or disable an inherited environment resource", () => {
    expect(getManagedTextResourceManagementActions(summary(), true)).toEqual([
      "create-project-override",
      "disable-project",
    ]);
  });

  it("lets a project restore, edit, or disable its override", () => {
    expect(
      getManagedTextResourceManagementActions(
        summary({ scope: "project", scopeId: "project-1", projectState: "override" }),
        true,
      ),
    ).toEqual(["reset-project", "edit-project-override", "disable-project"]);
  });

  it.each([
    ["disabled", "environment"],
    ["invalid", "project"],
    ["orphan", "project"],
  ] as const)("only offers project reset for %s state", (projectState, scope) => {
    expect(
      getManagedTextResourceManagementActions(
        summary({ scope, projectState, effective: false }),
        true,
      ),
    ).toEqual(["reset-project"]);
  });

  it("lets environment scope edit and delete an environment resource", () => {
    expect(getManagedTextResourceManagementActions(summary(), false)).toEqual([
      "edit-environment",
      "disable-environment",
      "delete-environment",
    ]);
  });

  it("lets a disabled environment resource be restored", () => {
    expect(
      getManagedTextResourceManagementActions(
        summary({ environmentState: "disabled", effective: false }),
        false,
      ),
    ).toEqual(["edit-environment", "restore-environment", "delete-environment"]);
  });

  it("does not offer mutations for a project resource outside project scope", () => {
    expect(
      getManagedTextResourceManagementActions(
        summary({ scope: "project", scopeId: "project-1", projectState: "override" }),
        false,
      ),
    ).toEqual([]);
  });
});

describe("project override form revisions", () => {
  it.each(["create", "override"] as const)(
    "keeps the catalog revision from when a project %s form opened after catalog refresh",
    (operation) => {
      const revisionWhenOpened = ManagedTextResourceCatalogRevision.make(7);
      const newerCatalogRevision = ManagedTextResourceCatalogRevision.make(8);
      const form = createManagedTextResourceForm(
        {
          operation,
          kind: "command",
          key: "review",
          name: "Review",
          body: "Inspect the selected files.",
          entry: operation === "create" ? null : summary(),
        },
        revisionWhenOpened,
      );

      const input = buildManagedTextResourceProjectOverrideInput(form, ProjectId.make("project-1"));

      expect(input.expectedCatalogRevision).toBe(revisionWhenOpened);
      expect(input.expectedCatalogRevision).not.toBe(newerCatalogRevision);
    },
  );
});
