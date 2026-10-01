import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ProjectTeamCredential,
  ProjectTeamWriteIntent,
  ProjectTeamRecord,
  ProjectTeamRecordRead,
  PROJECT_TEAM_DEFAULT_LIMITS,
} from "./projectTeams.ts";

const decodeCredential = Schema.decodeUnknownSync(ProjectTeamCredential);
const decodeIntent = Schema.decodeUnknownSync(ProjectTeamWriteIntent);
const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeTeamRecordRead = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const member = {
  kind: "member",
  recordId: "member",
  projectId: "project",
  revision: 0,
  generation: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "active",
  name: "Coordinator",
  coordinator: true,
  roleRevisionId: "role",
};
describe("team contracts", () => {
  it("preserves future read statuses while rejecting them for writes", () => {
    expect(decodeTeamRecordRead({ ...member, status: "sleeping" }).status).toBe("sleeping");
    expect(() => decodeTeamRecord({ ...member, status: "sleeping" })).toThrow();
  });
  it("bounds instructions and uses conservative product repair defaults", () => {
    expect(() => decodeTeamRecord({ ...member, name: "x".repeat(4001) })).toThrow();
    expect(PROJECT_TEAM_DEFAULT_LIMITS).toEqual({
      environmentModelCalls: 2,
      projectWritableWorkers: 1,
      delegationDepth: 2,
      repairAllowance: 2,
    });
  });
});

it("preserves safe metadata for unknown future record kinds", () => {
  expect(
    decodeTeamRecordRead({
      ...member,
      kind: "future-record",
      status: "future-state",
      payload: "Summary",
    }),
  ).toMatchObject({ kind: "future-record", status: "future-state", recordId: "member" });
  expect(() => decodeTeamRecord({ ...member, kind: "future-record" })).toThrow();
});

it("accepts an exact managed marker and only typed public gate responses", () => {
  const credential = {
    projectId: "project",
    bindingId: "binding",
    generation: 7,
    providerInstanceId: "pi",
    threadId: "thread",
  };
  expect(decodeCredential(credential)).toEqual(credential);
  expect(() => decodeCredential({ ...credential, generation: -1 })).toThrow();
  const intent = {
    type: "project-team.gate.respond",
    commandId: "response",
    projectId: "project",
    taskId: "task",
    expectedRevision: 1,
    expectedTaskRevision: 1,
    specRevision: 1,
    planRevision: 0,
    gateId: "gate",
    expectedGateRevision: 0,
    response: "approved",
  };
  expect(decodeIntent(intent)).toEqual(intent);
  expect(() => decodeIntent({ ...intent, response: "consumed" })).toThrow();
  expect(() => decodeIntent({ ...intent, expectedGateRevision: -1 })).toThrow();
});
