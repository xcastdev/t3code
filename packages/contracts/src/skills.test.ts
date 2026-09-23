import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillContent,
  ManagedSkillManifest,
  SkillApplicationDetail,
  SkillApplicationFailure,
  SkillApplicationSummary,
  SkillCatalogSummary,
  SkillCompatibility,
  SkillDiscoveryError,
  SkillGlobalCreateInput,
  SkillGlobalDeleteInput,
  SkillGlobalRenameInput,
  SkillGlobalRollbackInput,
  SkillGlobalUpdateInput,
  SkillNativeImportInput,
  SkillNativeObservation,
  SkillProjectDeleteStateInput,
  SkillProjectRenameInput,
  SkillProjectSetDisabledInput,
  SkillProjectSetOverrideInput,
  SkillReasonSummary,
  SkillSessionResetInput,
  SkillSessionSetEnabledInput,
} from "./skills.ts";

const isManagedSkillKey = Schema.is(ManagedSkillKey);
const summaryReasonSchemas = [
  ["reason summary", SkillReasonSummary],
  ["application failure", SkillApplicationFailure],
  ["discovery error", SkillDiscoveryError],
] as const;

describe("managed skill contracts", () => {
  it("validates portable frontmatter extensions without accepting reserved or non-YAML values", () => {
    const base = {
      key: "deploy",
      name: "Deploy",
      body: "Body",
    };
    expect(
      Schema.is(ManagedSkillContent)({
        ...base,
        frontmatter: {
          license: "MIT",
          "disable-model-invocation": true,
          "allowed-tools": ["Bash"],
        },
      }),
    ).toBe(true);
    expect(Schema.is(ManagedSkillContent)({ ...base, frontmatter: { name: "wrong" } })).toBe(false);
    expect(
      Schema.is(ManagedSkillContent)({
        ...base,
        frontmatter: { unsupported: BigInt(1) },
      }),
    ).toBe(false);
  });

  it("validates known portable frontmatter field types while preserving safe extensions", () => {
    const base = {
      key: "deploy",
      name: "Deploy",
      body: "Body",
    };
    const valid = {
      ...base,
      frontmatter: {
        license: "MIT",
        compatibility: "Codex 0.1+",
        "disable-model-invocation": true,
        "user-invocable": false,
        "argument-hint": "<environment>",
        "allowed-tools": ["Bash", "Read"],
        metadata: { team: "release", revision: 2 },
        unknownExtension: { nested: ["safe", true] },
      },
    };
    expect(Schema.is(ManagedSkillContent)(valid)).toBe(true);
    expect(
      Schema.is(ManagedSkillContent)({
        ...base,
        frontmatter: { "allowed-tools": "Bash, Read" },
      }),
    ).toBe(true);

    for (const frontmatter of [
      { license: false },
      { compatibility: 1 },
      { "disable-model-invocation": "true" },
      { "user-invocable": "false" },
      { "argument-hint": ["<environment>"] },
      { "allowed-tools": 42 },
      { "allowed-tools": ["Bash", 42] },
      { metadata: ["not", "a", "mapping"] },
      { metadata: "not-a-mapping" },
    ]) {
      expect(Schema.is(ManagedSkillContent)({ ...base, frontmatter })).toBe(false);
    }
  });

  it("accepts only portable managed skill id path components", () => {
    const isManagedSkillId = Schema.is(ManagedSkillId);
    for (const id of ["a", "skill-1", "a".repeat(128), "123e4567-e89b-12d3-a456-426614174000"]) {
      expect(isManagedSkillId(id)).toBe(true);
    }
    for (const id of [
      "../victim",
      "../../victim",
      "a/b",
      "a\\b",
      ".",
      "..",
      "-leading",
      "_leading",
      "with space",
      "C:drive",
      "con",
      "NUL",
      "a".repeat(129),
    ]) {
      expect(isManagedSkillId(id)).toBe(false);
    }
  });

  it("rejects unsafe managed skill ids at every storage mutation boundary", () => {
    const unsafeId = "../../victim";
    expect(
      Schema.is(ManagedSkillManifest)({
        schemaVersion: 1,
        kind: "managed-skill",
        id: unsafeId,
        key: "deploy",
        scope: "global",
        revision: { revision: 1, hash: "hash" },
        origin: "created",
        ownership: "t3",
      }),
    ).toBe(false);
    expect(
      Schema.is(SkillGlobalDeleteInput)({
        environmentId: "environment-1",
        skillId: unsafeId,
        expectedHash: "hash",
      }),
    ).toBe(false);
    expect(
      Schema.is(SkillGlobalRollbackInput)({
        environmentId: "environment-1",
        skillId: unsafeId,
        revision: 1,
        expectedHash: "hash",
      }),
    ).toBe(false);
    expect(
      Schema.is(SkillProjectRenameInput)({
        projectId: "project-1",
        skillId: unsafeId,
        key: "deploy",
        expectedHash: "hash",
      }),
    ).toBe(false);
  });

  it("accepts portable lowercase kebab keys from 1 through 64 characters", () => {
    expect(isManagedSkillKey("a")).toBe(true);
    expect(isManagedSkillKey("skill-2")).toBe(true);
    expect(isManagedSkillKey("a".repeat(64))).toBe(true);
  });

  it.each([
    "",
    "Uppercase",
    "has_underscore",
    "-leading",
    "trailing-",
    "two--hyphens",
    "a".repeat(65),
  ])("rejects the non-portable key %j", (key) => {
    expect(isManagedSkillKey(key)).toBe(false);
  });

  it("strips provider diagnostics from application failure summaries", () => {
    const decoded = Schema.decodeUnknownSync(SkillApplicationFailure)({
      code: "materialization_failed",
      message: "Could not prepare the session catalog",
      details: {
        body: "failure-body-sentinel",
        nativePath: "/private/provider/skills/release-notes/SKILL.md",
        providerConfig: { endpoint: "failure-provider-config-sentinel" },
        credentials: { apiKey: "failure-credential-sentinel" },
        providerData: { payload: "failure-provider-data-sentinel" },
      },
    });

    expect(decoded).toEqual({
      code: "materialization_failed",
      message: "Could not prepare the session catalog",
    });
    expect(decoded).not.toHaveProperty("details");
    expect(JSON.stringify(decoded)).not.toContain("failure-body-sentinel");
    expect(JSON.stringify(decoded)).not.toContain(
      "/private/provider/skills/release-notes/SKILL.md",
    );
    expect(JSON.stringify(decoded)).not.toContain("failure-provider-config-sentinel");
    expect(JSON.stringify(decoded)).not.toContain("failure-credential-sentinel");
    expect(JSON.stringify(decoded)).not.toContain("failure-provider-data-sentinel");
  });

  it("strips provider diagnostics from discovery errors", () => {
    const decoded = Schema.decodeUnknownSync(SkillDiscoveryError)({
      code: "provider_unavailable",
      message: "Provider discovery failed",
      details: { payload: "discovery-provider-data-sentinel" },
    });

    expect(decoded).toEqual({
      code: "provider_unavailable",
      message: "Provider discovery failed",
    });
    expect(JSON.stringify(decoded)).not.toContain("discovery-provider-data-sentinel");
  });

  it("strips provider diagnostics from compatibility reasons", () => {
    const decoded = Schema.decodeUnknownSync(SkillCompatibility)({
      providerInstanceId: "codex",
      support: "supported_with_limitations",
      applicationMode: "new_session_required",
      reasons: [
        {
          code: "provider_limit",
          message: "The provider requires a new session",
          details: {
            body: "compatibility-body-sentinel",
            nativePath: "/private/provider/skills/compatibility/SKILL.md",
            providerConfig: { endpoint: "compatibility-provider-config-sentinel" },
            credentials: { apiKey: "compatibility-credential-sentinel" },
            providerData: { payload: "compatibility-provider-data-sentinel" },
          },
        },
      ],
    });

    expect(decoded.reasons[0]).toEqual({
      code: "provider_limit",
      message: "The provider requires a new session",
    });
    expect(decoded.reasons[0]).not.toHaveProperty("details");
    expect(JSON.stringify(decoded)).not.toContain("compatibility-body-sentinel");
    expect(JSON.stringify(decoded)).not.toContain(
      "/private/provider/skills/compatibility/SKILL.md",
    );
    expect(JSON.stringify(decoded)).not.toContain("compatibility-provider-config-sentinel");
    expect(JSON.stringify(decoded)).not.toContain("compatibility-credential-sentinel");
    expect(JSON.stringify(decoded)).not.toContain("compatibility-provider-data-sentinel");
  });

  it.each(summaryReasonSchemas)("bounds %s codes", (_name, schema) => {
    expect(Schema.is(schema)({ code: "a", message: "message" })).toBe(true);
    expect(Schema.is(schema)({ code: "a".repeat(128), message: "message" })).toBe(true);
    expect(Schema.is(schema)({ code: "a".repeat(129), message: "message" })).toBe(false);
  });

  it.each(summaryReasonSchemas)("bounds %s messages", (_name, schema) => {
    expect(Schema.is(schema)({ code: "code", message: "a" })).toBe(true);
    expect(Schema.is(schema)({ code: "code", message: "a".repeat(1_000) })).toBe(true);
    expect(Schema.is(schema)({ code: "code", message: "a".repeat(1_001) })).toBe(false);
  });

  it("accepts at most 16 compatibility reasons", () => {
    const compatibilityWithReasonCount = (count: number) => ({
      providerInstanceId: "codex",
      support: "supported",
      applicationMode: "live",
      reasons: Array.from({ length: count }, (_, index) => ({
        code: `reason_${index}`,
        message: `Reason ${index}`,
      })),
    });

    expect(Schema.is(SkillCompatibility)(compatibilityWithReasonCount(0))).toBe(true);
    expect(Schema.is(SkillCompatibility)(compatibilityWithReasonCount(16))).toBe(true);
    expect(Schema.is(SkillCompatibility)(compatibilityWithReasonCount(17))).toBe(false);
  });

  it("decodes compact catalog summaries while stripping content and server-only fields", () => {
    const decoded = Schema.decodeUnknownSync(SkillCatalogSummary)({
      origin: "managed",
      id: "skill-1",
      key: "release-notes",
      name: "Release notes",
      scope: "global",
      scopeId: "environment-1",
      projectState: "inherit",
      revision: { revision: 3, hash: "sha256:abc" },
      validity: "valid",
      effective: true,
      compatibility: [
        {
          providerInstanceId: "codex",
          support: "supported_with_limitations",
          applicationMode: "new_session_required",
          reasons: [
            {
              code: "compatibility_limit",
              message: "A new session is required",
              details: {
                body: "catalog-compatibility-body-sentinel",
                nativePath: "/private/catalog/compatibility/SKILL.md",
                providerConfig: { endpoint: "catalog-compatibility-config-sentinel" },
                credentials: { apiKey: "catalog-compatibility-credential-sentinel" },
                providerData: { payload: "catalog-compatibility-provider-data-sentinel" },
              },
            },
          ],
        },
      ],
      application: {
        desiredRevision: 8,
        appliedRevision: 5,
        status: "failed",
        failure: {
          code: "materialization_failed",
          message: "Could not prepare the session catalog",
          details: {
            body: "catalog-application-body-sentinel",
            nativePath: "/private/catalog/application/SKILL.md",
            providerConfig: { endpoint: "catalog-application-config-sentinel" },
            credentials: { apiKey: "catalog-application-credential-sentinel" },
            providerData: { payload: "catalog-application-provider-data-sentinel" },
          },
        },
      },
      body: "must not cross the catalog boundary",
      nativePath: "/private/provider/skills/release-notes/SKILL.md",
      providerConfig: { token: "secret" },
      credentials: { apiKey: "secret" },
    });

    expect(decoded).toEqual({
      origin: "managed",
      id: "skill-1",
      key: "release-notes",
      name: "Release notes",
      scope: "global",
      scopeId: "environment-1",
      projectState: "inherit",
      revision: { revision: 3, hash: "sha256:abc" },
      validity: "valid",
      effective: true,
      compatibility: [
        {
          providerInstanceId: "codex",
          support: "supported_with_limitations",
          applicationMode: "new_session_required",
          reasons: [
            {
              code: "compatibility_limit",
              message: "A new session is required",
            },
          ],
        },
      ],
      application: {
        desiredRevision: 8,
        appliedRevision: 5,
        status: "failed",
        failure: {
          code: "materialization_failed",
          message: "Could not prepare the session catalog",
        },
      },
    });
    expect(decoded.compatibility[0]?.reasons[0]).not.toHaveProperty("details");
    expect(decoded.application?.failure).not.toHaveProperty("details");

    const encoded = Schema.encodeUnknownSync(SkillCatalogSummary)(decoded);
    expect(encoded).toEqual(decoded);
    expect(encoded.compatibility[0]?.reasons[0]).toEqual({
      code: "compatibility_limit",
      message: "A new session is required",
    });
    expect(encoded.application?.failure).toEqual({
      code: "materialization_failed",
      message: "Could not prepare the session catalog",
    });

    const forbiddenSentinels = [
      "must not cross the catalog boundary",
      "/private/provider/skills/release-notes/SKILL.md",
      "secret",
      "catalog-compatibility-body-sentinel",
      "/private/catalog/compatibility/SKILL.md",
      "catalog-compatibility-config-sentinel",
      "catalog-compatibility-credential-sentinel",
      "catalog-compatibility-provider-data-sentinel",
      "catalog-application-body-sentinel",
      "/private/catalog/application/SKILL.md",
      "catalog-application-config-sentinel",
      "catalog-application-credential-sentinel",
      "catalog-application-provider-data-sentinel",
    ];
    for (const sentinel of forbiddenSentinels) {
      expect(JSON.stringify(decoded)).not.toContain(sentinel);
      expect(JSON.stringify(encoded)).not.toContain(sentinel);
    }
  });

  it("keeps discovery failure, freshness, and three availability dimensions distinct", () => {
    const decoded = Schema.decodeUnknownSync(SkillNativeObservation)({
      observationId: "observation-1",
      providerInstanceId: "codex",
      nativeIdentity: "native/release-notes",
      key: "release-notes",
      displayName: "Release notes",
      source: "user",
      scopeSummary: "User skills",
      providerEnabled: false,
      modelAvailable: true,
      userInvocable: false,
      freshness: "stale",
      observedAt: "2026-09-19T10:00:00.000Z",
      attemptedAt: "2026-09-20T10:00:00.000Z",
      discoveryError: {
        code: "provider_unavailable",
        message: "Provider discovery failed",
        details: { payload: "native-discovery-provider-data-sentinel" },
      },
      nativePath: "/private/provider/skills/release-notes/SKILL.md",
    });

    expect(decoded.providerEnabled).toBe(false);
    expect(decoded.modelAvailable).toBe(true);
    expect(decoded.userInvocable).toBe(false);
    expect(decoded.freshness).toBe("stale");
    expect(decoded.discoveryError).toEqual({
      code: "provider_unavailable",
      message: "Provider discovery failed",
    });
    expect(JSON.stringify(decoded)).not.toContain("native-discovery-provider-data-sentinel");
    expect(decoded).not.toHaveProperty("nativePath");
  });

  it("retains provider diagnostics in explicit application detail", () => {
    const decoded = Schema.decodeUnknownSync(SkillApplicationDetail)({
      desiredRevision: 8,
      appliedRevision: 5,
      status: "failed",
      failure: {
        code: "materialization_failed",
        message: "Could not prepare the session catalog",
        details: { mustNotSurvive: true },
      },
      providerInstanceId: "codex",
      threadId: "thread-1",
      outcomes: [
        {
          key: "release-notes",
          status: "failed",
          reason: {
            code: "provider_materialization_failed",
            message: "The provider could not materialize the skill",
            details: { provider: "codex", phase: "thread_start" },
          },
        },
      ],
      attemptedAt: "2026-09-20T10:00:00.000Z",
    });

    expect(decoded.failure).toEqual({
      code: "materialization_failed",
      message: "Could not prepare the session catalog",
    });
    expect(decoded.outcomes[0]?.reason?.details).toEqual({
      provider: "codex",
      phase: "thread_start",
    });
  });

  it("retains desired and applied revisions alongside an application failure", () => {
    const decoded = Schema.decodeUnknownSync(SkillApplicationSummary)({
      desiredRevision: 8,
      appliedRevision: 5,
      status: "failed",
      failure: {
        code: "materialization_failed",
        message: "Could not prepare the session catalog",
        details: { provider: "codex" },
      },
    });

    expect(decoded).toEqual({
      desiredRevision: 8,
      appliedRevision: 5,
      status: "failed",
      failure: {
        code: "materialization_failed",
        message: "Could not prepare the session catalog",
      },
    });
    expect(
      Schema.is(SkillApplicationSummary)({
        desiredRevision: 8,
        appliedRevision: 5,
        status: "failed",
        failure: { code: "a".repeat(129), message: "message" },
      }),
    ).toBe(false);
    expect(
      Schema.is(SkillApplicationSummary)({
        desiredRevision: 8,
        appliedRevision: 5,
        status: "failed",
        failure: { code: "code", message: "a".repeat(1_001) },
      }),
    ).toBe(false);
  });

  it("requires optimistic concurrency for authored-state replacements", () => {
    const globalUpdate = {
      environmentId: "environment-1",
      skillId: "skill-1",
      content: { key: "release-notes", name: "Release notes", body: "Instructions" },
    };
    const projectOverride = {
      projectId: "project-1",
      key: "release-notes",
      content: { key: "release-notes", name: "Project release notes", body: "Instructions" },
    };

    expect(Schema.is(SkillGlobalUpdateInput)(globalUpdate)).toBe(false);
    expect(Schema.is(SkillGlobalUpdateInput)({ ...globalUpdate, expectedHash: "sha256:old" })).toBe(
      true,
    );
    expect(Schema.is(SkillProjectSetOverrideInput)(projectOverride)).toBe(false);
    expect(
      Schema.is(SkillProjectSetOverrideInput)({ ...projectOverride, expectedRevision: 4 }),
    ).toBe(true);

    const mutationCases = [
      [SkillGlobalCreateInput, { environmentId: "environment-1", content: globalUpdate.content }],
      [
        SkillGlobalDeleteInput,
        { environmentId: "environment-1", skillId: "skill-1" },
        { expectedHash: "sha256:old" },
      ],
      [
        SkillGlobalRenameInput,
        { environmentId: "environment-1", skillId: "skill-1", key: "new-key" },
        { expectedHash: "sha256:old" },
      ],
      [
        SkillGlobalRollbackInput,
        { environmentId: "environment-1", skillId: "skill-1", revision: 2 },
        { expectedHash: "sha256:old" },
      ],
      [SkillProjectSetDisabledInput, { projectId: "project-1", key: "release-notes" }],
      [SkillProjectDeleteStateInput, { projectId: "project-1", key: "release-notes" }],
      [
        SkillProjectRenameInput,
        { projectId: "project-1", skillId: "skill-1", key: "new-key" },
        { expectedHash: "sha256:old" },
      ],
      [
        SkillSessionSetEnabledInput,
        {
          threadId: "thread-1",
          providerInstanceId: "codex",
          key: "release-notes",
          enabled: true,
        },
      ],
      [
        SkillSessionResetInput,
        { threadId: "thread-1", providerInstanceId: "codex", key: "release-notes" },
      ],
      [
        SkillNativeImportInput,
        {
          environmentId: "environment-1",
          observationId: "observation-1",
          key: "release-notes",
        },
      ],
    ] as const;

    for (const [schema, input, concurrency = { expectedRevision: 4 }] of mutationCases) {
      expect(Schema.is(schema)(input)).toBe(false);
      expect(Schema.is(schema)({ ...input, ...concurrency })).toBe(true);
    }
  });
});
