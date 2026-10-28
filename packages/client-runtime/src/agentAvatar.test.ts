import { expect, it } from "vite-plus/test";
import { PROJECT_TEAM_PRESETS, type ProjectTeamAvatar } from "@t3tools/contracts";
import {
  agentFace,
  generateAgentAvatar,
  sameAgentAvatar,
  switchAgentAvatarMode,
} from "./agentAvatar.ts";

const avatar: ProjectTeamAvatar = {
  kind: "generated",
  version: 1,
  seed: 0,
  tone: "paper",
  expression: "curious",
  motion: true,
};

it("keeps saved faces stable and independent of names or motion", () => {
  expect(agentFace(avatar)).toEqual(agentFace({ ...avatar, motion: false }));
  expect(agentFace(avatar)).toMatchObject({
    traits: { head: 0, accessory: 0, eyes: 0 },
    head: [{ kind: "rect", x: 8, y: 10, width: 24, height: 22, rx: 7, fill: "#F4F1EA" }],
    mouth: [
      {
        kind: "circle",
        cx: 20,
        cy: 26.5,
        r: 1.6,
        fill: "none",
        stroke: "#1E2230",
        strokeWidth: 1.75,
      },
    ],
  });
  expect(agentFace({ ...avatar, seed: 65_537, tone: "sand" })).toMatchObject({
    traits: { head: 2, accessory: 1, eyes: 1 },
    head: [{ kind: "rect", x: 6, y: 12, width: 28, height: 19, rx: 9.5, fill: "#EBD9BC" }],
  });
});

it("regenerates only the seed and avoids both the old face and other team members", () => {
  const seeds = [0, 65_537, 131_074];
  const generated = generateAgentAvatar(
    avatar,
    [{ ...avatar, seed: 65_537 }],
    () => seeds.shift() ?? 7,
  );
  expect(generated).toEqual({ ...avatar, seed: 131_074 });
  let calls = 0;
  generateAgentAvatar(avatar, [], () => {
    calls++;
    return 0;
  });
  expect(calls).toBe(8);
});

it("stashes faces when switching to initials and restores them without changing overrides", () => {
  const initial = switchAgentAvatarMode(avatar, null, { ...avatar, seed: 65_537 }, "initials");
  expect(initial).toEqual({ avatar: null, stashed: avatar });
  expect(
    switchAgentAvatarMode(initial.avatar, initial.stashed, { ...avatar, seed: 65_537 }, "face")
      .avatar,
  ).toEqual(avatar);
  expect(sameAgentAvatar(undefined, null)).toBe(true);
  expect(sameAgentAvatar(avatar, { ...avatar, motion: false })).toBe(false);
});

it("gives the predefined team six distinct faces", () => {
  const traits = Object.values(PROJECT_TEAM_PRESETS).map((p) =>
    JSON.stringify(agentFace(p.avatar).traits),
  );
  expect(new Set(traits).size).toBe(6);
});
