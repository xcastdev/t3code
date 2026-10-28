import { asProjectTeamRecord, type ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import type { ProjectTeamRecordRead } from "@t3tools/contracts";
import { useWorkRecords } from "./useWorkRecords";
import { useWorkRead } from "./useWorkRead";
import { TEAM_ROLES, type TeamRole } from "./workLogic";
import { memberActivity, memberIdentity } from "./workTeamView";

export function useWorkTeamRoster(scope: ProjectWorkScope) {
  const limits = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "limits",
  });
  const roles = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "role-revision",
  });
  const members = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "member",
  });
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "supervision",
  });
  const rawSummary = view.special?.operation === "supervision" ? view.special.value : null;
  const summary = rawSummary?.availability === "available" ? rawSummary : null;
  const records = [limits, roles, members].flatMap((set) =>
    set.records.flatMap((value): ProjectTeamRecordRead[] => {
      const record = asProjectTeamRecord(value);
      return record ? [record] : [];
    }),
  );
  const roster = records
    .filter(
      (r): r is Extract<ProjectTeamRecordRead, { kind: "member" }> =>
        r.kind === "member" && r.status !== "retired",
    )
    .map((member) => {
      const bindings = (summary?.bindings.items ?? [])
        .filter((b) => "memberId" in b && b.memberId === member.recordId)
        .flatMap((b) => ("taskId" in b ? [{ status: b.status, taskId: b.taskId }] : []));
      const complete =
        view.status === "ready" &&
        [limits, roles, members].every(
          (set) => set.complete && set.status === "ready" && set.revision === summary?.revision,
        ) &&
        summary !== null &&
        !summary.bindings.hasMore &&
        summary.bindings.items.every((b) => "memberId" in b);
      const activity = memberActivity(
        member.status,
        bindings,
        (summary?.questions.items ?? []).flatMap((q) => ("taskId" in q ? [q.taskId] : [])),
        complete,
      );
      return {
        ...memberIdentity(member, records),
        activity,
        taskId: bindings.find((b) =>
          ["running", "reserved", "stopping", "quarantined"].includes(b.status),
        )?.taskId,
      };
    });
  roster.sort((a, b) => {
    const rank = (role: string) => {
      const index = TEAM_ROLES.indexOf(role as TeamRole);
      return index < 0 ? TEAM_ROLES.length : index;
    };
    return rank(a.role) - rank(b.role) || a.name.localeCompare(b.name);
  });
  return { limits, roles, members, records, roster, summary, view };
}
