import type { ProjectTeamAvatar } from "@t3tools/contracts";

export type AgentAvatarShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx: number; fill: string }
  | {
      kind: "circle";
      cx: number;
      cy: number;
      r: number;
      fill: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | { kind: "path"; d: string; fill: string; stroke: string; strokeWidth: number };

export const AGENT_AVATAR_TONES = {
  paper: { label: "Paper", fill: "#F4F1EA" },
  sand: { label: "Sand", fill: "#EBD9BC" },
  sage: { label: "Sage", fill: "#CFE3D3" },
  slate: { label: "Slate", fill: "#C9D2E0" },
} as const;
export const AGENT_AVATAR_MOODS = {
  smile: "Smile",
  focused: "Focused",
  curious: "Curious",
} as const;
const INK = "#1E2230";
const traitsFor = (seed: number) => ({
  head: seed % 3,
  accessory: (seed >>> 8) % 3,
  eyes: (seed >>> 16) % 3,
});
const traitKey = (avatar: ProjectTeamAvatar) => {
  const t = traitsFor(avatar.seed);
  return `${t.head}:${t.accessory}:${t.eyes}`;
};

// Version 1 geometry is persisted identity. New trait tables need a new avatar version.
export function agentFace(avatar: ProjectTeamAvatar) {
  const traits = traitsFor(avatar.seed);
  const fill = AGENT_AVATAR_TONES[avatar.tone].fill;
  const head: AgentAvatarShape[] =
    traits.head === 0
      ? [{ kind: "rect", x: 8, y: 10, width: 24, height: 22, rx: 7, fill }]
      : traits.head === 1
        ? [{ kind: "circle", cx: 20, cy: 21, r: 12, fill }]
        : [{ kind: "rect", x: 6, y: 12, width: 28, height: 19, rx: 9.5, fill }];
  const accessory: AgentAvatarShape[] =
    traits.accessory === 0
      ? [
          { kind: "path", d: "M20 11V5", fill: "none", stroke: "currentColor", strokeWidth: 1.75 },
          { kind: "circle", cx: 20, cy: 4.5, r: 2.2, fill: "currentColor" },
        ]
      : traits.accessory === 1
        ? [4, 32].map((x) => ({
            kind: "rect",
            x,
            y: 18,
            width: 4,
            height: 7,
            rx: 1.5,
            fill: "currentColor",
          }))
        : [];
  const y = avatar.expression === "curious" ? 19 : 20;
  const eyes: AgentAvatarShape[] = [15, 25].map((x) =>
    traits.eyes === 0
      ? { kind: "circle", cx: x, cy: y, r: 2.2, fill: INK }
      : traits.eyes === 1
        ? { kind: "rect", x: x - 1.5, y: y - 2.2, width: 3, height: 4.4, rx: 1.5, fill: INK }
        : { kind: "circle", cx: x, cy: y, r: 2.4, fill: "none", stroke: INK, strokeWidth: 1.5 },
  );
  const mouth: AgentAvatarShape[] =
    avatar.expression === "curious"
      ? [{ kind: "circle", cx: 20, cy: 26.5, r: 1.6, fill: "none", stroke: INK, strokeWidth: 1.75 }]
      : [
          {
            kind: "path",
            d: avatar.expression === "smile" ? "M16 25.5Q20 29 24 25.5" : "M16.5 26.5H23.5",
            fill: "none",
            stroke: INK,
            strokeWidth: 1.75,
          },
        ];
  return { traits, head, accessory, eyes, mouth };
}

export function generateAgentAvatar(
  avatar: ProjectTeamAvatar,
  avoid: ReadonlyArray<ProjectTeamAvatar>,
  nextSeed: () => number,
) {
  const occupied = new Set([avatar, ...avoid].map(traitKey));
  let candidate = avatar;
  for (let attempt = 0; attempt < 8; attempt++) {
    candidate = { ...avatar, seed: nextSeed() };
    if (!occupied.has(traitKey(candidate))) return candidate;
  }
  return candidate;
}

export function sameAgentAvatar(
  a: ProjectTeamAvatar | null | undefined,
  b: ProjectTeamAvatar | null | undefined,
) {
  if (a == null || b == null) return a == null && b == null;
  return (
    a.kind === b.kind &&
    a.version === b.version &&
    a.seed === b.seed &&
    a.tone === b.tone &&
    a.expression === b.expression &&
    a.motion === b.motion
  );
}

export function switchAgentAvatarMode(
  avatar: ProjectTeamAvatar | null | undefined,
  stashed: ProjectTeamAvatar | null,
  preset: ProjectTeamAvatar,
  mode: "face" | "initials",
) {
  return {
    avatar: mode === "initials" ? null : (avatar ?? stashed ?? preset),
    stashed: avatar ?? stashed,
  };
}
