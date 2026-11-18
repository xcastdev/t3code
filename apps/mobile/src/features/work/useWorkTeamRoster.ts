import { asProjectTeamRecord, type ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import { deriveWorkRoster, workRosterComplete } from "@t3tools/client-runtime/project-work-team";
import type { ProjectTeamRecordRead } from "@t3tools/contracts";

import { useWorkRead } from "./useWork";
import { useWorkRecords } from "./useWorkRecords";

/** The team's records, its supervision summary and the members with what each is doing. */
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
  });
  return { limits, roles, members, records, roster, rawSummary, summary, view };
}
export type WorkRosterMember = ReturnType<typeof useWorkTeamRoster>["roster"][number];
