import {
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceRevision,
  type ManagedTextResourceSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pinManagedTextResourceCatalogRevision,
  resolveManagedTextResourceMutationEffects,
  resolveManagedTextResourceState,
} from "./managedTextResources.logic";

function summary(overrides: Partial<ManagedTextResourceSummary> = {}): ManagedTextResourceSummary {
  return {
    kind: "command",
    id: ManagedTextResourceId.make("resource-1"),
    key: ManagedTextResourceKey.make("review"),
    scope: "environment",
    scopeId: "environment-1",
    projectState: "inherit",
    revision: ManagedTextResourceRevision.make("revision-1"),
    effective: true,
    ...overrides,
  };
}

describe("resolveManagedTextResourceState", () => {
  it("keeps a project disable reversible without treating its tombstone as malformed", () => {
    const disabledTombstone: ManagedTextResourceSummary = {
      kind: "command",
      key: ManagedTextResourceKey.make("review"),
      scope: "project",
      scopeId: "project-1",
      projectState: "disabled",
      revision: ManagedTextResourceRevision.make("revision-2"),
      effective: false,
    };
    expect(resolveManagedTextResourceState(disabledTombstone)).toEqual({
      unavailable: false,
      effective: false,
      projectStateLabel: "Disabled in project",
      effectiveLabel: "Disabled",
    });
  });

  it.each(["invalid", "orphan"] as const)(
    "never exposes a %s project entry as effective, even if its summary says so",
    (projectState) => {
      expect(resolveManagedTextResourceState(summary({ projectState, effective: true }))).toEqual({
        unavailable: true,
        effective: false,
        projectStateLabel: `Unavailable · ${projectState}`,
        effectiveLabel: "Unavailable",
      });
    },
  );

  it("distinguishes an available but inherited disabled command from a malformed entry", () => {
    expect(resolveManagedTextResourceState(summary({ effective: false }))).toMatchObject({
      unavailable: false,
      effective: false,
      projectStateLabel: "Inherited · disabled",
      effectiveLabel: "Disabled",
    });
  });

  it("reports environment-disabled inherited entries without disabling a project override", () => {
    expect(
      resolveManagedTextResourceState(summary({ environmentState: "disabled", effective: false })),
    ).toMatchObject({
      unavailable: false,
      effective: false,
      projectStateLabel: "Disabled in environment",
      effectiveLabel: "Disabled",
    });
    expect(
      resolveManagedTextResourceState(
        summary({ environmentState: "disabled", projectState: "override", scope: "project" }),
      ),
    ).toMatchObject({
      unavailable: false,
      effective: true,
      projectStateLabel: "Project override",
      effectiveLabel: "Enabled",
    });
  });
});

describe("resolveManagedTextResourceMutationEffects", () => {
  it("preserves typed editor fields after a failed create", () => {
    expect(resolveManagedTextResourceMutationEffects({ _tag: "Failure" }, true)).toEqual({
      applied: false,
      refreshCatalog: false,
      clearEditor: false,
    });
  });

  it("clears a new editor only after a successful create and keeps successful edits open", () => {
    expect(resolveManagedTextResourceMutationEffects({ _tag: "Success" }, true)).toEqual({
      applied: true,
      refreshCatalog: true,
      clearEditor: true,
    });
    expect(resolveManagedTextResourceMutationEffects({ _tag: "Success" }, false)).toEqual({
      applied: true,
      refreshCatalog: true,
      clearEditor: false,
    });
  });
});

describe("pinManagedTextResourceCatalogRevision", () => {
  it("captures the first loaded revision and keeps it stable through subscription refreshes", () => {
    const initial = ManagedTextResourceCatalogRevision.make(0);
    expect(pinManagedTextResourceCatalogRevision(null, initial)).toBe(initial);
    expect(
      pinManagedTextResourceCatalogRevision(initial, ManagedTextResourceCatalogRevision.make(4)),
    ).toBe(initial);
  });
});
