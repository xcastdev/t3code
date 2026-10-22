import { assert, it } from "@effect/vitest";
import {
  ManagedSkillId,
  ManagedSkillKey,
  ProjectId,
  SkillContentHash,
  ThreadId,
} from "@t3tools/contracts";
import {
  composeInstructionSnapshot,
  type CompositionInput,
} from "./ResourceInstructionComposition.ts";
import type { PreparedSkillResource } from "../skills/SkillCatalogService.ts";

const input: CompositionInput = {
  projectId: ProjectId.make("project"),
  resourceRoot: "/project",
  threadId: ThreadId.make("thread"),
  providerInstanceId: "codex",
  configuration: { skillIds: ["review"], toolIds: ["read"], runtimeVersion: "native" },
  roleRevisionId: "role",
  roleRevision: 1,
  roleInstructions: "Review the change",
};
const skill: PreparedSkillResource = {
  id: ManagedSkillId.make("skill-review"),
  key: ManagedSkillKey.make("review"),
  hash: SkillContentHash.make("a".repeat(64)),
  revision: 1,
  body: "Check ownership fences",
  packagePath: "/managed/review",
};
it("captures verified bodies and hashes while leaving unrelated discovery independent", () => {
  const first = composeInstructionSnapshot(input, [
    skill,
    { ...skill, id: ManagedSkillId.make("native"), key: ManagedSkillKey.make("native") },
  ]);
  assert.include(first.roleInstructions, skill.body);
  assert.include(first.roleInstructions, skill.hash);
  assert.notInclude(first.roleInstructions, "Managed skill native");
  const changed = composeInstructionSnapshot(input, [
    {
      ...skill,
      hash: SkillContentHash.make("b".repeat(64)),
      revision: 2,
      body: "Check new behavior",
    },
  ]);
  assert.notEqual(first.resourceRevision, changed.resourceRevision);
  assert.notEqual(first.configurationHash, changed.configurationHash);
  assert.include(first.roleInstructions, "Check ownership fences");
  assert.isTrue(Object.isFrozen(first));
  assert.isTrue(Object.isFrozen(first.skillIds));
});
it("rejects missing, ambiguous and duplicate selections", () => {
  assert.throws(() => composeInstructionSnapshot(input, []));
  assert.throws(() =>
    composeInstructionSnapshot(input, [skill, { ...skill, id: ManagedSkillId.make("other") }]),
  );
  assert.throws(() =>
    composeInstructionSnapshot(
      { ...input, configuration: { ...input.configuration, skillIds: [skill.id, skill.key] } },
      [skill],
    ),
  );
});
it("binds exact delivered text even when the supplied hash is inconsistent", () => {
  const first = composeInstructionSnapshot(input, [skill]);
  const changed = composeInstructionSnapshot(input, [{ ...skill, body: "Changed body" }]);
  assert.notEqual(first.configurationHash, changed.configurationHash);
});
