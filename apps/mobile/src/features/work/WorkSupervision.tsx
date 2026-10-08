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
import { useEffectEvent, useLayoutEffect, useRef } from "react";
import { View } from "react-native";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";

type Owner = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
type Summary = Extract<ProjectTeamSupervisionSummary, { availability: "available" }>;
type Binding = Summary["bindings"]["items"][number];
type Profile = NonNullable<Extract<Binding, { taskId: string }>["profile"]>;
type Category = "bindings" | "blockers" | "questions";

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

function usableProfile(profile: Profile | undefined, recordId: string) {
  return (
    profile !== undefined &&
    !("issue" in profile) &&
    profile.recordId === recordId &&
    profile.supported &&
    ["available", "retired"].includes(profile.status) &&
    ROLES.has(profile.role)
  );
}

function usableBinding(binding: Binding) {
  return (
    !("issue" in binding) &&
    binding.supported &&
    ["reserved", "running", "stopping", "settled", "revoked", "quarantined"].includes(
      binding.status,
    ) &&
    usableProfile(binding.profile, binding.roleRevisionId)
  );
}

function usableQuestion(question: Summary["questions"]["items"][number]) {
  return (
    !("issue" in question) &&
    question.supported &&
    ["pending", "answered", "canceled"].includes(question.status)
  );
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

// Only public decoded metadata participates in a held control's identity fence.
function identity(item: Summary[Category]["items"][number]) {
  return JSON.stringify(item);
}

/** Present bounded recorded metadata. The owning screen supplies freshness and navigation. */
export function WorkSupervision(props: {
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
}) {
  return (
    <SupervisionSession key={JSON.stringify([props.environmentId, props.projectId])} {...props} />
  );
}

export type WorkSupervisionProps = Parameters<typeof WorkSupervision>[0];

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
  const navigate = useEffectEvent(
    (target: Owner, category: Category, recordId: string, token: string, worker: boolean) => {
      if (!mounted.current || !sameOwner(target) || !current || !data) return;
      const matches = data[category].items.filter((item) => item.recordId === recordId);
      const item = matches[0];
      if (matches.length !== 1 || !item || identity(item) !== token || !("taskId" in item)) return;
      if (category === "bindings") {
        const binding = data.bindings.items.find((row) => row.recordId === recordId);
        if (!binding || !usableBinding(binding)) return;
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
        if (!question || !usableQuestion(question)) return;
      }
      props.onOpenTask({ ...target, taskId: item.taskId });
    },
  );
  const taskButton = (category: Category, item: Summary[Category]["items"][number]) =>
    current && "taskId" in item ? (
      <WorkButton onPress={() => navigate(owner, category, item.recordId, identity(item), false)}>
        Inspect task {item.taskId}
      </WorkButton>
    ) : null;
  const more = (category: "missions" | Category) =>
    data?.[category].hasMore ? (
      <View className="gap-1">
        <Notice>More {category} recorded.</Notice>
        <WorkButton onPress={() => inspect(owner)}>
          Inspect more {category} in {props.title}
        </WorkButton>
      </View>
    ) : null;
  return (
    <View className="gap-3">
      <WorkCard title={props.title}>
        <Notice>
          Environment {props.environmentId} · Project {props.projectId}
        </Notice>
        <Notice>{current ? "Current recorded summary" : "Cached or unavailable summary"}</Notice>
        <Notice>Recorded counts and binding states do not verify execution health.</Notice>
        {!props.connected ? <Notice>Disconnected. Recorded metadata may be stale.</Notice> : null}
        {!props.enabled ? <Notice>Project Work is disabled.</Notice> : null}
        {!props.supported ? <Notice>This environment does not support supervision.</Notice> : null}
        {!props.current ? <Notice>Waiting for a current owner-scoped summary.</Notice> : null}
        {props.error !== undefined ? (
          <Notice>Read error: {props.error.slice(0, 240) || "No details recorded"}</Notice>
        ) : null}
        {!snapshot ? (
          <Notice>No summary received.</Notice>
        ) : !ownerMatches ? (
          <Notice>Snapshot owner mismatch. Waiting for this project's summary.</Notice>
        ) : !decoded ? (
          <Notice>Malformed or incoherent summary metadata.</Notice>
        ) : null}
        {snapshot ? (
          <Notice>
            {!current ? "Cached · " : ""}
            {age === null
              ? "Receive age unavailable: invalid or future receive time."
              : `Received ${age} seconds ago.`}
          </Notice>
        ) : null}
        {decoded && decoded.availability !== "available" ? (
          <Notice>Project {decoded.availability}.</Notice>
        ) : null}
        {data ? (
          <Notice>
            Project revision {data.revision}
            {data.lifecycleRevision !== undefined
              ? ` · Lifecycle revision ${data.lifecycleRevision}`
              : ""}
          </Notice>
        ) : null}
        <WorkButton onPress={() => inspect(owner)}>Inspect project {props.title}</WorkButton>
      </WorkCard>
      {data ? (
        <>
          <WorkCard title="Recorded tasks">
            <Notice>
              {TASK_STATES.map((state) => `${state} ${data.taskCounts[state]}`).join(" · ")}
            </Notice>
          </WorkCard>
          <WorkCard title="Coordinator">
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
                      recordId={data.coordinator.roleRevisionId}
                    />
                  </>
                )}
              </>
            ) : (
              <Notice>No coordinator recorded.</Notice>
            )}
          </WorkCard>
          <WorkCard title="Missions">
            {data.missions.items.map((mission) => (
              <View key={mission.recordId} className="gap-1">
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
              </View>
            ))}
            {data.missions.items.length === 0 ? <Notice>No missions recorded.</Notice> : null}
            {more("missions")}
          </WorkCard>
          <WorkCard title="Recorded bindings">
            {data.bindings.items.map((binding) => (
              <View key={binding.recordId} className="gap-1 border-t border-border pt-2">
                <Notice>
                  {binding.recordId} · Recorded {binding.status}
                </Notice>
                {"issue" in binding ? (
                  <Notice>Malformed binding metadata.</Notice>
                ) : (
                  <>
                    <Notice>
                      Task {binding.taskId} · Attempt {binding.attemptId} · Member{" "}
                      {binding.memberId}
                    </Notice>
                    {projectTeamAccountingCaptions(binding.accounting).map((caption) => (
                      <Notice key={caption}>{caption}</Notice>
                    ))}
                    <Notice>
                      Binding model: {binding.model} · Provider {binding.providerInstanceId} · Role
                      revision {binding.roleRevisionId}
                    </Notice>
                    <Notice>
                      Record revision {binding.revision} · Generation {binding.generation}
                    </Notice>
                    <ProfileMetadata profile={binding.profile} recordId={binding.roleRevisionId} />
                    {!usableBinding(binding) ? (
                      <Notice>
                        Unsupported or incomplete binding metadata. Assignment navigation
                        unavailable.
                      </Notice>
                    ) : (
                      <>
                        {taskButton("bindings", binding)}
                        {current &&
                        binding.workerThreadId &&
                        uniqueWorker(binding, data.bindings.items) ? (
                          <WorkButton
                            onPress={() =>
                              navigate(owner, "bindings", binding.recordId, identity(binding), true)
                            }
                          >
                            Inspect worker {binding.workerThreadId}
                          </WorkButton>
                        ) : null}
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
              </View>
            ))}
            {data.bindings.items.length === 0 ? <Notice>No bindings recorded.</Notice> : null}
            {more("bindings")}
          </WorkCard>
          <WorkCard title="Blockers">
            {data.blockers.items.map((blocker) => (
              <View key={blocker.recordId} className="gap-1">
                <Notice>
                  {blocker.reason} · Resolver {blocker.resolver}
                </Notice>
                <Notice>Task {blocker.taskId}</Notice>
                {taskButton("blockers", blocker)}
              </View>
            ))}
            {data.blockers.items.length === 0 ? <Notice>No blockers recorded.</Notice> : null}
            {more("blockers")}
          </WorkCard>
          <WorkCard title="Unresolved questions">
            {data.questions.items.map((question) => (
              <View key={question.recordId} className="gap-1">
                <Notice>
                  {question.recordId} · Recorded {question.status}
                </Notice>
                {"issue" in question ? (
                  <Notice>Malformed question metadata.</Notice>
                ) : (
                  <>
                    <Notice>
                      Task {question.taskId} · Sender {question.senderId}
                    </Notice>
                    <Notice>
                      Gate {question.targetGateId} · Target revision {question.targetRevision}
                    </Notice>
                    {!usableQuestion(question) ? (
                      <Notice>Unsupported question metadata.</Notice>
                    ) : (
                      taskButton("questions", question)
                    )}
                  </>
                )}
              </View>
            ))}
            {data.questions.items.length === 0 ? (
              <Notice>No unresolved questions recorded.</Notice>
            ) : null}
            {more("questions")}
          </WorkCard>
        </>
      ) : null}
    </View>
  );
}

function ProfileMetadata({
  profile,
  recordId,
}: {
  readonly profile: Profile | undefined;
  readonly recordId: string;
}) {
  if (!profile) return <Notice>Profile not recorded.</Notice>;
  if ("issue" in profile) return <Notice>Malformed profile metadata · {profile.recordId}</Notice>;
  return (
    <>
      <Notice>
        Profile: {profile.role} · {profile.model} · Role revision {profile.roleRevision} · Recorded{" "}
        {profile.status}
      </Notice>
      {!usableProfile(profile, recordId) ? (
        <Notice>Unsupported or mismatched profile metadata.</Notice>
      ) : null}
    </>
  );
}
