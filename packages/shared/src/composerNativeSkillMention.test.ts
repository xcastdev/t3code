import { describe, expect, it } from "vite-plus/test";

import { findRawNativeSkillMention } from "./composerNativeSkillMention.ts";

describe("findRawNativeSkillMention", () => {
  const skills = new Set(["review"]);

  it("finds a known raw Codex skill reference", () => {
    expect(findRawNativeSkillMention("Use $review here", skills)).toBe("review");
  });

  it("leaves unknown names and shell variables alone", () => {
    expect(findRawNativeSkillMention("Keep $HOME and $unknown", skills)).toBeUndefined();
  });
});
