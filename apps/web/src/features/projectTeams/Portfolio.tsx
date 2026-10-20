import {
  type EnvironmentId,
  type ProjectId,
  ProjectTeamSupervisionSummary,
  type ThreadId,
} from "@t3tools/contracts";

import * as Schema from "effect/Schema";
import { RefreshCwIcon } from "lucide-react";
import { useEffectEvent, useLayoutEffect, useRef } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkCard } from "../../components/work/WorkDataNotice";
import {
  WorkCounts,
  WorkDetails,
  WorkLabel,
  WorkSectionHeader,
} from "../../components/work/WorkLayout";
import {
  asProjectTeamBindingAccounting,
  projectTeamAccountingCaptions,
} from "@t3tools/client-runtime/project-work";

export interface PortfolioProps {
  readonly entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly connected: boolean;
    readonly enabled: boolean;
    readonly supported: boolean;
    readonly current: boolean;
    readonly snapshot?: {
      readonly environmentId: EnvironmentId;
      readonly data: ProjectTeamSupervisionSummary;
      readonly receivedAt: number;
    };
    readonly error?: string;
  }>;
  readonly now: number;
  readonly loading: boolean;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onRefresh: () => void;
  readonly onOpenProject: (target: { environmentId: EnvironmentId; projectId: ProjectId }) => void;
  readonly onOpenTask: (target: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    taskId: string;
  }) => void;
  readonly onOpenWorker: (target: {
    environmentId: EnvironmentId;
    projectId: ProjectId;
    threadId: ThreadId;
  }) => void;
}

type Entry = PortfolioProps["entries"][number];
type Summary = Extract<ProjectTeamSupervisionSummary, { availability: "available" }>;
const validSummary = Schema.is(ProjectTeamSupervisionSummary);
const PAGE_SIZE = 25;
const TASK_STATES = [
  "draft",
  "specified",
  "ready",
  "in-progress",
  "blocked",
  "in-review",
  "completed",
  "failed",
  "canceled",
  "unknown",
  "total",
] as const;

function receivedAge(now: number, receivedAt: number) {
  if (
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(receivedAt) ||
    receivedAt < 0 ||
    receivedAt > now
  )
    return null;
  const seconds = Math.floor((now - receivedAt) / 1_000);
  if (!Number.isFinite(seconds)) return null;
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)}m`
      : `${Math.floor(seconds / 3_600)}h`;
}

function entryView(entry: Entry, now: number, loading: boolean) {
  const snapshot = entry.snapshot;
  const ownerMatches =
    snapshot?.environmentId === entry.environmentId && snapshot.data.projectId === entry.projectId;
  const valid = ownerMatches && validSummary(snapshot.data);
  const data = valid ? snapshot.data : undefined;
  const age = snapshot ? receivedAge(now, snapshot.receivedAt) : null;
  const current =
    entry.connected &&
    entry.enabled &&
    entry.supported &&
    entry.current &&
    !loading &&
    entry.error === undefined &&
    age !== null &&
    data?.availability === "available";
  const notices = [
    !entry.connected ? "Disconnected" : null,
    !entry.enabled ? "Project Work is disabled" : null,
    !entry.supported ? "Supervision is unsupported" : null,
    loading ? "Loading summaries" : null,
    entry.error !== undefined
      ? `Read error: ${entry.error.slice(0, 240) || "No details recorded"}`
      : null,
    !snapshot
      ? "No summary received"
      : !ownerMatches
        ? "Snapshot owner mismatch"
        : !valid
          ? "Malformed summary metadata"
          : data?.availability !== "available"
            ? `Project ${data?.availability}`
            : null,
    snapshot && age === null ? "Invalid or future receive time" : null,
  ].filter(Boolean);
  return { data, current, age, notices };
}

type Profile = NonNullable<
  Extract<NonNullable<Summary["coordinator"]>, { name: string }>["profile"]
>;

function usableProfile(profile: Profile) {
  return (
    !("issue" in profile) && profile.supported && ["available", "retired"].includes(profile.status)
  );
}

function usableBinding(binding: Summary["bindings"]["items"][number]) {
  return (
    !("issue" in binding) &&
    binding.supported &&
    ["reserved", "running", "stopping", "settled", "revoked", "quarantined"].includes(
      binding.status,
    ) &&
    (!binding.profile || usableProfile(binding.profile))
  );
}

function usableQuestion(question: Summary["questions"]["items"][number]) {
  return (
    !("issue" in question) &&
    question.supported &&
    ["pending", "answered", "canceled"].includes(question.status)
  );
}

// Summaries carry blockers and question targets, but no task approval gates. Open the
// owning task or project to inspect its current policy before taking an action.
function nextActions(data: Summary) {
  return [
    ...data.blockers.items.map((blocker) => ({
      category: "blockers" as const,
      recordId: blocker.recordId,
      taskId: blocker.taskId,
      label: `Review blocker for ${blocker.taskId}: ${blocker.reason} · Resolver ${blocker.resolver}`,
    })),
    ...data.questions.items.flatMap((question) =>
      usableQuestion(question) && "taskId" in question && question.status === "pending"
        ? [
            {
              category: "questions" as const,
              recordId: question.recordId,
              taskId: question.taskId,
              label: `Inspect task with pending question for ${question.taskId} · Gate ${question.targetGateId}`,
            },
          ]
        : [],
    ),
  ];
}

/** Render bounded recorded metadata supplied by the owning environment; this view performs no reads. */
export function Portfolio(props: PortfolioProps) {
  const entries = props.entries.slice(0, PAGE_SIZE);
  const canPage = !props.loading;
  const canRead =
    canPage &&
    (entries.length === 0 ||
      entries.some((entry) => entry.connected && entry.enabled && entry.supported));
  const previous = useEffectEvent(() => {
    if (canPage && props.hasPrevious) props.onPrevious();
  });
  const next = useEffectEvent(() => {
    if (canPage && props.hasNext) props.onNext();
  });
  const refresh = useEffectEvent(() => {
    if (canRead) props.onRefresh();
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="space-y-1">
        <WorkSectionHeader
          title="Portfolio"
          description="What each project team is doing and what needs you next."
          actions={
            <Button size="sm" variant="outline" disabled={!canRead} onClick={() => refresh()}>
              <RefreshCwIcon aria-hidden />
              Refresh portfolio
            </Button>
          }
        />
        <p className="text-xs text-muted-foreground">
          Counts and binding states describe saved records; execution health is not verified here.
        </p>
        {props.loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading summaries…
          </p>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects in this page.</p>
      ) : null}
      {props.entries.length > PAGE_SIZE ? (
        <p className="text-sm text-muted-foreground">
          Showing 25 of {props.entries.length} projects. More projects require another page.
        </p>
      ) : null}
      {entries.map((entry) => (
        <PortfolioEntry
          key={JSON.stringify([entry.environmentId, entry.projectId])}
          entry={entry}
          props={props}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canPage || !props.hasPrevious}
          onClick={() => previous()}
        >
          Previous portfolio page
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canPage || !props.hasNext}
          onClick={() => next()}
        >
          Next portfolio page
        </Button>
      </div>
    </div>
  );
}

function PortfolioEntry({
  entry,
  props,
}: {
  readonly entry: Entry;
  readonly props: PortfolioProps;
}) {
  const view = entryView(entry, props.now, props.loading);
  const data = view.data?.availability === "available" ? view.data : undefined;
  const actions = data ? nextActions(data) : [];
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const project = useEffectEvent(() => {
    if (mounted.current)
      props.onOpenProject({ environmentId: entry.environmentId, projectId: entry.projectId });
  });
  // Recheck the latest committed owner, capability and record when a held control is used.
  const task = useEffectEvent(
    (category: "bindings" | "blockers" | "questions", recordId: string, taskId: string) => {
      if (!mounted.current || !view.current || !data) return;
      const matches = data[category].items.filter((item) => item.recordId === recordId);
      if (matches.length !== 1) return;
      const item = matches[0];
      if (!item || !("taskId" in item) || item.taskId !== taskId) return;
      if (
        category === "bindings" &&
        !data.bindings.items.some((binding) => binding === item && usableBinding(binding))
      )
        return;
      if (
        category === "questions" &&
        !data.questions.items.some((question) => question === item && usableQuestion(question))
      )
        return;
      props.onOpenTask({ environmentId: entry.environmentId, projectId: entry.projectId, taskId });
    },
  );
  const nextAction = useEffectEvent((action: ReturnType<typeof nextActions>[number]) => {
    if (!mounted.current || !view.current || !data) return;
    if (
      !nextActions(data).some(
        (current) =>
          current.category === action.category &&
          current.recordId === action.recordId &&
          current.taskId === action.taskId &&
          current.label === action.label,
      )
    )
      return;
    task(action.category, action.recordId, action.taskId);
  });
  const worker = useEffectEvent((recordId: string, threadId: ThreadId) => {
    if (!mounted.current || !view.current || !data) return;
    const matches = data.bindings.items.filter((binding) => binding.recordId === recordId);
    const binding = matches[0];
    if (
      matches.length !== 1 ||
      !binding ||
      !("workerThreadId" in binding) ||
      binding.workerThreadId !== threadId ||
      !usableBinding(binding)
    )
      return;
    props.onOpenWorker({
      environmentId: entry.environmentId,
      projectId: entry.projectId,
      threadId,
    });
  });
  const more = (category: "missions" | "bindings" | "blockers" | "questions") =>
    data?.[category].hasMore ? (
      <p className="text-sm text-muted-foreground">
        More {category} recorded.{" "}
        <Button size="sm" variant="outline" onClick={() => project()}>
          Inspect more {category} in {entry.title}
        </Button>
      </p>
    ) : null;
  const empty =
    data !== undefined &&
    (["missions", "bindings", "blockers", "questions"] as const).every(
      (category) => data[category].items.length === 0 && !data[category].hasMore,
    );
  return (
    <WorkCard className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-base font-semibold">{entry.title}</h3>
            <Badge variant={view.current ? "success" : "warning"}>
              {view.current ? "Current recorded summary" : "Cached or unavailable summary"}
            </Badge>
          </div>
          {entry.snapshot && !view.current ? (
            <p className="text-xs text-muted-foreground">
              Cached · {view.age === null ? "receive age unavailable" : `received ${view.age} ago`}
            </p>
          ) : null}
          {view.notices.map((notice) => (
            <p key={notice} className="text-sm text-warning-foreground">
              {notice}
            </p>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={() => project()}>
          Inspect project {entry.title}
        </Button>
      </div>
      <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/4 p-3 text-sm">
        <WorkLabel>Next action</WorkLabel>
        {view.current && actions.some((action) => action.category === "questions") ? (
          <p className="text-muted-foreground">
            To answer pending questions, open the project Inbox.
          </p>
        ) : null}
        {!view.current ? (
          <p className="text-muted-foreground">Refresh the portfolio for current next actions.</p>
        ) : actions.length > 0 ? (
          <div className="flex flex-col items-start gap-2">
            {actions.map((action, index) => (
              <Button
                key={JSON.stringify([action.category, action.recordId, index])}
                size="sm"
                variant={index === 0 ? "default" : "outline"}
                className="h-auto max-w-full py-1 text-left whitespace-normal"
                onClick={() => nextAction(action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : (
          <Button size="sm" onClick={() => project()}>
            {data && data.taskCounts.total > 0
              ? "Inspect task workflow and approvals"
              : "Inspect project to plan work"}
          </Button>
        )}
      </div>
      {data ? (
        <div className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="space-y-1.5">
            <WorkLabel>Recorded tasks</WorkLabel>
            <WorkCounts
              label={`Recorded tasks in ${entry.title}`}
              total={data.taskCounts.total}
              counts={TASK_STATES.filter((status) => status !== "total").map(
                (status) => [status, data.taskCounts[status]] as const,
              )}
            />
          </div>
          <div className="space-y-1.5">
            <WorkLabel>Coordinator</WorkLabel>
            {data.coordinator ? (
              <div className="break-all">
                <p>
                  {"name" in data.coordinator ? data.coordinator.name : data.coordinator.recordId} ·
                  Recorded {data.coordinator.status}
                </p>
                {"issue" in data.coordinator ? (
                  <p className="text-warning-foreground">Malformed coordinator metadata</p>
                ) : !data.coordinator.supported ||
                  !["active", "paused", "retired"].includes(data.coordinator.status) ? (
                  <p className="text-warning-foreground">Unsupported coordinator metadata</p>
                ) : data.coordinator.profile ? (
                  <ProfileMetadata profile={data.coordinator.profile} />
                ) : (
                  <p className="text-muted-foreground">Profile not recorded</p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">No coordinator recorded.</p>
            )}
          </div>
          {empty ? (
            <p className="text-muted-foreground sm:col-span-2">
              No missions, workers, blockers or questions recorded.
            </p>
          ) : null}
          {data.missions.items.length > 0 || data.missions.hasMore ? (
            <div className="space-y-1.5 sm:col-span-2">
              <WorkLabel>Missions</WorkLabel>
              {data.missions.items
                .slice()
                .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
                .map((mission, index) => (
                  <div key={JSON.stringify([mission.recordId, index])} className="break-all">
                    <p>
                      {"title" in mission ? mission.title : mission.recordId} · Recorded{" "}
                      {mission.status}
                    </p>
                    {"issue" in mission ? (
                      <p className="text-warning-foreground">Malformed mission metadata</p>
                    ) : !mission.supported ||
                      !["draft", "active", "paused", "completed", "canceled"].includes(
                        mission.status,
                      ) ? (
                      <p className="text-warning-foreground">Unsupported mission metadata</p>
                    ) : null}
                  </div>
                ))}
              {more("missions")}
            </div>
          ) : null}
          {data.bindings.items.length > 0 || data.bindings.hasMore ? (
            <div className="space-y-2 sm:col-span-2">
              <WorkLabel>Recorded bindings</WorkLabel>
              {data.bindings.items.map((binding, index) => (
                <div
                  key={JSON.stringify([binding.recordId, index])}
                  className="space-y-1 rounded-lg border border-border/60 p-3 break-all"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {"issue" in binding ? binding.recordId : `Task ${binding.taskId}`}
                    </span>
                    <Badge variant="outline">Recorded {binding.status}</Badge>
                  </div>
                  {"issue" in binding ? (
                    <p className="text-warning-foreground">Malformed binding metadata</p>
                  ) : (
                    <>
                      <p className="text-muted-foreground">
                        Binding model: {binding.model} · Provider {binding.providerInstanceId}
                      </p>
                      {projectTeamAccountingCaptions(
                        asProjectTeamBindingAccounting(binding.accounting, {
                          projectId: entry.projectId,
                          environmentId: entry.environmentId,
                          recordId: binding.recordId,
                          generation: binding.generation,
                          taskId: binding.taskId,
                          attemptId: binding.attemptId,
                        }),
                      ).map((caption) => (
                        <p key={caption} className="break-words text-xs text-muted-foreground">
                          {caption}
                        </p>
                      ))}
                      {binding.profile ? (
                        <ProfileMetadata profile={binding.profile} />
                      ) : (
                        <p className="text-muted-foreground">Profile not recorded</p>
                      )}
                      <WorkDetails>
                        <p>
                          {binding.recordId} · Task {binding.taskId} · Attempt {binding.attemptId} ·
                          Member {binding.memberId}
                        </p>
                        <p>Role revision {binding.roleRevisionId}</p>
                      </WorkDetails>
                      {!usableBinding(binding) ? (
                        <p className="text-warning-foreground">Unsupported binding metadata</p>
                      ) : view.current ? (
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => task("bindings", binding.recordId, binding.taskId)}
                          >
                            Inspect task {binding.taskId}
                          </Button>
                          {binding.workerThreadId ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                if (binding.workerThreadId)
                                  worker(binding.recordId, binding.workerThreadId);
                              }}
                            >
                              Inspect worker {binding.workerThreadId}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
              {more("bindings")}
            </div>
          ) : null}
          {data.blockers.items.length > 0 || data.blockers.hasMore ? (
            <div className="space-y-2">
              <WorkLabel>Blockers</WorkLabel>
              {data.blockers.items.map((blocker, index) => (
                <div
                  key={JSON.stringify([blocker.recordId, index])}
                  className="space-y-1 break-all"
                >
                  <p>
                    {blocker.reason} · Resolver {blocker.resolver}
                  </p>
                  <p className="text-xs text-muted-foreground">Task {blocker.taskId}</p>
                  {view.current ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => task("blockers", blocker.recordId, blocker.taskId)}
                    >
                      Inspect task {blocker.taskId}
                    </Button>
                  ) : null}
                </div>
              ))}
              {more("blockers")}
            </div>
          ) : null}
          {data.questions.items.length > 0 || data.questions.hasMore ? (
            <div className="space-y-2">
              <WorkLabel>Unresolved questions</WorkLabel>
              {data.questions.items.map((question, index) => (
                <div
                  key={JSON.stringify([question.recordId, index])}
                  className="space-y-1 break-all"
                >
                  <p>
                    {question.recordId} · Recorded {question.status}
                  </p>
                  {"issue" in question ? (
                    <p className="text-warning-foreground">Malformed question metadata</p>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Task {question.taskId} · Sender {question.senderId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Gate {question.targetGateId} · Target revision {question.targetRevision}
                      </p>
                      {!usableQuestion(question) ? (
                        <p className="text-warning-foreground">Unsupported question metadata</p>
                      ) : view.current ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => task("questions", question.recordId, question.taskId)}
                        >
                          Inspect task {question.taskId}
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
              {more("questions")}
            </div>
          ) : null}
        </div>
      ) : null}
      <WorkDetails>
        <p>
          Environment {entry.environmentId} · Project {entry.projectId}
        </p>
      </WorkDetails>
    </WorkCard>
  );
}

function ProfileMetadata({ profile }: { readonly profile: Parameters<typeof usableProfile>[0] }) {
  if ("issue" in profile)
    return (
      <p className="text-warning-foreground">Malformed profile metadata · {profile.recordId}</p>
    );
  return (
    <>
      <p className="text-muted-foreground">
        Profile: {profile.role} · {profile.model} · Role revision {profile.roleRevision} · Recorded{" "}
        {profile.status}
      </p>
      {!usableProfile(profile) ? (
        <p className="text-warning-foreground">Unsupported profile metadata</p>
      ) : null}
    </>
  );
}
