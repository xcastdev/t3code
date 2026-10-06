import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { readProjectWorkPublicationHistory } from "@t3tools/shared/projectWorkPublicationHistory";
import {
  ProjectTeamEffect,
  ProjectTeamRecord,
  ProjectWorkCriterion,
  ProjectWorkTask,
  ProjectWorkTaskContext,
  ProjectWorkPublicationRequest,
  type EnvironmentId,
  type PullRequestDetailView,
  type PullRequestRef,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useEnvironment } from "../../state/environments";
import { useProject } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { WorkTeamFoundation, type WorkTeamFoundationView } from "../work/WorkTeamFoundation";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: Pick<
    PullRequestDetailView,
    "projectId" | "repository" | "number" | "url" | "baseRevision" | "headRevision"
  >;
}
const knownRecord = Schema.is(ProjectTeamRecord);
const knownEffect = Schema.is(ProjectTeamEffect);
const knownTask = Schema.is(ProjectWorkTask);
const knownCriterion = Schema.is(ProjectWorkCriterion);
const decodeContext = Schema.decodeUnknownOption(ProjectWorkTaskContext);
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProjectWorkPublicationRequest),
);

/** Mounted only by the expanded PR Summary section; retained records grant no action authority. */
export function PullRequestProjectWork(props: Props) {
  return (
    <ProjectWorkSession
      key={JSON.stringify([
        props.environmentId,
        props.reference.projectId,
        props.reference.host,
        props.reference.repository,
        props.reference.number,
        props.detail.url,
      ])}
      {...props}
    />
  );
}
function ProjectWorkSession(props: Props) {
  const { environmentId, reference, detail } = props;
  const environment = useEnvironment(environmentId);
  const project = useProject(scopeProjectRef(environmentId, reference.projectId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  let host: string | null = null;
  try {
    const url = new URL(detail.url);
    if (
      url.protocol === "https:" &&
      url.pathname === `/${reference.repository}/pull/${reference.number}` &&
      (reference.host === undefined || url.host === reference.host) &&
      reference.projectId === detail.projectId &&
      reference.repository === detail.repository &&
      reference.number === detail.number
    )
      host = url.host;
  } catch {
    /* An unrecognized PR identity cannot establish a retained task relation. */
  }
  const enabled = config?.settings.projectWorkEnabled === true;
  const supported = config?.environment?.capabilities?.projectTeamFoundationReads === true;
  const connected = environment?.connection.phase === "connected";
  if (
    !project ||
    project.id !== reference.projectId ||
    project.environmentId !== environmentId ||
    host === null
  )
    return (
      <p className="text-xs text-muted-foreground">
        Project Work is unavailable for this pull request's project.
      </p>
    );
  if (!enabled || !supported)
    return (
      <p className="text-xs text-muted-foreground">
        This environment does not have Project Work inspection enabled.
      </p>
    );
  return (
    <WorkTeamFoundation
      environmentId={environmentId}
      projectId={reference.projectId}
      connected={connected}
      enabled={enabled}
      supported={supported}
      poll={false}
    >
      {(foundation) => (
        <PublicationTasks {...props} host={host} connected={connected} foundation={foundation} />
      )}
    </WorkTeamFoundation>
  );
}
function PublicationTasks(
  props: Props & {
    readonly host: string;
    readonly connected: boolean;
    readonly foundation: WorkTeamFoundationView;
  },
) {
  const { foundation, reference, environmentId } = props;
  const [selected, select] = useState<ProjectWorkTaskId | null>(null);
  const snapshot = foundation.snapshot;
  const coherent =
    snapshot.complete &&
    snapshot.error === null &&
    snapshot.records.every(knownRecord) &&
    snapshot.records.every((record) => record.projectId === reference.projectId) &&
    new Set(snapshot.records.map((record) => record.recordId)).size === snapshot.records.length;
  const publications = coherent
    ? snapshot.records.flatMap((record) => {
        if (!knownEffect(record)) return [];
        const history = readProjectWorkPublicationHistory(record);
        if (
          !history ||
          history.repository.host !== props.host ||
          history.repository.nameWithOwner !== reference.repository ||
          history.pullRequest.number !== reference.number
        )
          return [];
        const request = decodeRequest(record.payload.summary);
        return Option.isSome(request) && request.value.target.projectId === reference.projectId
          ? [{ record, history, request: request.value }]
          : [];
      })
    : [];
  const tasks = [...new Set(publications.map((entry) => entry.request.target.taskId))];
  const chosen = selected !== null && tasks.includes(selected) ? selected : null;
  const retained = publications.filter((entry) => entry.request.target.taskId === chosen);
  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        {props.connected && foundation.current
          ? "Complete retained Project Work snapshot"
          : "Cached or disconnected Project Work snapshot"}
      </p>
      <p className="text-muted-foreground">
        Retained publication history does not establish current approval or merge eligibility.
      </p>
      {tasks.length === 0 ? (
        <p>No verified retained task relation for this pull request.</p>
      ) : (
        <ReadPage
          title="Related tasks"
          rows={tasks}
          render={(taskId) => (
            <Button
              key={taskId}
              size="xs"
              variant={taskId === chosen ? "default" : "outline"}
              onClick={() => select(taskId)}
            >
              Inspect task {taskId}
            </Button>
          )}
        />
      )}
      {chosen !== null ? (
        <SelectedTask
          key={JSON.stringify([environmentId, reference.projectId, chosen])}
          {...props}
          taskId={chosen}
          retained={retained}
        />
      ) : null}
    </div>
  );
}
function ReadPage<T>({
  title,
  rows,
  render,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<T>;
  readonly render: (row: T) => ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const start = offset < rows.length ? offset : 0;
  return (
    <div className="space-y-2">
      <p className="font-medium">{title}</p>
      <div className="flex flex-col items-start gap-2">
        {rows.slice(start, start + 10).map(render)}
      </div>
      {rows.length > 10 ? (
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={start === 0}
            onClick={() => setOffset(start - 10)}
          >
            Previous {title.toLowerCase()}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={start + 10 >= rows.length}
            onClick={() => setOffset(start + 10)}
          >
            Next {title.toLowerCase()}
          </Button>
          <span>
            {start + 1}–{Math.min(start + 10, rows.length)} of {rows.length}
          </span>
        </div>
      ) : null}
    </div>
  );
}
function SelectedTask(
  props: Parameters<typeof PublicationTasks>[0] & {
    readonly taskId: ProjectWorkTaskId;
    readonly retained: ReadonlyArray<{
      readonly record: typeof ProjectTeamEffect.Type;
      readonly history: NonNullable<ReturnType<typeof readProjectWorkPublicationHistory>>;
      readonly request: typeof ProjectWorkPublicationRequest.Type;
    }>;
  },
) {
  const { environmentId, reference, taskId, foundation } = props;
  const registry = useContext(RegistryContext);
  const target = { environmentId, projectId: reference.projectId, taskId, poll: false };
  const atom = projectWorkEnvironment.taskContext(target);
  const result = useAtomValue(atom);
  const decoded = decodeContext(Option.getOrNull(AsyncResult.value(result)));
  const context = Option.getOrNull(decoded);
  const valid =
    context !== null &&
    context.projectId === reference.projectId &&
    context.task.projectId === reference.projectId &&
    context.task.taskId === taskId &&
    context.policy.taskId === taskId &&
    knownTask(context.task) &&
    context.criteria.every(knownCriterion) &&
    context.criteria.every((criterion) => criterion.taskId === taskId) &&
    context.evidence.every((evidence) => evidence.taskId === taskId) &&
    new Set(context.criteria.map((criterion) => criterion.criterionId)).size ===
      context.criteria.length &&
    new Set(context.evidence.map((evidence) => evidence.evidenceId)).size ===
      context.evidence.length &&
    (context.task.specification === undefined ||
      (context.task.specification.revision === context.task.specRevision &&
        context.task.specification.criterionIds.every((id) =>
          context.criteria.some((criterion) => criterion.criterionId === id),
        )));
  const run = useAtomQueryRunner(projectWorkEnvironment.taskContext, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const access = useRef(props.connected);
  const alive = useRef(true);
  useLayoutEffect(() => {
    access.current = props.connected;
  }, [props.connected]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = () => {
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    if (
      !alive.current ||
      !access.current ||
      config?.settings.projectWorkEnabled !== true ||
      config.environment?.capabilities?.projectTeamFoundationReads !== true
    )
      return;
    foundation.refresh();
    void run(target);
  };
  const current =
    props.connected &&
    foundation.current &&
    result._tag === "Success" &&
    !result.waiting &&
    context?.revision === foundation.snapshot.revision;
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      <ReadPage
        title="Retained publications"
        rows={props.retained}
        render={(entry) => (
          <div key={entry.record.recordId} className="space-y-1 break-all">
            <p>
              Retained publication {entry.record.recordId} · observed {entry.history.observedAt}
            </p>
            <p>Retained publication base {entry.history.pullRequest.baseSha}</p>
            <p>Retained publication head {entry.history.pullRequest.headSha}</p>
            <p>
              Retained publication specification {entry.request.target.specRevision} · plan{" "}
              {entry.request.target.planRevision} · task revision{" "}
              {entry.request.expectedTaskRevision}
            </p>
            <p>Current PR base {props.detail.baseRevision ?? "not reported"}</p>
            <p>Current PR head {props.detail.headRevision ?? "not reported"}</p>
            {props.detail.baseRevision === undefined || props.detail.headRevision === undefined ? (
              <p>Current PR commits cannot be compared with the retained publication.</p>
            ) : props.detail.baseRevision !== entry.history.pullRequest.baseSha ||
              props.detail.headRevision !== entry.history.pullRequest.headSha ? (
              <p>The current PR differs from the retained publication.</p>
            ) : (
              <p>Current PR commits match this retained publication.</p>
            )}
            {valid &&
            context !== null &&
            (context.task.specRevision !== entry.request.target.specRevision ||
              context.task.revision !== entry.request.expectedTaskRevision) ? (
              <p>The current task revisions differ from this retained publication.</p>
            ) : null}
          </div>
        )}
      />
      <p>{current ? "Recorded task snapshot" : "Cached or disconnected task snapshot"}</p>
      <Button size="xs" variant="outline" disabled={!props.connected} onClick={refresh}>
        Refresh Project Work
      </Button>
      {!valid || context === null ? (
        <p>
          {result._tag === "Failure"
            ? "Could not load this task. Refresh to try again."
            : result.waiting
              ? "Loading selected task…"
              : "Current task data could not be verified for this project."}
        </p>
      ) : (
        <>
          <p className="font-medium">
            {context.task.title} · {context.task.state}
          </p>
          <p>
            Current task specification {context.task.specRevision} · task revision{" "}
            {context.task.revision} · project revision {context.revision}
          </p>
          <p>Task last recorded update {context.task.updatedAt}</p>
          {context.task.specification ? (
            <div className="whitespace-pre-wrap break-words">
              <p>{context.task.specification.objective}</p>
              <p>Included: {context.task.specification.scopeIn}</p>
              <p>Excluded: {context.task.specification.scopeOut}</p>
            </div>
          ) : (
            <p>No current specification recorded.</p>
          )}
          <p>Current criteria are not frozen publication evidence.</p>
          <ReadPage
            title="Current criteria"
            rows={context.criteria}
            render={(criterion) => (
              <p key={criterion.criterionId}>
                {criterion.description} · {criterion.status}
                {criterion.required ? " · required" : ""}
              </p>
            )}
          />
          <ReadPage
            title="Recorded evidence references"
            rows={context.evidence}
            render={(evidence) => (
              <p key={evidence.evidenceId}>
                {evidence.summary} · Evidence {evidence.evidenceId} · recorded {evidence.recordedAt}
              </p>
            )}
          />
          <a
            className="text-primary underline"
            href={`/work/${encodeURIComponent(environmentId)}/${encodeURIComponent(reference.projectId)}?tab=tasks&taskId=${encodeURIComponent(taskId)}`}
          >
            Open task {taskId} in Project Work
          </a>
        </>
      )}
    </div>
  );
}
