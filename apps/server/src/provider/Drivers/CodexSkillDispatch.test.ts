import { describe, expect, it } from "vite-plus/test";

import { dispatchCodexComposerSkills } from "./CodexSkillDispatch.ts";

const skills = [
  { name: "review", path: "/project/.agents/skills/review/SKILL.md" },
  { name: "implement", path: "/home/user/.codex/skills/implement/SKILL.md" },
];

describe("dispatchCodexComposerSkills", () => {
  it("passes T3 skill selections as structured Codex skill references", () => {
    expect(dispatchCodexComposerSkills("Please !review this diff", skills)).toEqual({
      prompt: "Please !review this diff",
      skills: [skills[0]],
    });
  });

  it("supports more than one selected skill and deduplicates repeats", () => {
    expect(dispatchCodexComposerSkills("!review !implement !review", skills).skills).toEqual(
      skills,
    );
  });

  it("rejects raw Codex skill syntax without changing the prompt", () => {
    expect(dispatchCodexComposerSkills("Use $review on this diff", skills)).toEqual({
      prompt: "Use $review on this diff",
      skills: [],
      rawSkillMention: "review",
    });
  });

  it("does not reject unknown dollar mentions, shell variables, or amounts", () => {
    const prompt = "Read $HOME, use $unknown, and keep the budget under $20.";
    expect(dispatchCodexComposerSkills(prompt, skills)).toEqual({ prompt, skills: [] });
  });

  it("leaves unknown T3 skill names in the prompt without creating a skill input", () => {
    expect(dispatchCodexComposerSkills("Try !missing", skills)).toEqual({
      prompt: "Try !missing",
      skills: [],
    });
  });
});
