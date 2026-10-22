import { RegistryContext } from "@effect/atom-react";
import {
  asProjectTeamRecord,
  asProjectWorkTaskContext,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  ProjectIssueRepositoryBindingsRead,
  ProjectIssueRepositoryIdentityRead,
  ProjectIssueSyncReceipt,
  ProjectWorkTaskId,
  type ProjectWorkTaskRead,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PlusIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { projectWorkEnvironment } from "../../state/projectWork";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkNotice, WorkPager, WorkReviewChanged } from "./WorkNotice";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
  WorkTime,
} from "./WorkLayout";
import { WorkTaskPicker } from "./WorkTaskRefs";
import { useWorkRead, workWriteBlockedReason } from "./useWorkRead";
import { useWorkPage } from "./useWorkRecords";
import type { WorkWriter } from "./useWorkWriter";
import {
  existingTaskRefineChanged,
  existingTaskRefineFields,
  existingTaskRefineSnapshot,
  type ExistingTaskRefineReview,
} from "./workLogic";
import { isIssueRecord, workStateLabel, workStateVariant, type WorkIssueRecord } from "./workModel";
import { newCommandId, useWorkReview } from "./workTaskSurface";

const decodeBindings = Schema.decodeUnknownOption(ProjectIssueRepositoryBindingsRead);
const decodeIdentity = Schema.decodeUnknownOption(ProjectIssueRepositoryIdentityRead);
const decodeReceipt = Schema.decodeUnknownOption(ProjectIssueSyncReceipt);
type Binding = ProjectIssueRepositoryBindingsRead["items"][number];
type Identity = ProjectIssueRepositoryIdentityRead;
type Bindings =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "ready"; readonly items: ReadonlyArray<Binding> };

const bindingKey = (entry: { host: string; repositoryNodeId: string }) =>
  `${entry.host}:${entry.repositoryNodeId}`;

function receiptText(value: unknown): string {
  const receipt = Option.getOrNull(decodeReceipt(value));
  if (receipt === null) return "Sync finished with a response this client doesn't recognize.";
  if (receipt.status === "committed")
    return `Saved ${receipt.count} issues from page ${receipt.page}.${receipt.nextPage === null ? " No more pages." : " Sync again for the next page."}`;
  if (receipt.status === "paused") return "GitHub asked to slow down. Try syncing again later.";
  return `Sync failed: ${receipt.reason}`;
}

export function WorkIntake({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <IssueBindings scope={scope} writer={writer} />
      <IssueList scope={scope} writer={writer} />
    </div>
  );
}

/**
 * Bindings are listed by a guarded command, not a stream: each generation
 * lists once, and every change or Retry starts a new generation.
 */
function IssueBindings({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const [generation, setGeneration] = useState(0);
  return (
    <IssueBindingsGeneration
      key={generation}
      scope={scope}
      writer={writer}
      onReload={() => setGeneration(generation + 1)}
    />
  );
}

function IssueBindingsGeneration({
  scope,
  writer,
  onReload: reload,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly onReload: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [bindings, setBindings] = useState<Bindings>({ status: "loading" });
  const [preparing, setPreparing] = useState(false);

  useEffect(() => {
    if (!writer.canIssue) return;
    let live = true;
    void projectWorkEnvironment.issue
      .run(registry, {
        environmentId: scope.environmentId,
        input: { operation: "list", input: { projectId: scope.projectId } },
      })
      .then((result) => {
        if (!live) return;
        const decoded =
          result._tag === "Success" ? Option.getOrNull(decodeBindings(result.value)) : null;
        setBindings(
          decoded === null
            ? {
                status: "unavailable",
                message:
                  result._tag === "Success"
                    ? "This environment answered with bindings this client doesn't recognize."
                    : "Couldn't list repository bindings.",
              }
            : { status: "ready", items: decoded.items },
        );
      });
    return () => {
      live = false;
    };
  }, [registry, scope.environmentId, scope.projectId, writer.canIssue]);

  return (
    <WorkSection
      title="GitHub issue intake"
      description="Issues are copied in only when you sync. Their text is a proposal until you refine it."
      actions={
        preparing || bindings.status !== "ready" ? null : (
          <Button size="xs" disabled={!writer.canIssue} onClick={() => setPreparing(true)}>
            <PlusIcon /> Bind repository
          </Button>
        )
      }
    >
      {!writer.canIssue ? (
        <WorkRow>
          <WorkMeta>This connection can't manage issue intake here.</WorkMeta>
        </WorkRow>
      ) : bindings.status === "loading" ? (
        <WorkRow>
          <WorkMeta>Loading repository bindings…</WorkMeta>
        </WorkRow>
      ) : bindings.status === "unavailable" ? (
        <WorkRow className="flex-row items-center justify-between gap-2">
          <WorkMeta>{bindings.message}</WorkMeta>
          <Button size="xs" variant="outline" onClick={reload}>
            Retry
          </Button>
        </WorkRow>
      ) : (
        <>
          {preparing ? (
            <BindForm
              scope={scope}
              writer={writer}
              bindings={bindings.items}
              onDone={(bound) => {
                setPreparing(false);
                if (bound) reload();
              }}
            />
          ) : null}
          <BindingRows
            scope={scope}
            writer={writer}
            items={bindings.items}
            onChanged={reload}
            onRebind={() => setPreparing(true)}
          />
        </>
      )}
    </WorkSection>
  );
}

function BindingRows({
  scope,
  writer,
  items,
  onChanged,
  onRebind,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly items: ReadonlyArray<Binding>;
  readonly onChanged: () => void;
  readonly onRebind: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [detaching, setDetaching] = useState<string | null>(null);
  const run = async (operation: "sync" | "detach", entry: Binding) => {
    setNotice(null);
    const value = await writer.runIssue(`issue:${bindingKey(entry)}`, {
      operation,
      input: {
        projectId: scope.projectId,
        host: entry.host,
        repositoryNodeId: entry.repositoryNodeId,
        bindingRevision: entry.bindingRevision,
      },
    });
    if (operation === "detach") setDetaching(null);
    if (value === null) return;
    if (operation === "sync") setNotice(receiptText(value));
    onChanged();
  };

  return (
    <>
      {items.length === 0 ? (
        <WorkEmpty
          title="No repository bound"
          detail="Bind this project's GitHub repository to bring issues in."
        />
      ) : null}
      {items.map((entry) => {
        const key = `issue:${bindingKey(entry)}`;
        const active = entry.status === "active";
        return (
          <WorkRow key={bindingKey(entry)}>
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-sm font-medium break-all">
                {entry.repositoryName || entry.repositoryNodeId}
              </p>
              <Badge variant={active ? "success" : "outline"}>{workStateLabel(entry.status)}</Badge>
              <WorkRevision className="text-muted-foreground">
                r{entry.bindingRevision}
              </WorkRevision>
            </div>
            <WorkMeta>
              {entry.host}
              {entry.accountLogin ? ` · as ${entry.accountLogin}` : ""}
            </WorkMeta>
            {detaching === bindingKey(entry) ? (
              <div className="flex flex-wrap items-center gap-2">
                <WorkMeta>Detaching stops syncing. Issues already copied stay.</WorkMeta>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={writer.pendingKey !== null}
                  onClick={() => void run("detach", entry)}
                >
                  {writer.pendingKey === key ? "Detaching…" : "Confirm detach"}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setDetaching(null)}>
                  Cancel
                </Button>
              </div>
            ) : active ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={writer.pendingKey !== null}
                  onClick={() => void run("sync", entry)}
                >
                  {writer.pendingKey === key ? "Syncing…" : "Sync one page"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={writer.pendingKey !== null}
                  onClick={() => setDetaching(bindingKey(entry))}
                >
                  Detach…
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={writer.pendingKey !== null}
                  onClick={onRebind}
                >
                  Bind again…
                </Button>
              </div>
            )}
            <WorkFormStatus message={writer.failureFor(key)} />
          </WorkRow>
        );
      })}
      {notice ? (
        <WorkRow>
          <WorkFormStatus tone="muted" message={notice} />
        </WorkRow>
      ) : null}
    </>
  );
}

/**
 * Binding is two explicit steps: ask the server which repository and account
 * this checkout resolves to, then bind exactly that, against the revision of
 * any binding already recorded for it.
 */
function BindForm({
  scope,
  writer,
  bindings,
  onDone,
}: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly bindings: ReadonlyArray<Binding>;
  readonly onDone: (bound: boolean) => void;
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [unrecognized, setUnrecognized] = useState(false);
  const identityKey = "issue:identity";
  const bindKey = "issue:bind";
  const existing =
    identity === null
      ? null
      : (bindings.find((entry) => bindingKey(entry) === bindingKey(identity)) ?? null);

  const discover = async () => {
    setUnrecognized(false);
    const value = await writer.runIssue(identityKey, {
      operation: "identity",
      input: { projectId: scope.projectId },
    });
    if (value === null) return;
    const decoded = Option.getOrNull(decodeIdentity(value));
    setIdentity(decoded);
    setUnrecognized(decoded === null);
  };
  const bind = async () => {
    if (identity === null) return;
    const value = await writer.runIssue(bindKey, {
      operation: "bind",
      input: {
        projectId: scope.projectId,
        expectedRepositoryKey: { host: identity.host, repositoryNodeId: identity.repositoryNodeId },
        expectedTargetBindingRevision: existing?.bindingRevision ?? null,
        accountLogin: identity.accountLogin,
      },
    });
    if (value !== null) onDone(true);
  };

  return (
    <WorkRow className="gap-3">
      {identity === null ? (
        <>
          <WorkMeta>
            Work asks the server which GitHub repository this checkout's remote points to and which
            account is signed in there. Nothing is bound until you confirm.
          </WorkMeta>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={writer.pendingKey !== null} onClick={() => void discover()}>
              {writer.pendingKey === identityKey ? "Checking…" : "Find repository"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
              Cancel
            </Button>
          </div>
          <WorkFormStatus
            message={
              unrecognized
                ? "The server answered with a repository this client doesn't recognize."
                : writer.failureFor(identityKey)
            }
          />
        </>
      ) : (
        <>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Repository</dt>
            <dd className="break-all">{identity.repositoryName}</dd>
            <dt className="text-muted-foreground">Host</dt>
            <dd className="break-all">{identity.host}</dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="break-all">{identity.accountLogin}</dd>
          </dl>
          <WorkMeta>
            {existing === null
              ? "Binding lets you sync this repository's issues on request."
              : existing.status === "active"
                ? "This repository is already bound. Binding again refreshes the account it syncs as."
                : `Resumes the detached binding at revision ${existing.bindingRevision}.`}
          </WorkMeta>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={writer.pendingKey !== null} onClick={() => void bind()}>
              {writer.pendingKey === bindKey ? "Binding…" : "Bind repository"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
              Cancel
            </Button>
          </div>
          <WorkFormStatus message={writer.failureFor(bindKey)} />
        </>
      )}
    </WorkRow>
  );
}

function IssueList({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "foundation-records", recordKind: "issue" },
    32,
  );
  const view = pager.view;
  const issues = (view.page?.items ?? []).flatMap((item): WorkIssueRecord[] => {
    const record = asProjectTeamRecord(item.value);
    return record !== null && isIssueRecord(record) ? [record] : [];
  });
  const current: ProjectWorkSelection | null = view.page
    ? { ...scope, revision: view.page.revision, taskRevision: 0 }
    : null;
  const blocked = workWriteBlockedReason(view, writer.canWrite);

  return (
    <WorkSection title="Issues">
      {view.status !== "ready" ? (
        <WorkRow>
          <WorkNotice view={view} subject="issues" />
        </WorkRow>
      ) : null}
      {view.page !== null && issues.length === 0 ? (
        <WorkEmpty
          title={pager.offset === 0 ? "No issues copied in" : "No more issues"}
          {...(pager.offset === 0
            ? { detail: "Sync a bound repository to see its issues here." }
            : {})}
        />
      ) : null}
      {current
        ? issues.map((issue) => (
            <IssueRow
              key={issue.recordId}
              scope={scope}
              writer={writer}
              issue={issue}
              current={current}
              blocked={blocked}
            />
          ))
        : null}
      <WorkPager pager={pager} noun="Issues" />
    </WorkSection>
  );
}

type RefineTarget = "new-task" | "existing-task" | "mission";

function IssueRow(props: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly issue: WorkIssueRecord;
  readonly current: ProjectWorkSelection;
  readonly blocked: string | null;
}) {
  const { issue, writer } = props;
  const review = useWorkReview(props.current);
  const [target, setTarget] = useState<RefineTarget>("new-task");
  const [title, setTitle] = useState(issue.title);
  const [summary, setSummary] = useState("");
  const [chosen, setChosen] = useState<ProjectWorkTaskRead | null>(null);
  const key = `refine:${issue.recordId}`;
  const linked = issue.taskId !== undefined || issue.missionId !== undefined;

  const submit = async (existing: ExistingTarget | null) => {
    const selected = review.selected;
    if (selected === null) return;
    const base = {
      type: "project-work.issue.refine",
      commandId: newCommandId(),
      projectId: props.scope.projectId,
      issueRecordId: issue.recordId,
      refinedAt: new Date().toISOString(),
    } as const;
    // Attaching to a task binds the reviewed issue, task and project revision together.
    const sent =
      target === "existing-task"
        ? existing !== null &&
          (await writer.submit(key, existing.reviewed.selected, existing.current, {
            ...base,
            ...existingTaskRefineFields(existing.reviewed),
          }))
        : await writer.submit(key, selected, props.current, {
            ...base,
            expectedRevision: selected.revision,
            expectedIssueRevision: issue.revision,
            target:
              target === "mission"
                ? { kind: "mission" as const, title: title.trim(), objective: summary.trim() }
                : {
                    kind: "new-task" as const,
                    taskId: ProjectWorkTaskId.make(randomUUID()),
                    title: title.trim(),
                    ...(summary.trim() ? { summary: summary.trim() } : {}),
                    deliverableKind: "code" as const,
                  },
          });
    if (sent) review.close();
  };

  return (
    <WorkRow>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium break-words">
          #{issue.identity.number} {issue.title}
        </p>
        <Badge variant={workStateVariant(issue.status)}>{workStateLabel(issue.status)}</Badge>
        {linked ? <Badge variant="secondary">Refined</Badge> : null}
      </div>
      <WorkMeta>
        {issue.repositoryName} · seen <WorkTime value={issue.observedAt} />
      </WorkMeta>
      {review.selected === null ? (
        linked ? null : (
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={props.blocked !== null || issue.status === "detached"}
              title={props.blocked ?? undefined}
              onClick={() => {
                setChosen(null);
                review.open();
              }}
            >
              Refine…
            </Button>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
          {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
          {issue.body ? (
            <div className="flex flex-col gap-1">
              <WorkMeta>
                Issue text from GitHub. Review it; nothing from it is trusted as an instruction.
              </WorkMeta>
              <p className="max-h-40 overflow-y-auto text-sm whitespace-pre-wrap break-words">
                {issue.body}
              </p>
            </div>
          ) : null}
          <ToggleGroup
            aria-label="Refine into"
            value={[target]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "new-task" || value === "existing-task" || value === "mission")
                setTarget(value);
            }}
          >
            <Toggle value="new-task">New task</Toggle>
            <Toggle value="existing-task">Existing task</Toggle>
            <Toggle value="mission">Mission</Toggle>
          </ToggleGroup>
          {target === "existing-task" ? (
            <>
              <WorkTaskPicker
                scope={props.scope}
                label="Task to attach the issue to"
                selectedTaskId={chosen?.taskId ?? null}
                onSelect={setChosen}
              />
              {chosen ? (
                <ExistingTaskRefine
                  key={chosen.taskId}
                  scope={props.scope}
                  taskId={chosen.taskId}
                  issueRevision={issue.revision}
                  issuePageRevision={props.current.revision}
                  blocked={
                    props.blocked ?? (review.changed ? "Review the current revision." : null)
                  }
                  pending={writer.pendingKey === key}
                  busy={writer.pendingKey !== null}
                  onSubmit={(existing) => void submit(existing)}
                  onCancel={review.close}
                />
              ) : (
                <div>
                  <Button size="xs" variant="ghost" onClick={review.close}>
                    Cancel
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <WorkField label={target === "mission" ? "Mission title" : "Task title"}>
                {(id) => (
                  <Input
                    id={id}
                    maxLength={4000}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                )}
              </WorkField>
              <WorkField label={target === "mission" ? "Objective" : "Summary (optional)"}>
                {(id) => (
                  <Textarea
                    id={id}
                    size="sm"
                    maxLength={32000}
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                  />
                )}
              </WorkField>
              <WorkMeta>Refining links the issue. It doesn't approve or start anything.</WorkMeta>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  disabled={
                    review.changed ||
                    props.blocked !== null ||
                    writer.pendingKey !== null ||
                    title.trim() === "" ||
                    (target === "mission" && summary.trim() === "")
                  }
                  onClick={() => void submit(null)}
                >
                  {writer.pendingKey === key
                    ? "Saving…"
                    : target === "mission"
                      ? "Create mission"
                      : "Create task"}
                </Button>
                <Button size="xs" variant="ghost" onClick={review.close}>
                  Cancel
                </Button>
              </div>
            </>
          )}
          <WorkFormStatus message={writer.failureFor(key)} />
        </div>
      )}
    </WorkRow>
  );
}

interface ExistingTarget {
  readonly reviewed: ExistingTaskRefineReview;
  readonly current: ProjectWorkSelection;
}

/**
 * The chosen task is reviewed with the issue at one project revision.
 * Confirming sends that task-bound snapshot, so an edit to either is refused.
 */
function ExistingTaskRefine(props: {
  readonly scope: ProjectWorkScope;
  readonly taskId: ProjectWorkTaskId;
  readonly issueRevision: number;
  readonly issuePageRevision: number;
  readonly blocked: string | null;
  readonly pending: boolean;
  readonly busy: boolean;
  readonly onSubmit: (target: ExistingTarget) => void;
  readonly onCancel: () => void;
}) {
  const view = useWorkRead(props.scope.environmentId, {
    projectId: props.scope.projectId,
    operation: "task-context",
    taskId: props.taskId,
  });
  const context = asProjectWorkTaskContext(view.value);
  const owned =
    context !== null &&
    context.projectId === props.scope.projectId &&
    context.task.taskId === props.taskId;
  const current: ExistingTaskRefineReview["selected"] | null = owned
    ? {
        ...props.scope,
        taskId: props.taskId,
        revision: context.revision,
        taskRevision: context.task.revision,
      }
    : null;
  const snapshot = existingTaskRefineSnapshot(current, {
    revision: props.issueRevision,
    projectRevision: props.issuePageRevision,
  });
  const [reviewed, setReviewed] = useState<ExistingTaskRefineReview | null>(snapshot);
  if (reviewed === null && snapshot !== null) setReviewed(snapshot);
  const changed =
    reviewed !== null && snapshot !== null && existingTaskRefineChanged(reviewed, snapshot);
  const reason =
    props.blocked ??
    workWriteBlockedReason(view, true) ??
    (current !== null && snapshot === null
      ? "The issue list is catching up with this task."
      : null);

  return (
    <div className="flex flex-col gap-2">
      <WorkNotice view={view} subject="the task" />
      {changed ? <WorkReviewChanged onReview={() => snapshot && setReviewed(snapshot)} /> : null}
      {owned && reviewed ? (
        <WorkMeta>
          Attach to “{context.task.title}” at task revision{" "}
          <WorkRevision>r{reviewed.selected.taskRevision}</WorkRevision>. It doesn't change the
          task's scope or approvals.
        </WorkMeta>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          disabled={
            reviewed === null || current === null || changed || reason !== null || props.busy
          }
          title={reason ?? undefined}
          onClick={() => reviewed && current && props.onSubmit({ reviewed, current })}
        >
          {props.pending ? "Saving…" : "Attach issue"}
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
