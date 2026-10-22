import {
  prepareProjectWorkRecoveredDelivery,
  projectWorkScopeKey,
} from "@t3tools/client-runtime/project-work";
import type {
  ProjectTeamIntegrationSourceRef,
  ProjectWorkDeliveryRequest,
  ProjectWorkDeliveryResult,
} from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
} from "./WorkLayout";
import { WorkNotice } from "./WorkNotice";
import { useWorkRead } from "./useWorkRead";
import {
  canPrepareDelivery,
  DELIVERY_PHASE_DETAIL,
  DELIVERY_STAGE,
  deliveryAvailability,
  deliveryProgress,
  integrationCoverage,
  moveIntegrationSource,
  planIntegrationRefs,
  recordsOfKind,
  toggleIntegrationSource,
  type WorkDeliverySource,
  type WorkDeliveryTrack,
  type WorkRecoveryItem,
} from "./workPresentation";
import { guidedFields, newCommandId, type WorkTaskSurface } from "./workTaskSurface";

/**
 * Ordered integration inputs, then pull request and merge as separate,
 * explicitly approved steps. Progress is rebuilt from the task's retained
 * delivery rows, so leaving or reloading never loses an operation.
 */
export function WorkTaskDelivery({ surface }: { surface: WorkTaskSurface }) {
  const { model } = surface;
  if (
    !model.guided ||
    model.membership?.executionKind !== "managed" ||
    model.membership.deliverableKind !== "code"
  )
    return null;
  return <DeliveryPanel surface={surface} />;
}

function DeliveryPanel({ surface }: { surface: WorkTaskSurface }) {
  const { scope, context, model, writer } = surface;
  const taskId = context.task.taskId;
  const [offset, setOffset] = useState(0);
  // Own-source search pages independently of the candidate list's offset.
  const [ownCursor, setOwnCursor] = useState<string | undefined>(undefined);
  const sourcesView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "integration-sources",
    taskId,
    limit: 16,
    offset,
    ...(ownCursor === undefined ? {} : { ownSourceCursor: ownCursor }),
  });
  const page =
    sourcesView.special?.operation === "integration-sources" ? sourcesView.special.value : null;
  // The task's own current reviewed result; absent until it passes independent review.
  const own = page?.ownSource ?? null;

  const [selected, setSelected] = useState<ProjectTeamIntegrationSourceRef[]>(() =>
    planIntegrationRefs(model.plan),
  );
  const coverage = integrationCoverage(selected, model.plan?.dependencyTaskIds ?? []);
  const blocked = model.blockedReason ?? surface.blocked;
  const planKey = "integration:plan";

  const proposePlan = () => {
    if (model.plan === null || selected.length === 0) return;
    const reviewed = surface.current;
    void writer.submit(planKey, reviewed, surface.current, {
      ...guidedFields(surface, reviewed),
      type: "project-team.plan.propose",
      specRevision: context.task.specRevision,
      content: model.plan.content,
      dependencyTaskIds: model.plan.dependencyTaskIds,
      integrationSourceRefs: selected,
      previousPlanId: model.plan.recordId,
      expectedPreviousPlanRevision: model.plan.revision,
    });
  };

  return (
    <WorkSection
      title="Integration and delivery"
      description="Choose reviewed inputs in order, then publish and merge, each with its own approval."
    >
      <WorkRow className="gap-2">
        <p className="text-sm font-medium">Reviewed inputs</p>
        <WorkNotice view={sourcesView} subject="reviewed inputs" />
        {page !== null && page.candidates.length === 0 && offset === 0 ? (
          <WorkMeta>No other task has passed review yet.</WorkMeta>
        ) : null}
        {page?.candidates.map((candidate) => {
          const index = selected.findIndex((entry) => entry.taskId === candidate.ref.taskId);
          return (
            <div key={candidate.ref.taskId} className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant={index >= 0 ? "default" : "outline"}
                aria-pressed={index >= 0}
                onClick={() => setSelected(toggleIntegrationSource(selected, candidate.ref))}
              >
                {index >= 0 ? `${index + 1}` : "Add"}
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm">{candidate.taskTitle}</span>
              <WorkRevision className="text-muted-foreground">
                {candidate.source.headSha.slice(0, 8)}
              </WorkRevision>
              {index >= 0 ? (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Move earlier"
                    disabled={index === 0}
                    onClick={() => setSelected(moveIntegrationSource(selected, index, -1))}
                  >
                    ↑
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Move later"
                    disabled={index === selected.length - 1}
                    onClick={() => setSelected(moveIntegrationSource(selected, index, 1))}
                  >
                    ↓
                  </Button>
                </>
              ) : null}
            </div>
          );
        })}
        {page !== null && (page.hasMore || offset > 0) ? (
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 16))}
            >
              Previous
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!page.hasMore}
              onClick={() => setOffset(page.nextOffset)}
            >
              Next
            </Button>
          </div>
        ) : null}
        {coverage.missing.length > 0 ? (
          <WorkMeta className="text-warning-foreground">
            {coverage.missing.length} plan{" "}
            {coverage.missing.length === 1 ? "dependency has" : "dependencies have"} no selected
            reviewed input.
          </WorkMeta>
        ) : null}
        {model.plan !== null ? (
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={selected.length === 0 || blocked !== null || writer.pendingKey !== null}
              title={blocked ?? undefined}
              onClick={proposePlan}
            >
              {writer.pendingKey === planKey ? "Saving…" : "Propose plan with these inputs"}
            </Button>
            <WorkMeta>The plan needs approval again before these inputs are used.</WorkMeta>
          </div>
        ) : null}
        <WorkFormStatus message={writer.failureFor(planKey)} />
      </WorkRow>
      {page === null ? (
        <WorkRow>
          <WorkNotice view={sourcesView} subject="this task's reviewed result" />
        </WorkRow>
      ) : own === null && page.ownSourceNextCursor !== undefined ? (
        <WorkRow className="gap-2">
          <WorkMeta>
            No current reviewed result among the latest reviews checked. Older reviews may still
            qualify.
          </WorkMeta>
          <div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setOwnCursor(page.ownSourceNextCursor)}
            >
              Search more reviewed work
            </Button>
          </div>
        </WorkRow>
      ) : null}
      <Delivery
        // A different environment, checkout or task starts with no retained operations.
        key={`${projectWorkScopeKey(scope)}:${taskId}`}
        surface={surface}
        source={
          own !== null
            ? "current"
            : page === null || page.ownSourceNextCursor !== undefined
              ? "checking"
              : "missing"
        }
        sourceRef={own?.ref ?? null}
        branch={own?.source.branchRef ?? null}
      />
    </WorkSection>
  );
}

function StageBadge({ result }: { result: ProjectWorkDeliveryResult | null | undefined }) {
  if (result === null || result === undefined) return null;
  const stage = DELIVERY_STAGE[result.stage];
  return <Badge variant={stage.tone}>{stage.label}</Badge>;
}

const RECOVERY_LIMIT = 32;

/**
 * Mounted for the task whether or not its reviewed source is still current: retained
 * operations and receipts stay reachable, and only new previews need `sourceRef`.
 */
function Delivery({
  surface,
  source,
  sourceRef,
  branch,
}: {
  surface: WorkTaskSurface;
  source: WorkDeliverySource;
  sourceRef: ProjectTeamIntegrationSourceRef | null;
  branch: string | null;
}) {
  const { scope, context, writer } = surface;
  const taskId = context.task.taskId;
  const [baseRef, setBaseRef] = useState("");
  const [title, setTitle] = useState(context.task.title);
  const [body, setBody] = useState(context.task.summary ?? "");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [accepted, setAccepted] = useState<ProjectWorkDeliveryResult | null>(null);
  // Reading never writes; every retry below is an explicit click on the original request.
  const recoveryView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "delivery-recovery",
    taskId,
    limit: RECOVERY_LIMIT,
  });
  const recovery =
    recoveryView.special?.operation === "delivery-recovery" ? recoveryView.special.value : null;
  const gates = recordsOfKind(surface.records, "gate");
  const progress = deliveryProgress(recovery?.items ?? [], gates);
  const { publication, merge } = progress;
  const availability = deliveryAvailability({ source, recovery });
  const blocked =
    surface.blocked ??
    (writer.canDeliver ? null : "This connection can't publish or merge on this environment.");
  const busy = writer.pendingKey !== null;

  /** The exact recorded request and its provenance, or null if the row no longer qualifies. */
  const recovered = (item: WorkRecoveryItem | null) =>
    item === null || recovery === null
      ? null
      : prepareProjectWorkRecoveredDelivery({
          selected: surface.current,
          current: surface.current,
          readScope: scope,
          recovery,
          operationId: item.result.operationId,
          operation: item.request.operation === "accept" ? "merge" : item.request.operation,
        });

  const preview = (kind: "create-pr" | "merge", target: string) => {
    const selected = surface.current;
    const publicationOperationId =
      publication.phase === "confirmed" ? publication.operation?.result.operationId : undefined;
    if (sourceRef === null || (kind === "merge" && publicationOperationId === undefined)) return;
    const request: Extract<ProjectWorkDeliveryRequest, { operation: "preview" }> = {
      operation: "preview",
      input: {
        commandId: newCommandId(),
        expectedRevision: selected.revision,
        projectId: scope.projectId,
        taskId,
        sourceRef,
        baseRef: target.trim(),
        kind,
        ...(kind === "merge" && publicationOperationId !== undefined
          ? { publicationOperationId, mergeMethod: method }
          : {}),
      },
    };
    void writer.runDelivery(`delivery:preview:${kind}`, selected, surface.current, request);
  };

  const publish = () => {
    if (publication.phase === "reconcile") {
      const original = recovered(publication.operation);
      if (original !== null)
        void writer.runDelivery(
          "delivery:publish",
          surface.current,
          surface.current,
          original.request,
        );
      return;
    }
    const reviewed = recovered(publication.preview);
    if (publication.phase !== "ready" || reviewed === null) return;
    const previewRequest = reviewed.request;
    if (previewRequest.operation !== "preview") return;
    void writer.runDelivery("delivery:publish", surface.current, surface.current, {
      operation: "publish",
      input: {
        operationId: reviewed.reviewedOperation.operationId,
        projectId: scope.projectId,
        taskId,
        gateId: publication.preview!.gateId,
        sourceRef: previewRequest.input.sourceRef,
        title: title.trim(),
        body,
      },
    });
  };

  const runMerge = () => {
    if (merge.phase === "reconcile") {
      const original = recovered(merge.operation);
      if (original !== null)
        void writer.runDelivery(
          "delivery:merge",
          surface.current,
          surface.current,
          original.request,
          original.reviewedOperation,
        );
      return;
    }
    const reviewed = recovered(merge.preview);
    const publicationOperationId = reviewed?.reviewedOperation.publicationOperationId;
    if (merge.phase !== "ready" || reviewed === null || publicationOperationId === undefined)
      return;
    void writer.runDelivery(
      "delivery:merge",
      surface.current,
      surface.current,
      {
        operation: "merge",
        input: {
          operationId: reviewed.reviewedOperation.operationId,
          publicationOperationId,
          gateId: merge.preview!.gateId,
        },
      },
      reviewed.reviewedOperation,
    );
  };

  // Acceptance uses the confirmed merge's server receipt exactly; the user never types it.
  const receipt =
    merge.phase === "confirmed" ? (recovered(merge.operation)?.reviewedOperation ?? null) : null;
  const accept = async () => {
    if (receipt === null || receipt.receiptHash === undefined) return;
    const result = await writer.runDelivery(
      "delivery:accept",
      surface.current,
      surface.current,
      {
        operation: "accept",
        input: { operationId: receipt.operationId, expectedReceiptHash: receipt.receiptHash },
      },
      receipt,
    );
    if (result !== null) setAccepted(result);
  };

  const pubResult = publication.operation?.result ?? null;
  const mergeResult = merge.operation?.result ?? null;
  const prepareBlocked = blocked ?? availability.prepareBlocked;
  const shownBranch =
    branch ??
    (publication.preview?.request.operation === "preview"
      ? publication.preview.request.input.sourceRef.expectedBranchRef
      : null);

  if (!availability.showTracks)
    return recovery === null ? (
      <WorkRow>
        <WorkNotice view={recoveryView} subject="delivery history" />
      </WorkRow>
    ) : source === "missing" ? (
      <WorkEmpty
        title="Nothing to deliver yet"
        detail="This task's result appears here after it passes independent review."
      />
    ) : null;

  return (
    <>
      <WorkRow className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Pull request</span>
          <StageBadge result={pubResult} />
          {pubResult?.pullRequest ? (
            <a
              className="text-sm underline"
              href={pubResult.pullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              #{pubResult.pullRequest.number}
            </a>
          ) : null}
        </div>
        {shownBranch !== null ? (
          <WorkMeta className="break-all">
            From {shownBranch}
            {publication.preview ? ` → ${publication.preview.baseRef}` : ""}
          </WorkMeta>
        ) : null}
        <WorkNotice view={recoveryView} subject="delivery history" />
        <WorkMeta>{DELIVERY_PHASE_DETAIL[publication.phase]}</WorkMeta>
        {canPrepareDelivery(publication.phase) && sourceRef !== null ? (
          <>
            <WorkField label="Target branch">
              {(id) => (
                <Input
                  id={id}
                  size="sm"
                  value={baseRef}
                  placeholder="main"
                  onChange={(e) => setBaseRef(e.target.value)}
                />
              )}
            </WorkField>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={baseRef.trim() === "" || prepareBlocked !== null || busy}
                title={prepareBlocked ?? undefined}
                onClick={() => preview("create-pr", baseRef)}
              >
                {writer.pendingKey === "delivery:preview:create-pr"
                  ? "Preparing…"
                  : publication.phase === "superseded"
                    ? "Prepare pull request again"
                    : "Prepare pull request"}
              </Button>
            </div>
          </>
        ) : null}
        {publication.phase === "ready" ? (
          <>
            <WorkField label="Title">
              {(id) => (
                <Input
                  id={id}
                  size="sm"
                  maxLength={4000}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              )}
            </WorkField>
            <WorkField label="Description">
              {(id) => (
                <Textarea
                  id={id}
                  size="sm"
                  maxLength={32000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              )}
            </WorkField>
            <div>
              <Button
                size="sm"
                disabled={
                  title.trim() === "" ||
                  blocked !== null ||
                  busy ||
                  recovered(publication.preview) === null
                }
                title={
                  recovered(publication.preview) === null
                    ? "Refreshing this task's delivery state."
                    : (blocked ?? undefined)
                }
                onClick={publish}
              >
                {writer.pendingKey === "delivery:publish" ? "Publishing…" : "Publish pull request"}
              </Button>
            </div>
          </>
        ) : null}
        {publication.phase === "reconcile" ? (
          <CheckAgain
            pending={writer.pendingKey === "delivery:publish"}
            disabled={blocked !== null || busy || recovered(publication.operation) === null}
            onClick={publish}
          />
        ) : null}
        <WorkFormStatus
          message={
            writer.failureFor("delivery:preview:create-pr") ?? writer.failureFor("delivery:publish")
          }
        />
      </WorkRow>
      {publication.phase === "confirmed" ? (
        <WorkRow className="gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Merge</span>
            <StageBadge result={mergeResult} />
            {mergeResult?.mergedCommitSha ? (
              <WorkRevision className="text-muted-foreground">
                {mergeResult.mergedCommitSha.slice(0, 12)}
              </WorkRevision>
            ) : null}
          </div>
          <WorkMeta>{DELIVERY_PHASE_DETAIL[merge.phase]}</WorkMeta>
          {canPrepareDelivery(merge.phase) && sourceRef !== null ? (
            <>
              {publication.preview === null ? (
                <WorkField label="Target branch">
                  {(id) => (
                    <Input
                      id={id}
                      size="sm"
                      value={baseRef}
                      placeholder="main"
                      onChange={(e) => setBaseRef(e.target.value)}
                    />
                  )}
                </WorkField>
              ) : null}
              <ToggleGroup
                aria-label="Merge method"
                value={[method]}
                onValueChange={(next) => {
                  if (next[0] === "merge" || next[0] === "squash" || next[0] === "rebase")
                    setMethod(next[0]);
                }}
              >
                <Toggle value="squash">Squash</Toggle>
                <Toggle value="merge">Merge commit</Toggle>
                <Toggle value="rebase">Rebase</Toggle>
              </ToggleGroup>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    (publication.preview?.baseRef ?? baseRef).trim() === "" ||
                    prepareBlocked !== null ||
                    busy
                  }
                  title={prepareBlocked ?? undefined}
                  // A merge targets the branch the published pull request was prepared against.
                  onClick={() => preview("merge", publication.preview?.baseRef ?? baseRef)}
                >
                  {writer.pendingKey === "delivery:preview:merge"
                    ? "Preparing…"
                    : merge.phase === "superseded"
                      ? "Prepare merge again"
                      : "Prepare merge"}
                </Button>
              </div>
            </>
          ) : null}
          {merge.phase === "ready" ? (
            <div>
              <Button
                size="sm"
                disabled={blocked !== null || busy || recovered(merge.preview) === null}
                title={
                  recovered(merge.preview) === null
                    ? "Refreshing this task's delivery state."
                    : (blocked ?? undefined)
                }
                onClick={runMerge}
              >
                {writer.pendingKey === "delivery:merge" ? "Merging…" : "Merge pull request"}
              </Button>
            </div>
          ) : null}
          {merge.phase === "reconcile" ? (
            <CheckAgain
              pending={writer.pendingKey === "delivery:merge"}
              disabled={blocked !== null || busy || recovered(merge.operation) === null}
              onClick={runMerge}
            />
          ) : null}
          {merge.phase === "confirmed" ? (
            accepted !== null ? (
              <WorkMeta>
                Delivery accepted. Criteria and the parent task are still decided separately.
              </WorkMeta>
            ) : (
              <>
                <WorkMeta>
                  Accepting records that this exact merge delivers the task. It doesn't complete the
                  task or its parent.
                </WorkMeta>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={receipt?.receiptHash === undefined || blocked !== null || busy}
                    title={
                      receipt?.receiptHash === undefined
                        ? "The server hasn't returned a merge receipt to accept."
                        : (blocked ?? undefined)
                    }
                    onClick={() => void accept()}
                  >
                    {writer.pendingKey === "delivery:accept" ? "Accepting…" : "Accept delivery"}
                  </Button>
                </div>
              </>
            )
          ) : null}
          <WorkFormStatus message={writer.failureFor("delivery:accept")} />
          <WorkFormStatus
            message={
              writer.failureFor("delivery:preview:merge") ?? writer.failureFor("delivery:merge")
            }
          />
        </WorkRow>
      ) : null}
      {recovery !== null && recovery.items.length > 0 ? (
        <DeliveryHistory items={recovery.items} gates={gates} current={[publication, merge]} />
      ) : null}
      {prepareBlocked !== null ? (
        <WorkRow>
          <WorkFormStatus tone="muted" message={prepareBlocked} />
        </WorkRow>
      ) : null}
    </>
  );
}

function CheckAgain(props: { pending: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <div>
      <Button size="sm" variant="outline" disabled={props.disabled} onClick={props.onClick}>
        {props.pending ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}

const HISTORY_KIND: Record<string, string> = {
  "create-pr": "Pull request",
  merge: "Merge",
  publish: "Pull request",
};

/** Every retained delivery step for this task, including superseded ones, as recorded. */
function DeliveryHistory({
  items,
  gates,
  current,
}: {
  items: ReadonlyArray<WorkRecoveryItem>;
  gates: ReadonlyArray<{ readonly recordId: string; readonly status: string }>;
  current: ReadonlyArray<WorkDeliveryTrack>;
}) {
  const [open, setOpen] = useState(false);
  const live = new Set(
    current.flatMap((entry) => [entry.preview, entry.operation]).filter((item) => item !== null),
  );
  return (
    <WorkRow className="gap-1.5">
      <div>
        <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          Delivery history ({items.length})
        </Button>
      </div>
      {open
        ? items.map((item) => {
            const gate = gates.find((entry) => entry.recordId === item.gateId);
            const kind =
              item.request.operation === "preview"
                ? `${HISTORY_KIND[item.request.input.kind]} preview`
                : (HISTORY_KIND[item.request.operation] ?? item.request.operation);
            return (
              <div
                key={`${item.request.operation}:${item.result.operationId}`}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="font-medium">{kind}</span>
                {item.request.operation === "preview" ? (
                  <Badge variant="outline">
                    Approval {gate === undefined ? "not loaded" : gate.status}
                  </Badge>
                ) : (
                  <StageBadge result={item.result} />
                )}
                <WorkRevision className="text-muted-foreground">
                  {item.result.operationId.slice(0, 12)}
                </WorkRevision>
                {live.has(item) ? <WorkMeta>current</WorkMeta> : null}
              </div>
            );
          })
        : null}
    </WorkRow>
  );
}
