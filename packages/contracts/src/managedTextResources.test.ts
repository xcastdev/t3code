import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ManagedTextResourceCatalogListInput,
  ManagedTextResourceCatalogListResult,
  ManagedTextResourceChanged,
  ManagedTextResourceContentGetInput,
  ManagedTextResourceContentGetResult,
  ManagedTextResourceEnvironmentCreateInput,
  ManagedTextResourceEnvironmentDeleteInput,
  ManagedTextResourceEnvironmentSetEnabledInput,
  ManagedTextResourceEnvironmentUpdateInput,
  ManagedTextResourceId,
  ManagedTextResourceKey,
  ManagedTextResourceProjectDeleteStateInput,
  ManagedTextResourceProjectSetDisabledInput,
  ManagedTextResourceProjectSetOverrideInput,
  ManagedTextResourceRpcError,
  ManagedTextResourceSummary,
  ManagedTextResourceThreadOverlay,
  ManagedTextResourceThreadResetInput,
  ManagedTextResourceThreadSetEnabledInput,
} from "./managedTextResources.ts";

const revision = "a".repeat(64);

describe("managed text resource contracts", () => {
  it("accepts safe resource path identifiers and rejects traversal", () => {
    const isId = Schema.is(ManagedTextResourceId);
    const isKey = Schema.is(ManagedTextResourceKey);

    expect(isId("command-review-1")).toBe(true);
    expect(isKey("review-code")).toBe(true);
    expect(isId("../outside")).toBe(false);
    expect(isId("folder/item")).toBe(false);
    expect(isKey("UpperCase")).toBe(false);
    expect(isKey("two words")).toBe(false);
    expect(isKey("a".repeat(65))).toBe(false);
    expect(isKey("con")).toBe(false);
  });

  it("requires identity and an exact opaque revision for content reads", () => {
    const base = {
      kind: "command",
      id: "command-review-1",
      projectId: "project-1",
      expectedRevision: revision,
    };

    expect(Schema.is(ManagedTextResourceContentGetInput)(base)).toBe(true);
    expect(
      Schema.is(ManagedTextResourceContentGetInput)({ ...base, expectedRevision: undefined }),
    ).toBe(false);
    expect(
      Schema.is(ManagedTextResourceContentGetInput)({ ...base, expectedRevision: "stale" }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceContentGetResult)({
        kind: "command",
        id: "command-review-1",
        key: "review",
        revision,
        body: "Review the current diff.",
      }),
    ).toBe(true);
  });

  it("keeps catalog summaries bounded and requires a revision for disabled tombstones", () => {
    const disabled = {
      kind: "snippet",
      key: "signature",
      scope: "project",
      scopeId: "project-1",
      projectState: "disabled",
      revision,
      effective: false,
    };

    expect(Schema.is(ManagedTextResourceSummary)(disabled)).toBe(true);
    expect(
      Schema.is(ManagedTextResourceSummary)({
        ...disabled,
        scope: "environment",
        environmentState: "disabled",
      }),
    ).toBe(true);
    expect(Schema.is(ManagedTextResourceSummary)({ ...disabled, revision: undefined })).toBe(false);
    expect(Schema.is(ManagedTextResourceSummary)({ ...disabled, projectState: "invalid" })).toBe(
      true,
    );
    expect(
      Schema.is(ManagedTextResourceCatalogListInput)({
        projectId: "project-1",
        threadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceCatalogListResult)({ catalogRevision: 3, entries: [disabled] }),
    ).toBe(true);

    const tooManyEntries = Array.from({ length: 513 }, (_, index) => ({
      ...disabled,
      key: `snippet-${index}`,
    }));
    expect(
      Schema.is(ManagedTextResourceCatalogListResult)({
        catalogRevision: 3,
        entries: tooManyEntries,
      }),
    ).toBe(false);
  });

  it("requires optimistic revisions at every definition mutation boundary", () => {
    const environmentCreate = {
      environmentId: "environment-1",
      kind: "command",
      expectedCatalogRevision: 2,
      key: "review",
      body: "Review the current diff.",
    };
    expect(Schema.is(ManagedTextResourceEnvironmentCreateInput)(environmentCreate)).toBe(true);
    expect(
      Schema.is(ManagedTextResourceEnvironmentCreateInput)({
        ...environmentCreate,
        name: "x".repeat(129),
      }),
    ).toBe(false);
    expect(
      Schema.is(ManagedTextResourceEnvironmentCreateInput)({
        ...environmentCreate,
        body: "x".repeat(65_537),
      }),
    ).toBe(false);
    expect(
      Schema.is(ManagedTextResourceEnvironmentCreateInput)({
        ...environmentCreate,
        expectedCatalogRevision: undefined,
      }),
    ).toBe(false);

    const mutationIdentity = {
      environmentId: "environment-1",
      kind: "command",
      id: "command-review-1",
    };
    expect(
      Schema.is(ManagedTextResourceEnvironmentUpdateInput)({
        ...mutationIdentity,
        expectedRevision: revision,
        body: "Updated prompt.",
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceEnvironmentUpdateInput)({
        ...mutationIdentity,
        body: "Updated prompt.",
      }),
    ).toBe(false);
    expect(
      Schema.is(ManagedTextResourceEnvironmentDeleteInput)({
        ...mutationIdentity,
        expectedRevision: revision,
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceEnvironmentSetEnabledInput)({
        ...mutationIdentity,
        expectedRevision: revision,
        enabled: false,
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceEnvironmentSetEnabledInput)({
        ...mutationIdentity,
        enabled: true,
      }),
    ).toBe(false);
  });

  it("requires catalog revisions for project override, disable, and restore operations", () => {
    const common = {
      projectId: "project-1",
      kind: "snippet",
      key: "signature",
    };

    expect(
      Schema.is(ManagedTextResourceProjectSetOverrideInput)({
        ...common,
        expectedCatalogRevision: 4,
        body: "Best,\nSam",
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceProjectSetDisabledInput)({
        ...common,
        expectedCatalogRevision: 4,
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceProjectDeleteStateInput)({
        ...common,
        expectedCatalogRevision: 4,
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceProjectSetDisabledInput)({
        ...common,
        expectedCatalogRevision: -1,
      }),
    ).toBe(false);
  });

  it("represents thread overrides as revisioned key state and supports resetting them", () => {
    expect(
      Schema.is(ManagedTextResourceThreadOverlay)({
        threadId: "thread-1",
        kind: "command",
        key: "review",
        enabled: false,
        revision,
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceThreadSetEnabledInput)({
        threadId: "thread-1",
        expectedCatalogRevision: 5,
        kind: "command",
        key: "review",
        enabled: true,
      }),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceThreadResetInput)({
        threadId: "thread-1",
        expectedCatalogRevision: 5,
        kind: "command",
        key: "review",
      }),
    ).toBe(true);
  });

  it("bounds catalog change notifications and preserves structured revision conflicts", () => {
    expect(
      Schema.is(ManagedTextResourceChanged)({
        scope: "project",
        scopeId: "project-1",
        catalogRevision: 8,
        changedKeys: [{ kind: "snippet", key: "signature" }],
      }),
    ).toBe(true);

    expect(
      Schema.is(ManagedTextResourceRpcError)(
        Schema.decodeUnknownSync(ManagedTextResourceRpcError)({
          _tag: "ManagedTextResourceRpcError",
          code: "revision-conflict",
          message: "The resource changed before the update was applied.",
          expectedRevision: revision,
          actualRevision: "b".repeat(64),
        }),
      ),
    ).toBe(true);
    expect(
      Schema.is(ManagedTextResourceRpcError)({
        _tag: "ManagedTextResourceRpcError",
        code: "revision-conflict",
        message: "x".repeat(1_001),
      }),
    ).toBe(false);
  });
});
