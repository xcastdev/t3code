import { describe, expect, it } from "vite-plus/test";

import { expandOpenCodeCommandTemplate } from "./OpenCodeCommand.ts";

const commands = [
  { name: "review", template: "Review $ARGUMENTS" },
  { name: "inspect", template: "Inspect $1, then check $2" },
  { name: "reordered", template: "First $2, then $1" },
  { name: "tail", template: "Files: $1 $2" },
  { name: "plain", template: "Run the plain command" },
];

describe("expandOpenCodeCommandTemplate", () => {
  it("uses all remaining argument text for $ARGUMENTS", () => {
    expect(expandOpenCodeCommandTemplate('/review src/a.ts "two words"', commands)).toBe(
      'Review src/a.ts "two words"',
    );
  });

  it("parses quoted positional arguments and gives the final position the tail", () => {
    expect(expandOpenCodeCommandTemplate('/inspect src/a.ts "two words" extra', commands)).toBe(
      "Inspect src/a.ts, then check two words extra",
    );
  });

  it("gives the highest positional argument the remaining tail", () => {
    expect(expandOpenCodeCommandTemplate('/reordered src/a.ts "two words" extra', commands)).toBe(
      "First two words extra, then src/a.ts",
    );
  });

  it("appends non-empty arguments when a template has no placeholders", () => {
    expect(expandOpenCodeCommandTemplate("/plain with context", commands)).toBe(
      "Run the plain command\n\nwith context",
    );
    expect(expandOpenCodeCommandTemplate("/plain", commands)).toBe("Run the plain command");
  });

  it("leaves empty, unknown, and non-leading commands unchanged", () => {
    expect(expandOpenCodeCommandTemplate("", commands)).toBe("");
    expect(expandOpenCodeCommandTemplate("/missing input", commands)).toBe("/missing input");
    expect(expandOpenCodeCommandTemplate("Please run /review", commands)).toBe(
      "Please run /review",
    );
  });
});
