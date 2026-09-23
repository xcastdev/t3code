import { assert, describe, it } from "@effect/vitest";

import {
  isOpenCodeManagedSkillPlanPayload,
  missingOpenCodeManagedSkills,
} from "./OpenCodeManagedSkills.ts";

describe("OpenCode managed skills", () => {
  it("requires a config directory in the provider plan", () => {
    assert.equal(
      isOpenCodeManagedSkillPlanPayload({
        kind: "opencode-managed-skills",
        root: "/runtime/session/.opencode-config/skills",
        configDir: "/runtime/session/.opencode-config",
        skillKeys: ["review"],
      }),
      true,
    );
    assert.equal(
      isOpenCodeManagedSkillPlanPayload({
        kind: "opencode-managed-skills",
        root: "/runtime/session",
        skillKeys: ["review"],
      }),
      false,
    );
  });

  it("requires the selected OpenCode definition to come from the managed source", () => {
    const plan = {
      kind: "opencode-managed-skills" as const,
      root: "/runtime/session/.opencode-config/skills",
      configDir: "/runtime/session/.opencode-config",
      skillKeys: ["review", "deploy"],
    };
    assert.deepEqual(
      missingOpenCodeManagedSkills(
        [
          { name: "review", location: "/native/review/SKILL.md" },
          { name: "deploy", location: "/runtime/session/.opencode-config/skills/deploy/SKILL.md" },
        ],
        plan,
      ),
      ["review"],
    );
  });
});
