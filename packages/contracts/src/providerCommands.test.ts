import { describe, expect, it } from "vite-plus/test";

import { expandOpenCodeCommandTemplate } from "./providerCommands.ts";

const commands = [
  { name: "review", template: "Review $ARGUMENTS" },
  { name: "reordered", template: "First $2, then $1" },
];

describe("expandOpenCodeCommandTemplate", () => {
  it("expands the command and preserves the authored argument text", () => {
    expect(expandOpenCodeCommandTemplate('/review src/a.ts "two words"', commands)).toBe(
      'Review src/a.ts "two words"',
    );
  });

  it("uses the highest positional argument as the remaining tail", () => {
    expect(expandOpenCodeCommandTemplate('/reordered src/a.ts "two words" extra', commands)).toBe(
      "First two words extra, then src/a.ts",
    );
  });

  it("leaves unknown and non-leading commands unchanged", () => {
    expect(expandOpenCodeCommandTemplate("/missing input", commands)).toBe("/missing input");
    expect(expandOpenCodeCommandTemplate("Please run /review", commands)).toBe(
      "Please run /review",
    );
  });
});
