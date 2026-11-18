import type { memberWithProfile } from "@t3tools/client-runtime/project-work-team";
import { PROJECT_TEAM_PRESETS, type ProjectTeamAvatar } from "@t3tools/contracts";
import { deriveProjectIdentity } from "../../projectIdentity";

export function memberAvatarIdentity(
  role: string,
  name: string,
  avatar?: ProjectTeamAvatar | null,
) {
  const preset = PROJECT_TEAM_PRESETS[role as keyof typeof PROJECT_TEAM_PRESETS];
  const identity = { monogram: preset?.roleMonogram ?? "?", color: preset?.color ?? "gray" };
  return {
    color: identity.color,
    avatar,
    monogram:
      name === role || !name.trim()
        ? identity.monogram
        : name === preset?.name
          ? preset.monogram
          : deriveProjectIdentity(name).monogram,
  };
}
export type WorkMemberView = Omit<ReturnType<typeof memberWithProfile>, "avatar"> &
  ReturnType<typeof memberAvatarIdentity>;
