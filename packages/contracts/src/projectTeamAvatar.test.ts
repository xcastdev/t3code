import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { expect, it } from "vite-plus/test";
import { ProjectTeamAvatar } from "./projectTeams.ts";

const decode = Schema.decodeUnknownOption(ProjectTeamAvatar);
const avatar = {
  kind: "generated",
  version: 1,
  seed: 0,
  tone: "paper",
  expression: "curious",
  motion: true,
};

it("accepts the full unsigned seed range and rejects malformed avatar data", () => {
  expect(Option.isSome(decode(avatar))).toBe(true);
  expect(Option.isSome(decode({ ...avatar, seed: 4_294_967_295 }))).toBe(true);
  for (const patch of [
    { seed: -1 },
    { seed: 4_294_967_296 },
    { seed: 1.5 },
    { version: 2 },
    { tone: "url(https://example.invalid)" },
    { expression: "unknown" },
    { motion: "yes" },
  ]) {
    expect(Option.isNone(decode({ ...avatar, ...patch }))).toBe(true);
  }
});
