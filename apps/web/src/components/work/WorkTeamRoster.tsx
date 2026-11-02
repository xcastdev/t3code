import type { ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import { PROJECT_TEAM_PRESETS, type ProjectWorkTaskId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { WorkMemberAvatar } from "./WorkMemberAvatar";
import { WorkStatus } from "./WorkStatus";
import { WorkSection, WorkMeta, WorkEmpty } from "./WorkLayout";
import { WorkRecordsNotice, WorkNotice } from "./WorkNotice";
import { WorkTaskLink } from "./WorkTaskRefs";
import { useWorkTeamRoster } from "./useWorkTeamRoster";
import { recordedTeamConfiguration } from "./workLogic";
import { PencilIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useWorkProviderCatalog } from "./useWorkProviderCatalog";
import { workRouteLabel } from "./workLogic";
import { workStateLabel } from "./workModel";

const MEMORY_LABELS = { none: "No memory", project: "Project", shared: "Shared" } as const;
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function WorkTeamMembers({
  scope,
  compact = false,
  onOpenTask,
  onEditMember,
}: {
  scope: ProjectWorkScope;
  compact?: boolean;
  onOpenTask: (id: ProjectWorkTaskId) => void;
  /** Absent while the team can't be changed here; each card then hides its edit button. */
  onEditMember?: (role: string) => void;
}) {
  const { roster, members, roles, view, records } = useWorkTeamRoster(scope);
  const catalog = useWorkProviderCatalog(scope.environmentId);
  /** Provider, model and effort, e.g. "Claude · Claude Opus 5.5 · High". */
  const routeLabel = (profile: NonNullable<(typeof roster)[number]["profile"]>) =>
    workRouteLabel(catalog, {
      // Roles from before members chose a provider ran on their model's team policy.
      providerInstanceId:
        profile.providerInstanceId ??
        records
          .flatMap((record) => (record.kind === "limits" && "model" in record ? [record] : []))
          .filter((record) => record.model === profile.model)
          // A disabled team keeps its policies disabled; the newest still names its provider.
          .sort((a, b) => b.generation - a.generation)[0]?.providerInstanceId,
      model: profile.model,
      options: profile.options,
    });
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
        <div className="grid min-w-0 gap-3 @xl/work:grid-cols-2 @4xl/work:grid-cols-3 @6xl/work:grid-cols-4">
          {roster.map((member) => {
            const profile = member.profile;
            const specialty =
              PROJECT_TEAM_PRESETS[member.role as keyof typeof PROJECT_TEAM_PRESETS]?.specialty;
            return (
              <article
                key={member.recordId}
                data-agent-card=""
                className="flex min-w-0 flex-col rounded-xl border border-border/70 bg-card shadow-xs"
              >
                <div className="flex min-w-0 items-start gap-3 p-4 pb-3">
                  <WorkMemberAvatar member={member} large play />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-sm font-semibold">{member.name}</h3>
                      {member.coordinator ? (
                        <Badge size="sm" variant="info">
                          Leads
                        </Badge>
                      ) : null}
                    </div>
                    <WorkMeta className="truncate">{workStateLabel(member.role)}</WorkMeta>
                  </div>
                  <span className="shrink-0 pt-0.5">
                    <WorkStatus
                      state={member.activity.state}
                      label={member.activity.label}
                      tone={member.activity.tone}
                    />
                  </span>
                  {onEditMember ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="-me-1.5 -mt-0.5 shrink-0"
                            aria-label={`Edit ${member.name}`}
                            onClick={() => onEditMember(member.role)}
                          />
                        }
                      >
                        <PencilIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Edit {member.name}</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
                {specialty ? (
                  <p className="line-clamp-2 min-h-[2lh] px-4 text-xs leading-relaxed text-muted-foreground">
                    {specialty}
                  </p>
                ) : null}
                <dl className="mx-4 mt-3 mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border/50 pt-3 text-xs">
                  <dt className="text-muted-foreground">Model</dt>
                  <dd className="m-0 truncate text-foreground/85">
                    {profile ? routeLabel(profile) : "Unavailable"}
                  </dd>
                  <dt className="text-muted-foreground">Memory</dt>
                  <dd className="m-0 truncate text-foreground/85">
                    {profile
                      ? (MEMORY_LABELS[profile.memoryAccess as keyof typeof MEMORY_LABELS] ??
                        workStateLabel(profile.memoryAccess))
                      : "Unknown"}
                  </dd>
                  {profile ? (
                    <>
                      <dt className="text-muted-foreground">Access</dt>
                      <dd className="m-0 truncate text-foreground/85">
                        {[
                          countLabel(profile.tools.length, "tool"),
                          countLabel(profile.skills.length, "skill"),
                          `depth ${profile.delegationDepth}`,
                        ].join(" · ")}
                      </dd>
                    </>
                  ) : null}
                </dl>
                {/* The footer is the member's task; their status sits in the header. */}
                <div className="mt-auto flex min-h-11 min-w-0 items-center border-t border-border/50 px-2 py-1.5">
                  {member.taskId ? (
                    <WorkTaskLink
                      scope={scope}
                      taskId={member.taskId as ProjectWorkTaskId}
                      onOpen={onOpenTask}
                    />
                  ) : (
                    <WorkMeta className="px-2">No task</WorkMeta>
                  )}
                </div>
              </article>
            );
          })}
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
