import { readProjectWorkPublicationHistory } from "@t3tools/shared/projectWorkPublicationHistory";
import {
  ProjectTeamRecord,
  type ProjectTeamEffect,
  type ProjectTeamReviewFindingProvenance,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useOpenLink } from "../../browser/useOpenLink";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkCard } from "../../components/work/WorkDataNotice";
import { WorkTeamFoundation } from "../../components/work/WorkTeamFoundation";

const knownRecord = Schema.is(ProjectTeamRecord);
const PAGE_SIZE = 128;
const RELATED_LIMIT = 8;
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;

export interface EvidenceViewProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly onOpenTask: (id: ProjectWorkTaskId) => void;
  readonly taskId?: ProjectWorkTaskId;
}

/** Inspect bounded recorded metadata; policy and delivery authority stay on the server. */
export function Evidence(props: EvidenceViewProps) {
  return (
    <EvidenceSession
      key={JSON.stringify([props.environmentId, props.projectId, props.taskId ?? null])}
      {...props}
    />
  );
}

function EvidenceSession(props: EvidenceViewProps) {
  const [offset, setOffset] = useState(0);
  if (!props.supported)
    return (
      <p>
        This environment does not support evidence inspection. Recorded evidence remains accessible
        through supported project work views.
      </p>
    );
  return (
    <WorkTeamFoundation {...props}>
      {({ snapshot, current, refresh }) => {
        const records = snapshot.records
          .filter(knownRecord)
          .filter((record) => record.projectId === props.projectId);
        const selected = records.filter(
          (record) =>
            props.taskId === undefined || ("taskId" in record && record.taskId === props.taskId),
        );
        const evidence = selected.filter((record) => record.kind === "evidence-applicability");
        const publications = selected
          .filter((record) => record.kind === "effect")
          .filter((effect) => effect.effectKind === "publication");
        const gates = records.filter((record) => record.kind === "gate");
        const plans = records.filter((record) => record.kind === "plan-revision");
        const findings = selected.filter((record) => record.kind === "review-finding");
        const items = [...evidence, ...publications, ...findings];
        const start = offset < items.length ? offset : 0;
        const complete = props.connected && props.enabled && current;
        const updatedAt = selected.reduce(
          (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
          "",
        );
        return (
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Evidence and delivery records</h2>
              <p className="text-sm text-muted-foreground">
                {complete ? "Complete recorded snapshot" : "Cached or incomplete evidence"}
                {snapshot.revision !== null
                  ? ` · Project revision ${snapshot.revision}`
                  : " · Revision unknown"}
                {updatedAt ? ` · Last recorded update ${updatedAt}` : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                Recorded applicability does not establish current approval or delivery. Publication
                receipts do not confirm a merge.
              </p>
              {!props.enabled ? (
                <p>Project Work is disabled. Recorded metadata may be cached.</p>
              ) : null}
              {records.length !== snapshot.records.length ? (
                <p>
                  Unsupported or malformed records are present. Applicability is unknown for those
                  records.
                </p>
              ) : null}
              {!complete ? (
                <p className="text-sm text-muted-foreground">
                  Reconnect and refresh a complete snapshot to inspect the latest recorded metadata.
                </p>
              ) : null}
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                disabled={!props.connected || !props.enabled}
                onClick={refresh}
              >
                Refresh evidence
              </Button>
            </div>
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">No evidence records in this snapshot.</p>
            ) : null}
            {publications.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No publication records in this snapshot.
              </p>
            ) : null}
            {items.slice(start, start + PAGE_SIZE).map((item) => {
              if (item.kind === "review-finding")
                return (
                  <WorkCard key={item.recordId}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="break-all font-medium">Review finding {item.findingId}</h3>
                      <Badge variant="outline">Severity: {item.severity}</Badge>
                      <Badge variant="outline">Recorded finding status: {item.status}</Badge>
                    </div>
                    <p className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all text-sm">
                      {item.detail}
                    </p>
                    <dl className="mt-3 grid gap-2 text-sm">
                      <Metadata label="Parent task" value={item.taskId} />
                      <Metadata label="Parent criteria" value={item.criterionIds.join(" · ")} />
                      <Metadata
                        label="Resolution artifact references"
                        value={
                          item.resolutionArtifactIds.join(" · ") ||
                          "No resolution artifacts recorded"
                        }
                      />
                    </dl>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Recorded resolution does not establish current approval or verify the
                      referenced artifacts.
                    </p>
                    <dl className="mt-3 grid gap-2 text-xs text-muted-foreground">
                      <Metadata
                        label="Finding record"
                        value={`${item.recordId} · Revision ${item.revision}`}
                      />
                      <Metadata
                        label="Frozen target revisions"
                        value={`Spec revision ${item.target.specRevision} · Plan revision ${item.target.planRevision}`}
                      />
                      <Metadata label="Frozen base" value={item.target.baseSha} />
                      <Metadata label="Frozen head" value={item.target.headSha} />
                    </dl>
                    <FindingReviewer label="Original reviewer" reviewer={item.originReviewer} />
                    <FindingReviewer label="Latest reporter" reviewer={item.reportedBy} />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Last recorded update {item.updatedAt}
                    </p>
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={() => props.onOpenTask(item.taskId)}
                    >
                      Open task {item.taskId}
                    </Button>
                  </WorkCard>
                );
              const itemTaskId = item.taskId;
              const linkedGates = gates.filter(
                (gate) =>
                  gate.taskId === item.taskId &&
                  (item.kind === "evidence-applicability"
                    ? gate.evidenceIds.includes(item.evidenceId) ||
                      gate.evidenceIds.includes(item.recordId)
                    : gate.recordId === item.targetId ||
                      item.payload.recordIds.includes(gate.recordId)),
              );
              return (
                <WorkCard key={item.recordId}>
                  {item.kind === "evidence-applicability" ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="break-all font-medium">Evidence {item.evidenceId}</h3>
                        <Badge variant="outline">Recorded applicability: {item.status}</Badge>
                      </div>
                      <p className="mt-2 break-all text-sm">
                        Record {item.recordId} · Revision {item.revision} · Task {item.taskId}
                      </p>
                      <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
                        {item.command || "Command not recorded"}
                      </pre>
                      <dl className="mt-3 grid gap-2 text-sm">
                        <Metadata label="Command result" value={`Exit code ${item.exitCode}`} />
                        <Metadata label="Raw artifact ID" value={item.artifactId} />
                        <Metadata label="Repository" value={item.repository} />
                        <Metadata label="Tested worktree" value={item.worktree} />
                        <Metadata label="Tested tree" value={item.testedTree} />
                        <Metadata
                          label="Tested commit"
                          value={item.testedCommit ?? "Tested commit not recorded"}
                        />
                        <Metadata label="Recorded base" value={item.baseSha} />
                        <Metadata label="Recorded head" value={item.headSha} />
                        <Metadata
                          label="Applicable revisions"
                          value={`Spec revision ${item.specRevision} · Plan revision ${item.planRevision}`}
                        />
                        <Metadata label="Environment summary" value={item.environmentSummary} />
                        <Metadata
                          label="Integration"
                          value={`Integration evidence: ${item.integration ? "yes" : "no"}`}
                        />
                        {item.scopeHash ? (
                          <Metadata label="Recorded scope hash" value={item.scopeHash} />
                        ) : null}
                      </dl>
                      <p className="mt-2 text-sm text-muted-foreground">
                        A tested tree does not qualify a later commit. Artifact retention and
                        reviewed source qualification are not provided by this snapshot.
                      </p>
                      <div className="mt-3 text-sm">
                        <p className="font-medium">Recorded task plans</p>
                        {plans
                          .filter((plan) => plan.taskId === item.taskId)
                          .slice(0, RELATED_LIMIT)
                          .map((plan) => (
                            <p key={plan.recordId} className="break-all">
                              {plan.recordId} · {plan.status} · Spec revision {plan.specRevision} ·
                              Plan revision {plan.planRevision} · Content hash {plan.contentHash}
                            </p>
                          ))}
                        {!plans.some((plan) => plan.taskId === item.taskId) ? (
                          <p>No task plan recorded in this snapshot.</p>
                        ) : null}
                        {plans.filter((plan) => plan.taskId === item.taskId).length >
                        RELATED_LIMIT ? (
                          <p>More recorded plans are available in the task.</p>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <h3 className="break-all font-medium">Publication effect {item.effectId}</h3>
                      <Badge variant="outline">Recorded publication status: {item.status}</Badge>
                      <PublicationHistory key={`${item.recordId}:${item.revision}`} effect={item} />
                      <dl className="mt-3 grid gap-2 text-sm">
                        <Metadata
                          label="Effect record"
                          value={`${item.recordId} · Revision ${item.revision}`}
                        />
                        <Metadata
                          label="Task"
                          value={item.taskId ?? "Task identity not recorded"}
                        />
                        <Metadata label="Publication target" value={`Target ${item.targetId}`} />
                        <Metadata
                          label="Original request"
                          value={`Expected project revision ${item.payload.expectedRevision}`}
                        />
                        <Metadata
                          label="Referenced record IDs"
                          value={item.payload.recordIds.join(" · ") || "None recorded"}
                        />
                        <Metadata label="Claim generation" value={String(item.claimGeneration)} />
                        <Metadata label="Available at" value={item.availableAt} />
                        {item.runId ? <Metadata label="Recorded run" value={item.runId} /> : null}
                      </dl>
                    </>
                  )}
                  <div className="mt-3 flex flex-col gap-2 text-sm">
                    <p className="font-medium">Linked recorded gates</p>
                    {linkedGates.slice(0, RELATED_LIMIT).map((gate) => (
                      <RecordedGate key={gate.recordId} gate={gate} />
                    ))}
                    {linkedGates.length === 0 ? (
                      <p>No matching task gate recorded in this snapshot.</p>
                    ) : null}
                    {linkedGates.length > RELATED_LIMIT ? (
                      <p>More linked gates are available in the task.</p>
                    ) : null}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Last recorded update {item.updatedAt}
                  </p>
                  {itemTaskId ? (
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      onClick={() => props.onOpenTask(itemTaskId)}
                    >
                      Open task {itemTaskId}
                    </Button>
                  ) : null}
                </WorkCard>
              );
            })}
            <div className="flex gap-2">
              {start > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setOffset(start - PAGE_SIZE)}>
                  Previous evidence page
                </Button>
              ) : null}
              {start + PAGE_SIZE < items.length ? (
                <Button variant="outline" size="sm" onClick={() => setOffset(start + PAGE_SIZE)}>
                  Next evidence page
                </Button>
              ) : null}
            </div>
          </div>
        );
      }}
    </WorkTeamFoundation>
  );
}

function FindingReviewer({
  label,
  reviewer,
}: {
  readonly label: string;
  readonly reviewer: ProjectTeamReviewFindingProvenance;
}) {
  return (
    <div className="mt-3 text-xs text-muted-foreground">
      <p className="font-medium">{label}</p>
      <dl className="mt-1 grid gap-1">
        <Metadata
          label="Member and review task"
          value={`${reviewer.memberId} · Review task ${reviewer.reviewTaskId}`}
        />
        <Metadata
          label="Binding"
          value={`${reviewer.bindingId} · Generation ${reviewer.generation}`}
        />
        <Metadata
          label="Provider and session"
          value={`${reviewer.providerInstanceId} · Thread ${reviewer.threadId} · Session ${reviewer.sessionId}`}
        />
        <Metadata
          label="Initialization and dispatch"
          value={`${reviewer.initializeOperationId} · Dispatch ${reviewer.dispatchId}`}
        />
        <Metadata label="Review target hash" value={reviewer.targetSha256} />
      </dl>
    </div>
  );
}

function Metadata({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-all">{value}</dd>
    </div>
  );
}

function RecordedGate({ gate }: { readonly gate: Gate }) {
  return (
    <div className="rounded-md border border-border/70 p-2">
      <p className="break-all">
        Gate {gate.recordId} · {gate.gate} · Recorded gate status: {gate.status}
      </p>
      <p>
        Gate revision {gate.revision} · Spec revision {gate.specRevision} · Plan revision{" "}
        {gate.planRevision}
      </p>
      <p className="break-all">Content hash {gate.contentHash}</p>
      <p className="break-all">Recorded gate head {gate.headSha ?? "not recorded"}</p>
      {gate.repository ? <p className="break-all">Repository {gate.repository}</p> : null}
      {gate.pullRequestNumber !== undefined ? <p>PR number {gate.pullRequestNumber}</p> : null}
      {gate.targetBranch ? <p className="break-all">Target branch {gate.targetBranch}</p> : null}
      {gate.mergeMethod ? <p>Merge method {gate.mergeMethod}</p> : null}
    </div>
  );
}

function PublicationHistory({ effect }: { readonly effect: typeof ProjectTeamEffect.Type }) {
  const history = useMemo(() => readProjectWorkPublicationHistory(effect), [effect]);
  const openLink = useOpenLink(null);
  const [failed, setFailed] = useState(false);
  if (!history)
    return (
      <>
        <p className="mt-2 text-sm">PR publication is unconfirmed in this record.</p>
        <dl className="mt-2 grid gap-2 text-sm">
          <Metadata label="Recorded outcome" value={effect.outcome ?? "Outcome not recorded"} />
          {effect.payload.summary ? (
            <Metadata label="Recorded summary" value={effect.payload.summary} />
          ) : null}
        </dl>
      </>
    );
  const pr = history.pullRequest;
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="break-all font-medium">
        {history.repository.nameWithOwner} #{pr.number}
      </p>
      <p>Recorded PR state: {pr.state}</p>
      <dl className="grid gap-2">
        <Metadata label="Recorded at" value={history.observedAt} />
        <Metadata label="Recorded base" value={`${pr.baseRef} · ${pr.baseSha}`} />
        <Metadata label="Recorded head" value={`${pr.headRef} · ${pr.headSha}`} />
      </dl>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void openLink(pr.url).then(
            () => setFailed(false),
            () => setFailed(true),
          );
        }}
      >
        Open PR #{pr.number}
      </Button>
      {failed ? <p role="alert">Could not open the pull request. Try again.</p> : null}
    </div>
  );
}
