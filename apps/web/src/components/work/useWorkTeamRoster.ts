import { asProjectTeamRecord, type ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import { deriveWorkRoster, workRosterComplete } from "@t3tools/client-runtime/project-work-team";
import type { ProjectTeamRecordRead } from "@t3tools/contracts";
import { useWorkRecords } from "./useWorkRecords";
import { useWorkRead } from "./useWorkRead";
import { memberAvatarIdentity } from "./workTeamView";

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
  const roster = deriveWorkRoster({
    records,
    summary,
    complete: workRosterComplete({
      summaryReady: view.status === "ready",
      sets: [limits, roles, members],
      summary,
    }),
    decorate: (member, recorded) =>
      memberAvatarIdentity(member.role, recorded.name, recorded.avatar),
  });
  return { limits, roles, members, records, roster, summary, view };
}
