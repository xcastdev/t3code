import {
  type EnvironmentId,
  type ProjectId,
  ProjectTeamSupervisionSummary,
  type ThreadId,
} from "@t3tools/contracts";

import * as Schema from "effect/Schema";
import { useEffectEvent, useLayoutEffect, useRef } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkCard } from "../../components/work/WorkDataNotice";

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
      <div>
        <h2 className="text-lg font-semibold">Portfolio</h2>
        <p className="text-sm text-muted-foreground">
          Recorded project summaries. Counts and binding states describe saved records; execution
          health is not verified here.
        </p>
        {props.loading ? <p>Loading summaries…</p> : null}
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={!canRead}
          onClick={() => refresh()}
        >
          Refresh portfolio
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects in this page.</p>
      ) : null}
      {props.entries.length > PAGE_SIZE ? (
        <p>Showing 25 of {props.entries.length} projects. More projects require another page.</p>
      ) : null}
      {entries.map((entry) => (
        <PortfolioEntry
          key={JSON.stringify([entry.environmentId, entry.projectId])}
          entry={entry}
          props={props}
        />
      ))}
      <div className="flex gap-2">
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
      <p className="mt-2 text-sm">
        More {category} recorded.{" "}
        <Button size="sm" variant="outline" onClick={() => project()}>
          Inspect more {category} in {entry.title}
        </Button>
      </p>
    ) : null;
  return (
    <WorkCard>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-all font-medium">{entry.title}</h3>
        <Badge variant="outline">
          {view.current ? "Current recorded summary" : "Cached or unavailable summary"}
        </Badge>
      </div>
      <p className="mt-1 break-all text-xs text-muted-foreground">
        Environment {entry.environmentId} · Project {entry.projectId}
      </p>
      {view.notices.map((notice) => (
        <p key={notice} className="mt-1 text-sm">
          {notice}
        </p>
      ))}
      {entry.snapshot && !view.current ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Cached · {view.age === null ? "receive age unavailable" : `received ${view.age} ago`}
        </p>
      ) : null}
      <Button className="mt-2" size="sm" variant="outline" onClick={() => project()}>
        Inspect project {entry.title}
      </Button>
      {data ? (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <div>
            <h4 className="font-medium">Recorded tasks</h4>
            <p className="text-muted-foreground">
              {TASK_STATES.map((status) => `${status} ${data.taskCounts[status]}`).join(" · ")}
            </p>
          </div>
          <div>
            <h4 className="font-medium">Coordinator</h4>
            {data.coordinator ? (
              <div className="break-all">
                <p>
                  {"name" in data.coordinator ? data.coordinator.name : data.coordinator.recordId} ·
                  Recorded {data.coordinator.status}
                </p>
                {"issue" in data.coordinator ? (
                  <p>Malformed coordinator metadata</p>
                ) : !data.coordinator.supported ||
                  !["active", "paused", "retired"].includes(data.coordinator.status) ? (
                  <p>Unsupported coordinator metadata</p>
                ) : data.coordinator.profile ? (
                  <ProfileMetadata profile={data.coordinator.profile} />
                ) : (
                  <p>Profile not recorded</p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">No coordinator recorded.</p>
            )}
          </div>
          <div>
            <h4 className="font-medium">Missions</h4>
            {data.missions.items
              .slice()
              .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
              .map((mission, index) => (
                <div key={JSON.stringify([mission.recordId, index])} className="mt-1 break-all">
                  <p>
                    {"title" in mission ? mission.title : mission.recordId} · Recorded{" "}
                    {mission.status}
                  </p>
                  {"issue" in mission ? (
                    <p>Malformed mission metadata</p>
                  ) : !mission.supported ||
                    !["draft", "active", "paused", "completed", "canceled"].includes(
                      mission.status,
                    ) ? (
                    <p>Unsupported mission metadata</p>
                  ) : null}
                </div>
              ))}
            {more("missions")}
          </div>
          <div>
            <h4 className="font-medium">Recorded bindings</h4>
            {data.bindings.items.map((binding, index) => (
              <div key={JSON.stringify([binding.recordId, index])} className="mt-2 break-all">
                <p>
                  {binding.recordId} · Recorded {binding.status}
                </p>
                {"issue" in binding ? (
                  <p>Malformed binding metadata</p>
                ) : (
                  <>
                    <p>
                      Task {binding.taskId} · Attempt {binding.attemptId} · Member{" "}
                      {binding.memberId}
                    </p>
                    <p>
                      Binding model: {binding.model} · Provider {binding.providerInstanceId} · Role
                      revision {binding.roleRevisionId}
                    </p>
                    {binding.profile ? (
                      <ProfileMetadata profile={binding.profile} />
                    ) : (
                      <p>Profile not recorded</p>
                    )}
                    {!usableBinding(binding) ? (
                      <p>Unsupported binding metadata</p>
                    ) : view.current ? (
                      <div className="mt-1 flex flex-wrap gap-2">
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
          <div>
            <h4 className="font-medium">Blockers</h4>
            {data.blockers.items.map((blocker, index) => (
              <div key={JSON.stringify([blocker.recordId, index])} className="mt-2 break-all">
                <p>
                  {blocker.reason} · Resolver {blocker.resolver}
                </p>
                <p>Task {blocker.taskId}</p>
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
          <div>
            <h4 className="font-medium">Unresolved questions</h4>
            {data.questions.items.map((question, index) => (
              <div key={JSON.stringify([question.recordId, index])} className="mt-2 break-all">
                <p>
                  {question.recordId} · Recorded {question.status}
                </p>
                {"issue" in question ? (
                  <p>Malformed question metadata</p>
                ) : (
                  <>
                    <p>
                      Task {question.taskId} · Sender {question.senderId}
                    </p>
                    <p>
                      Gate {question.targetGateId} · Target revision {question.targetRevision}
                    </p>
                    {!usableQuestion(question) ? (
                      <p>Unsupported question metadata</p>
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
        </div>
      ) : null}
    </WorkCard>
  );
}

function ProfileMetadata({ profile }: { readonly profile: Parameters<typeof usableProfile>[0] }) {
  if ("issue" in profile) return <p>Malformed profile metadata · {profile.recordId}</p>;
  return (
    <>
      <p>
        Profile: {profile.role} · {profile.model} · Role revision {profile.roleRevision} · Recorded{" "}
        {profile.status}
      </p>
      {!usableProfile(profile) ? <p>Unsupported profile metadata</p> : null}
    </>
  );
}
