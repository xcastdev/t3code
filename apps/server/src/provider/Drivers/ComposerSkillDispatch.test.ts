import { describe, expect, it } from "vite-plus/test";

import { dispatchComposerSlashSkill, findComposerSkillMentions } from "./ComposerSkillDispatch.ts";

describe("composer skill dispatch", () => {
  const skills = new Set(["review", "implement", "2spec"]);

  it("finds complete skill tokens at any prompt position", () => {
    expect(findComposerSkillMentions("Use !review then !2spec").map((item) => item.name)).toEqual([
      "review",
      "2spec",
    ]);
    expect(findComposerSkillMentions("5!review and !review!")).toEqual([]);
  });

  it("moves a selected skill to the front for slash command providers", () => {
    expect(dispatchComposerSlashSkill("inspect auth with !review", skills)).toBe(
      "/review inspect auth with",
    );
  });

  it("leaves unknown names literal", () => {
    expect(dispatchComposerSlashSkill("keep !notice literal", skills)).toBe("keep !notice literal");
  });
});
