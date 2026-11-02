import type { ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import { PROJECT_TEAM_PRESETS, type ProjectWorkTaskId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { WorkMemberAvatar } from "./WorkMemberAvatar";
import { WorkStatus } from "./WorkStatus";
import { WorkSection, WorkMeta, WorkEmpty } from "./WorkLayout";
import { WorkRecordsNotice, WorkNotice } from "./WorkNotice";
import { WorkTaskLink } from "./WorkTaskRefs";
import { useWorkTeamRoster } from "./useWorkTeamRoster";
import { recordedTeamConfiguration } from "./workLogic";
import { workStateLabel } from "./workModel";

export function WorkTeamMembers({
  scope,
  compact = false,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  compact?: boolean;
  onOpenTask: (id: ProjectWorkTaskId) => void;
}) {
  const { roster, members, roles, view } = useWorkTeamRoster(scope);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WorkRecordsNotice set={members} subject="team members" />
      <WorkRecordsNotice set={roles} subject="role profiles" />
      {roster.length === 0 && members.complete ? (
        <WorkEmpty
          title="No team yet"
          detail="Set up a team to give each role a name and a model."
        />
      ) : null}
      {compact && roster.length > 0 ? (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
          {roster.map((member) => (
            <div
              key={member.recordId}
              data-agent-card=""
              className="flex min-w-0 items-center gap-2.5 border-border/50 px-3 py-2 not-first:border-t"
            >
              <WorkMemberAvatar member={member} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{member.name}</p>
                <WorkMeta className="truncate">{workStateLabel(member.role)}</WorkMeta>
              </div>
              <WorkStatus
                state={member.activity.state}
                label={member.activity.label}
                tone={member.activity.tone}
              />
            </div>
          ))}
        </div>
      ) : null}
      {compact ? null : (
        <div className="grid min-w-0 gap-3 @xl/work:grid-cols-2 @4xl/work:grid-cols-3">
          {roster.map((member) => (
            <article
              key={member.recordId}
              data-agent-card=""
              className={cn(
                "flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4",
                member.status === "paused" && "bg-muted/10",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <WorkMemberAvatar member={member} large={!compact} play={!compact} />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold">{member.name}</h3>
                  <WorkMeta>{workStateLabel(member.role)}</WorkMeta>
                </div>
                {member.coordinator && !compact ? (
                  <Badge size="sm" variant="outline">
                    Leads
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <WorkStatus
                  state={member.activity.state}
                  label={member.activity.label}
                  tone={member.activity.tone}
                />
                {!compact && member.status !== member.activity.state ? (
                  <WorkMeta>Member {workStateLabel(member.status).toLowerCase()}</WorkMeta>
                ) : null}
              </div>
              {!compact ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {
                    PROJECT_TEAM_PRESETS[member.role as keyof typeof PROJECT_TEAM_PRESETS]
                      ?.specialty
                  }
                </p>
              ) : null}
              {!compact ? (
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="break-words text-xs text-muted-foreground">
                    {member.profile?.model ?? "Model unavailable"}
                  </p>
                  <WorkMeta>
                    {member.profile?.memoryAccess === "none"
                      ? "No memory"
                      : `${workStateLabel(member.profile?.memoryAccess ?? "unknown")} memory`}
                  </WorkMeta>
                </div>
              ) : null}
              {member.taskId ? (
                <WorkTaskLink
                  scope={scope}
                  taskId={member.taskId as ProjectWorkTaskId}
                  onOpen={onOpenTask}
                />
              ) : null}
            </article>
          ))}
        </div>
      )}
      {view.status !== "ready" ? <WorkNotice view={view} subject="worker activity" /> : null}
    </div>
  );
}

export function WorkTeamRail({
  scope,
  onManage,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  onManage: () => void;
  onOpenTask: (id: ProjectWorkTaskId) => void;
}) {
  const { records, limits, roles, members } = useWorkTeamRoster(scope);
  const recorded = [limits, roles, members].every((set) => set.complete)
    ? recordedTeamConfiguration(records)
    : null;
  return (
    <WorkSection
      title="Your team"
      grouped={false}
      actions={
        <Button size="xs" variant="ghost" onClick={onManage}>
          Manage team
        </Button>
      }
    >
      {recorded?.kind === "configured" ? (
        <WorkMeta>
          {recorded.values.enabled ? "Team enabled" : "Team disabled"}. Workers start from approved
          tasks.
        </WorkMeta>
      ) : null}
      <WorkTeamMembers scope={scope} compact onOpenTask={onOpenTask} />
    </WorkSection>
  );
}
