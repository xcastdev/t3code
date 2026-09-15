import { describe, expect, it } from "vite-plus/test";

import { expandOpenCodeCommandTemplate } from "./OpenCodeCommand.ts";

describe("expandOpenCodeCommandTemplate", () => {
  it("expands quoted positional arguments and a final argument tail", () => {
    expect(
      expandOpenCodeCommandTemplate('/inspect src/a.ts "two words" extra', [
        { name: "inspect", template: "Inspect $1, then check $2" },
      ]),
    ).toBe("Inspect src/a.ts, then check two words extra");
  });
});
