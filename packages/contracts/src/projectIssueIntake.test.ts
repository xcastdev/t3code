import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectIssueIdentity,
  ProjectIssueIntake,
  ProjectIssueRepositoryBindInput,
  ProjectIssueRepositoryBindReceipt,
  ProjectIssueRepositoryBindingsRead,
} from "./projectIssueIntake.ts";

const decodeIdentity = Schema.decodeUnknownSync(ProjectIssueIdentity);
const decodeIssue = Schema.decodeUnknownSync(ProjectIssueIntake);
it("uses immutable node identity independently of display repository name", () => {
  const identity = decodeIdentity({
    host: "github.com",
    repositoryNodeId: "repo-node",
    issueNodeId: "issue-node",
    number: 1,
  });
  const issue = {
    kind: "issue",
    recordId: "issue",
    projectId: "project",
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    identity,
    repositoryName: "owner/old",
    title: "Reminder",
    body: "",
    sourceRevision: "1",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(decodeIssue({ ...issue, repositoryName: "owner/new" }).identity).toEqual(identity);
  expect(() => decodeIssue({ ...issue, body: "x".repeat(32001) })).toThrow();
  expect(() => decodeIdentity({ ...identity, number: 0 })).toThrow();
});

it("bounds explicit human repository binding revisions and immutable identities", () => {
  const decode = Schema.decodeUnknownSync(ProjectIssueRepositoryBindInput);
  const input = {
    projectId: "project",
    expectedRepositoryKey: { host: "github.com", repositoryNodeId: "R_repo" },
    expectedTargetBindingRevision: null,
    accountLogin: "alice",
  };
  expect(decode(input)).toEqual(input);
  expect(
    decode({
      ...input,
      expectedTargetBindingRevision: Number.MAX_SAFE_INTEGER,
      previous: { key: input.expectedRepositoryKey, expectedBindingRevision: 0 },
    }).previous?.expectedBindingRevision,
  ).toBe(0);
  for (const patch of [
    { expectedTargetBindingRevision: -1 },
    { expectedTargetBindingRevision: 0.5 },
    { expectedTargetBindingRevision: Number.MAX_SAFE_INTEGER + 1 },
    { accountLogin: "" },
    { accountLogin: "alice; gh auth switch" },
    { accountLogin: "a".repeat(40) },
    { expectedRepositoryKey: { host: "https://github.com", repositoryNodeId: "R_repo" } },
    { expectedRepositoryKey: { host: "github.com", repositoryNodeId: "x".repeat(1025) } },
    { previous: { key: input.expectedRepositoryKey, expectedBindingRevision: -1 } },
  ])
    expect(() => decode({ ...input, ...patch })).toThrow();
  expect(
    Schema.decodeUnknownSync(ProjectIssueRepositoryBindReceipt)({
      ...input.expectedRepositoryKey,
      bindingRevision: 1,
      status: "ready",
    }),
  ).toEqual({ ...input.expectedRepositoryKey, bindingRevision: 1, status: "ready" });
});

it("returns bounded persisted binding history without credential fields", () => {
  const decode = Schema.decodeUnknownSync(ProjectIssueRepositoryBindingsRead);
  const binding = {
    host: "github.com",
    repositoryNodeId: "R_repo",
    bindingRevision: 0,
    status: "detached",
    repositoryName: "owner/repo",
    accountLogin: "alice",
  };
  expect(decode({ items: Array.from({ length: 32 }, () => binding) }).items).toHaveLength(32);
  expect(() => decode({ items: Array.from({ length: 33 }, () => binding) })).toThrow();
  expect(
    decode({ items: [{ ...binding, token: "sensitive", credentialEpoch: "private" }] }),
  ).toEqual({
    items: [binding],
  });
});
