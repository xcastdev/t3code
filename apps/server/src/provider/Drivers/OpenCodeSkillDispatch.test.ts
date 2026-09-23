import { describe, expect, it } from "vite-plus/test";

import { selectedOpenCodeSkillInstructions } from "./OpenCodeSkillDispatch.ts";

describe("selectedOpenCodeSkillInstructions", () => {
  it("returns the selected skill body for local OpenCode", () => {
    expect(
      selectedOpenCodeSkillInstructions("inspect auth with !review", [
        { name: "review", content: "Check authorization boundaries." },
      ]),
    ).toBe('<selected_skill name="review">\nCheck authorization boundaries.\n</selected_skill>');
  });

  it("ignores unknown skill references", () => {
    expect(selectedOpenCodeSkillInstructions("keep !notice literal", [])).toBeUndefined();
  });
});
