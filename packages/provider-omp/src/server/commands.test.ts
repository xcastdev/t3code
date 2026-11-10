import { describe, expect, it } from "@effect/vitest";
import { availableCommands, assertAllowedPrompt } from "./commands.ts";
describe("OMP native command policy", () => {
  it("preserves workspace commands but rejects excluded dispatch including aliases and nested commands", () => {
    const commands = [
      { name: "ship", source: "skill", aliases: ["deploy"] },
      { name: "task", source: "builtin", aliases: ["jobs"] },
      { name: "settings", source: "builtin" },
      { name: "stats", source: "builtin", aliases: ["dashboard"] },
      { name: "stats", source: "custom" },
      { name: "report", source: "file", aliases: ["stats"] },
      { name: "colliding", source: "custom", aliases: ["dashboard"] },
    ];
    expect(availableCommands(commands).map((c) => c.name)).toEqual(["ship"]);
    expect(() => assertAllowedPrompt("/jobs launch", commands)).toThrow();
    expect(() => assertAllowedPrompt("/settings approval yolo", commands)).toThrow();
    expect(() => assertAllowedPrompt("/unknown", commands)).toThrow();
    for (const prompt of [
      "/stats --host 0.0.0.0 --port 0",
      "/report",
      "/dashboard",
      "/colliding",
    ]) {
      expect(() => assertAllowedPrompt(prompt, commands)).toThrow();
      expect(() => assertAllowedPrompt(prompt, [...commands].reverse())).toThrow();
    }
    expect(
      availableCommands(
        ["help", "compact", "clear", "status", "copy", "dump"].map((name) => ({
          name,
          source: "builtin",
        })),
      ).map((c) => c.name),
    ).toEqual(["compact", "dump"]);
    expect(() => assertAllowedPrompt("/deploy production", commands)).not.toThrow();
    expect(() => assertAllowedPrompt("Explain /task without executing it", commands)).not.toThrow();
  });
});
