import {
  asProjectTeamSupervisionSummary,
  projectTeamAccountingCaptions,
} from "@t3tools/client-runtime/project-work";
import type {
  EnvironmentId,
  ProjectId,
  ProjectTeamSupervisionSummary,
  ThreadId,
} from "@t3tools/contracts";
import { useEffectEvent, useLayoutEffect, useRef, type ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkCard } from "./WorkDataNotice";
import { WorkDetails } from "./WorkLayout";

type Owner = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
type Summary = Extract<ProjectTeamSupervisionSummary, { availability: "available" }>;
type Category = "bindings" | "blockers" | "questions";
type Binding = Summary["bindings"]["items"][number];
type Profile = NonNullable<Extract<Binding, { taskId: string }>["profile"]>;

export interface WorkSupervisionProps {
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
  readonly now: number;
  readonly onOpenTask: (target: Owner & { taskId: string }) => void;
  readonly onOpenWorker: (target: Owner & { threadId: ThreadId }) => void;
  readonly onInspectProject: (target: Owner) => void;
}

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
const ROLES = new Set([
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
]);
const BINDING_STATES = new Set([
  "reserved",
  "running",
  "stopping",
  "settled",
  "revoked",
  "quarantined",
]);
const QUESTION_STATES = new Set(["pending", "answered", "canceled"]);

function knownProfile(profile: Profile | undefined, roleRevisionId: string) {
  return (
    profile !== undefined &&
    !("issue" in profile) &&
    profile.supported &&
    profile.recordId === roleRevisionId &&
    ["available", "retired"].includes(profile.status) &&
    ROLES.has(profile.role)
  );
}
function knownBinding(binding: Binding) {
  return (
    !("issue" in binding) &&
    binding.supported &&
    BINDING_STATES.has(binding.status) &&
    knownProfile(binding.profile, binding.roleRevisionId)
  );
}
function knownQuestion(question: Summary["questions"]["items"][number]) {
  return !("issue" in question) && question.supported && QUESTION_STATES.has(question.status);
}
function uniqueWorker(binding: Binding, bindings: Summary["bindings"]["items"]) {
  return (
    "workerThreadId" in binding &&
    binding.workerThreadId !== undefined &&
    bindings.filter(
      (row) => "workerThreadId" in row && row.workerThreadId === binding.workerThreadId,
    ).length === 1
  );
}
function receiveAge(now: number, receivedAt: number) {
  if (
    !Number.isFinite(now) ||
    now < 0 ||
    !Number.isFinite(receivedAt) ||
    receivedAt < 0 ||
    receivedAt > now
  )
    return null;
  return Math.floor((now - receivedAt) / 1_000);
}
function identity(revision: number, item: Summary[Category]["items"][number]) {
  return JSON.stringify([revision, item]);
}

/** Render owner-scoped recorded metadata; the owning Work page supplies freshness and inspection. */
export function WorkSupervision(props: WorkSupervisionProps) {
  return (
    <SupervisionSession key={JSON.stringify([props.environmentId, props.projectId])} {...props} />
  );
}

function SupervisionSession(props: WorkSupervisionProps) {
  const snapshot = props.snapshot;
  const ownerMatches =
    snapshot?.environmentId === props.environmentId && snapshot.data?.projectId === props.projectId;
  const decoded = ownerMatches
    ? asProjectTeamSupervisionSummary(snapshot.data, props.projectId, props.environmentId)
    : null;
  const data = decoded?.availability === "available" ? decoded : null;
  const age = snapshot ? receiveAge(props.now, snapshot.receivedAt) : null;
  const current =
    props.connected &&
    props.enabled &&
    props.supported &&
    props.current &&
    props.error === undefined &&
    age !== null &&
    data !== null;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owner = { environmentId: props.environmentId, projectId: props.projectId };
  const sameOwner = (target: Owner) =>
    target.environmentId === props.environmentId && target.projectId === props.projectId;
  const inspect = useEffectEvent((target: Owner) => {
    if (mounted.current && sameOwner(target)) props.onInspectProject(target);
  });
  // Held controls recheck the latest committed owner, summary fence and complete public record.
  const navigate = useEffectEvent(
    (target: Owner, category: Category, recordId: string, token: string, worker: boolean) => {
      if (!mounted.current || !sameOwner(target) || !current || !data) return;
      const rows = data[category].items.filter((item) => item.recordId === recordId);
      const item = rows[0];
      if (
        rows.length !== 1 ||
        !item ||
        identity(data.revision, item) !== token ||
        !("taskId" in item)
      )
        return;
      if (category === "bindings") {
        const binding = data.bindings.items.find((row) => row.recordId === recordId);
        if (!binding || !knownBinding(binding)) return;
        if (worker) {
          if (
            !("workerThreadId" in binding) ||
            !binding.workerThreadId ||
            !uniqueWorker(binding, data.bindings.items)
          )
            return;
          props.onOpenWorker({ ...target, threadId: binding.workerThreadId });
          return;
        }
      } else if (worker) return;
      if (category === "questions") {
        const question = data.questions.items.find((row) => row.recordId === recordId);
        if (!question || !knownQuestion(question)) return;
      }
      props.onOpenTask({ ...target, taskId: item.taskId });
    },
  );
  const taskControl = (category: Category, item: Summary[Category]["items"][number]) =>
    current && data && "taskId" in item ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          navigate(owner, category, item.recordId, identity(data.revision, item), false)
        }
      >
        Inspect task {item.taskId}
      </Button>
    ) : null;
  const more = (category: "missions" | Category) =>
    data?.[category].hasMore ? (
      <div className="flex flex-wrap items-center gap-2">
        <Notice>More {category} recorded.</Notice>
        <Button type="button" size="sm" variant="outline" onClick={() => inspect(owner)}>
          Inspect more {category} in {props.title}
        </Button>
      </div>
    ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <WorkCard className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-lg font-semibold">{props.title}</h2>
              <Badge variant={current ? "success" : "warning"}>
                {current ? "Current recorded summary" : "Cached or unavailable summary"}
              </Badge>
            </div>
            {snapshot ? (
              <Notice>
                {!current ? "Cached · " : ""}
                {age === null
                  ? "Receive age unavailable: invalid or future receive time."
                  : `Received ${age} seconds ago.`}
              </Notice>
            ) : null}
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => inspect(owner)}>
            Inspect project {props.title}
          </Button>
        </div>
        {!props.connected ? <Warning>Disconnected. Recorded metadata may be stale.</Warning> : null}
        {!props.enabled ? <Warning>Project Work is disabled.</Warning> : null}
        {!props.supported ? (
          <Warning>This environment does not support supervision.</Warning>
        ) : null}
        {!props.current ? <Warning>Waiting for a current owner-scoped summary.</Warning> : null}
        {props.error !== undefined ? (
          <Warning>Read error: {props.error.slice(0, 240) || "No details recorded"}</Warning>
        ) : null}
        {!snapshot ? (
          <Warning>No summary received.</Warning>
        ) : !ownerMatches ? (
          <Warning>Snapshot owner mismatch. Waiting for this project's summary.</Warning>
        ) : !decoded ? (
          <Warning>Malformed or incoherent summary metadata.</Warning>
        ) : null}
        {decoded && decoded.availability !== "available" ? (
          <Warning>Project {decoded.availability}.</Warning>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Recorded counts and binding states do not verify execution health.
        </p>
        <WorkDetails>
          <p>
            Environment {props.environmentId} · Project {props.projectId}
          </p>
          {data ? (
            <p>
              Project revision {data.revision}
              {data.lifecycleRevision !== undefined
                ? ` · Lifecycle revision ${data.lifecycleRevision}`
                : ""}
            </p>
          ) : null}
        </WorkDetails>
      </WorkCard>
      {data ? (
        <>
          <Section title="Recorded tasks">
            <dl className="grid grid-cols-2 gap-1.5 text-sm sm:grid-cols-4 lg:grid-cols-6">
              {TASK_STATES.map((state) => (
                <div
                  key={state}
                  className={`flex items-baseline justify-between gap-2 rounded-md border border-border/60 px-2 py-1 ${
                    data.taskCounts[state] === 0 && state !== "total" ? "opacity-60" : ""
                  } ${state === "total" ? "bg-muted/50" : ""}`}
                >
                  <dt className="truncate text-xs text-muted-foreground">{state}</dt>
                  <dd className="font-medium tabular-nums">{data.taskCounts[state]}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="Coordinator">
            {data.coordinator ? (
              <>
                <Notice>
                  {"name" in data.coordinator ? data.coordinator.name : data.coordinator.recordId} ·
                  Recorded {data.coordinator.status}
                </Notice>
                {"issue" in data.coordinator ? (
                  <Notice>Malformed coordinator metadata.</Notice>
                ) : (
                  <>
                    {!data.coordinator.supported ||
                    !["active", "paused", "retired"].includes(data.coordinator.status) ? (
                      <Notice>Unsupported coordinator metadata.</Notice>
                    ) : null}
                    <ProfileMetadata
                      profile={data.coordinator.profile}
                      roleRevisionId={data.coordinator.roleRevisionId}
                    />
                  </>
                )}
              </>
            ) : (
              <Notice>No coordinator recorded.</Notice>
            )}
          </Section>
          <Section title="Missions">
            <Notice>
              {data.missions.items.length} missions in this bounded preview. Record order does not
              indicate recency.
            </Notice>
            {data.missions.items.map((mission) => (
              <div key={mission.recordId} className="space-y-1">
                <Notice>
                  {"title" in mission ? mission.title : mission.recordId} · Recorded{" "}
                  {mission.status}
                </Notice>
                {"issue" in mission ? (
                  <Notice>Malformed mission metadata.</Notice>
                ) : !mission.supported ||
                  !["draft", "active", "paused", "completed", "canceled"].includes(
                    mission.status,
                  ) ? (
                  <Notice>Unsupported mission metadata.</Notice>
                ) : null}
              </div>
            ))}
            {data.missions.items.length === 0 ? (
              <Notice>No missions in this preview.</Notice>
            ) : null}
            {more("missions")}
          </Section>
          <Section title="Recorded bindings">
            <Notice>
              {data.bindings.items.length} bindings in this bounded preview. Recorded status does
              not establish process liveness.
            </Notice>
            {data.bindings.items.map((binding) => (
              <div key={binding.recordId} className="space-y-2 border-t border-border/70 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {"issue" in binding ? binding.recordId : `Task ${binding.taskId}`}
                  </span>
                  <Badge variant="outline">Recorded {binding.status}</Badge>
                </div>
                {"issue" in binding ? (
                  <Notice>Malformed binding metadata.</Notice>
                ) : (
                  <>
                    <Notice>
                      Binding model: {binding.model} · Provider {binding.providerInstanceId}
                    </Notice>
                    {projectTeamAccountingCaptions(binding.accounting).map((caption) => (
                      <Notice key={caption}>{caption}</Notice>
                    ))}
                    <WorkDetails>
                      <p>
                        {binding.recordId} · Task {binding.taskId} · Attempt {binding.attemptId} ·
                        Member {binding.memberId}
                      </p>
                      <p>
                        Role revision {binding.roleRevisionId} · Record revision {binding.revision}{" "}
                        · Generation {binding.generation}
                      </p>
                    </WorkDetails>
                    <ProfileMetadata
                      profile={binding.profile}
                      roleRevisionId={binding.roleRevisionId}
                    />
                    {!knownBinding(binding) ? (
                      <Notice>
                        Unsupported or incomplete binding metadata. Assignment navigation
                        unavailable.
                      </Notice>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-2">
                          {taskControl("bindings", binding)}
                          {current &&
                          binding.workerThreadId &&
                          uniqueWorker(binding, data.bindings.items) ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                navigate(
                                  owner,
                                  "bindings",
                                  binding.recordId,
                                  identity(data.revision, binding),
                                  true,
                                )
                              }
                            >
                              Inspect worker {binding.workerThreadId}
                            </Button>
                          ) : null}
                        </div>
                        {binding.workerThreadId && !uniqueWorker(binding, data.bindings.items) ? (
                          <Notice>
                            Worker thread is shared by multiple bindings. Worker navigation
                            unavailable.
                          </Notice>
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </div>
            ))}
            {data.bindings.items.length === 0 ? (
              <Notice>No bindings in this preview.</Notice>
            ) : null}
            {more("bindings")}
          </Section>
          <Section title="Blockers">
            <Notice>{data.blockers.items.length} blockers in this bounded preview.</Notice>
            {data.blockers.items.map((blocker) => (
              <div key={blocker.recordId} className="space-y-1">
                <p className="text-sm">{blocker.reason}</p>
                <Notice>
                  Resolver {blocker.resolver} · Task {blocker.taskId}
                </Notice>
                {taskControl("blockers", blocker)}
              </div>
            ))}
            {data.blockers.items.length === 0 ? (
              <Notice>No blockers in this preview.</Notice>
            ) : null}
            {more("blockers")}
          </Section>
          <Section title="Unresolved questions">
            <Notice>{data.questions.items.length} questions in this bounded preview.</Notice>
            {data.questions.items.map((question) => (
              <div key={question.recordId} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {"issue" in question ? question.recordId : `Task ${question.taskId}`}
                  </span>
                  <Badge variant="outline">Recorded {question.status}</Badge>
                </div>
                {"issue" in question ? (
                  <Notice>Malformed question metadata.</Notice>
                ) : (
                  <>
                    <WorkDetails>
                      <p>
                        {question.recordId} · Task {question.taskId} · Sender {question.senderId}
                      </p>
                      <p>
                        Gate {question.targetGateId} · Target revision {question.targetRevision}
                      </p>
                    </WorkDetails>
                    {!knownQuestion(question) ? (
                      <Notice>Unsupported question metadata.</Notice>
                    ) : (
                      taskControl("questions", question)
                    )}
                  </>
                )}
              </div>
            ))}
            {data.questions.items.length === 0 ? (
              <Notice>No unresolved questions in this preview.</Notice>
            ) : null}
            {more("questions")}
          </Section>
        </>
      ) : null}
    </div>
  );
}
function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="break-words text-sm text-muted-foreground">{children}</p>;
}
function Warning({ children }: { readonly children: ReactNode }) {
  return <p className="break-words text-sm text-warning-foreground">{children}</p>;
}
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <WorkCard className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </WorkCard>
  );
}
function ProfileMetadata({
  profile,
  roleRevisionId,
}: {
  readonly profile: Profile | undefined;
  readonly roleRevisionId: string;
}) {
  if (!profile) return <Notice>Profile not recorded.</Notice>;
  if ("issue" in profile) return <Notice>Malformed profile metadata · {profile.recordId}</Notice>;
  return (
    <>
      <Notice>
        Profile: {profile.role} · {profile.model} · Role revision {profile.roleRevision} · Recorded{" "}
        {profile.status}
      </Notice>
      {!knownProfile(profile, roleRevisionId) ? (
        <Notice>Unsupported or mismatched profile metadata.</Notice>
      ) : null}
    </>
  );
}
