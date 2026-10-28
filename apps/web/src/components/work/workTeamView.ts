import {
  PROJECT_TEAM_PRESETS,
  type ProjectTeamRecordRead,
  type ProjectTeamAvatar,
} from "@t3tools/contracts";
import { deriveProjectIdentity } from "../../projectIdentity";
import { workStateLabel } from "./workModel";
import type { WorkTone } from "./workPresentation";

export function memberIdentity(
  member: Extract<ProjectTeamRecordRead, { kind: "member" }>,
  records: ReadonlyArray<ProjectTeamRecordRead>,
) {
  const profile = records.find(
    (r): r is Extract<ProjectTeamRecordRead, { kind: "role-revision" }> =>
      r.kind === "role-revision" && r.recordId === member.roleRevisionId,
  );
  const role = profile?.role ?? "unknown";
  return {
    ...member,
    name: member.name === role ? workStateLabel(role) : member.name,
    role,
    profile,
    ...memberAvatarIdentity(role, member.name, member.avatar),
  };
}
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
export type WorkMemberView = ReturnType<typeof memberIdentity>;

export function memberActivity(
  configured: string,
  bindings: ReadonlyArray<{ status: string; taskId: string }>,
  questionTaskIds: ReadonlyArray<string>,
  complete: boolean,
): { state: string; label: string; tone: WorkTone } {
  if (bindings.some((b) => b.status === "quarantined"))
    return { state: "recovery", label: "Needs recovery", tone: "error" };
  if (bindings.some((b) => b.status === "stopping"))
    return { state: "stopping", label: "Stopping", tone: "warning" };
  const live = bindings.filter((b) => b.status === "running" || b.status === "reserved");
  if (live.some((b) => questionTaskIds.includes(b.taskId)))
    return { state: "waiting", label: "Waiting for you", tone: "warning" };
  if (live.length > 0)
    return {
      state: "running",
      label: live.some((b) => b.status === "running") ? "Working" : "Starting",
      tone: "info",
    };
  if (configured === "paused" || configured === "retired")
    return { state: configured, label: workStateLabel(configured), tone: "secondary" };
  if (
    !complete ||
    configured !== "active" ||
    bindings.some((b) => !["settled", "revoked"].includes(b.status))
  )
    return { state: "unknown", label: "Status unknown", tone: "secondary" };
  return { state: "available", label: "Available", tone: "secondary" };
}
