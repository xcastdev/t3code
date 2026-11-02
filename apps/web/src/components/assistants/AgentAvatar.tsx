import { AGENT_AVATAR_MOODS, AGENT_AVATAR_TONES } from "@t3tools/client-runtime/project-work";
import type { ProjectTeamAvatar } from "@t3tools/contracts";

import { deriveProjectIdentity } from "../../projectIdentity";
import { WorkMemberAvatar } from "../work/WorkMemberAvatar";

export function agentInitials(name: string) {
  return deriveProjectIdentity(name.trim() || "Agent");
}

const randomIndex = (length: number) => crypto.getRandomValues(new Uint32Array(1))[0]! % length;

/** A fresh face for a new agent, so agents don't all start out looking alike. */
export function newAgentAvatar(): ProjectTeamAvatar {
  const tones = Object.keys(AGENT_AVATAR_TONES) as Array<keyof typeof AGENT_AVATAR_TONES>;
  const moods = Object.keys(AGENT_AVATAR_MOODS) as Array<keyof typeof AGENT_AVATAR_MOODS>;
  return {
    kind: "generated",
    version: 1,
    seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
    tone: tones[randomIndex(tones.length)]!,
    expression: moods[randomIndex(moods.length)]!,
    motion: true,
  };
}

export function AgentAvatar({
  agent,
  size,
}: {
  readonly agent: { readonly name: string; readonly avatar?: ProjectTeamAvatar | undefined };
  readonly size?: "icon" | "row" | "card";
}) {
  return (
    <WorkMemberAvatar member={{ ...agentInitials(agent.name), avatar: agent.avatar }} size={size} />
  );
}
