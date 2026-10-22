import {
  ProjectWorkApprovalId,
  ProjectWorkCriterionId,
  type ProjectWorkCriterionRead,
  type ProjectWorkTaskId,
  type ProjectWorkTaskRead,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  makeProjectWorkCriterionUpsertCommand,
  makeProjectWorkCriterionWaiveCommand,
  makeProjectWorkSimpleTaskCommand,
} from "./workMutations";
import { WorkReviewChanged } from "./WorkNotice";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
} from "./WorkLayout";
import { buildProtectedRevision } from "./workLogic";
import { shortHash, workStateLabel, workStateVariant } from "./workModel";
import { WorkTaskLink, WorkTaskPicker } from "./WorkTaskRefs";
import { guidedFields, newCommandId, useWorkReview, type WorkTaskSurface } from "./workTaskSurface";

const humanAttribution = (now: string) => ({
  // The server replaces this with the authenticated session's attribution.
  actor: { kind: "human" as const },
  source: { kind: isElectron ? ("desktop" as const) : ("web" as const) },
  recordedAt: now,
});

function FormActions({
  pending,
  submitLabel,
  disabled,
  onSubmit,
  onCancel,
}: {
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled || pending} onClick={onSubmit}>
        {pending ? "Saving…" : submitLabel}
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

type ScopeMode = "edit" | "protect" | "revise-protected" | null;

export function WorkTaskScope({ surface }: { surface: WorkTaskSurface }) {
  const { context, model } = surface;
  const task = context.task;
  const spec = task.specification;
  const specifyAction = context.policy.actions.specify;
  const protectAction = context.policy.actions["protect-specification"];
  const reviseProtectedAction = context.policy.actions["revise-protected-specification"];
  const editReason = spec?.protected
    ? "This scope is protected. Changes go through an approved protected revision."
    : model.guided
      ? model.terminal
        ? "Reopen the task before changing its scope."
        : (model.blockedReason ?? surface.blocked)
      : !specifyAction.available
        ? (specifyAction.reason ?? "The scope can't change in this state.")
        : surface.blocked;
  const protectReason = protectAction.available
    ? (model.blockedReason ?? surface.blocked)
    : (protectAction.reason ?? "This scope can't be protected in this state.");
  const reviseReason = reviseProtectedAction.available
    ? (model.blockedReason ?? surface.blocked)
    : (reviseProtectedAction.reason ?? "A protected revision isn't available in this state.");
  const [mode, setMode] = useState<ScopeMode>(null);
  const done = () => setMode(null);

  return (
    <WorkSection
      title="Scope"
      description={
        spec ? (
          <>
            Revision <WorkRevision>r{task.specRevision}</WorkRevision>
            {spec.protected ? " · protected" : ""}
          </>
        ) : (
          "No specification yet."
        )
      }
      actions={
        mode !== null ? null : spec?.protected ? (
          <Button
            size="xs"
            variant="outline"
            disabled={reviseReason !== null}
            title={reviseReason ?? undefined}
            onClick={() => setMode("revise-protected")}
          >
            Revise protected scope…
          </Button>
        ) : (
          <>
            {spec ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={protectReason !== null}
                title={protectReason ?? undefined}
                onClick={() => setMode("protect")}
              >
                Protect…
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={editReason !== null}
              title={editReason ?? undefined}
              onClick={() => setMode("edit")}
            >
              {spec ? (model.guided ? "Propose revision" : "Edit scope") : "Write scope"}
            </Button>
          </>
        )
      }
    >
      {mode === "edit" ? (
        model.guided ? (
          <GuidedScopeForm surface={surface} onDone={done} />
        ) : (
          <OrdinaryScopeForm surface={surface} onDone={done} />
        )
      ) : mode === "protect" ? (
        <ProtectScopeConfirm surface={surface} unavailable={protectReason} onDone={done} />
      ) : mode === "revise-protected" ? (
        <ProtectedRevisionForm surface={surface} unavailable={reviseReason} onDone={done} />
      ) : spec ? (
        <WorkRow className="gap-2">
          <p className="text-sm font-medium whitespace-pre-wrap break-words">{spec.objective}</p>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[6rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Included</dt>
            <dd className="whitespace-pre-wrap break-words">{spec.scopeIn}</dd>
            <dt className="text-muted-foreground">Excluded</dt>
            <dd className="whitespace-pre-wrap break-words">{spec.scopeOut}</dd>
          </dl>
        </WorkRow>
      ) : (
        <WorkEmpty
          title="No scope yet"
          detail="Describe the objective, what is included and what is out, then add acceptance criteria."
        />
      )}
      {mode === null && (spec?.protected ? reviseReason : editReason) !== null ? (
        <WorkRow>
          <WorkFormStatus tone="muted" message={spec?.protected ? reviseReason : editReason} />
        </WorkRow>
      ) : null}
      <WorkCriteria surface={surface} />
    </WorkSection>
  );
}

function ProtectScopeConfirm({
  surface,
  unavailable,
  onDone,
}: {
  surface: WorkTaskSurface;
  unavailable: string | null;
  onDone: () => void;
}) {
  const { context, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current, true);
  const [specRevision] = useState(task.specRevision);
  const key = "scope:protect";
  const changed = review.changed || specRevision !== task.specRevision;
  const submit = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeProjectWorkSimpleTaskCommand("project-work.task.protect-specification", {
        projectId: surface.scope.projectId,
        taskId: task.taskId,
        expectedRevision: review.selected.revision,
        commandId: newCommandId(),
        now: new Date().toISOString(),
        specRevision,
      }),
    );
    if (sent) onDone();
  };
  return (
    <WorkRow className="gap-2">
      {changed ? <WorkReviewChanged onReview={onDone} /> : null}
      <p className="text-sm">
        Protect scope revision <WorkRevision>r{specRevision}</WorkRevision>?
      </p>
      <WorkMeta>
        After this, the scope only changes through a protected revision that you review and approve
        as a whole. Protection can't be removed.
      </WorkMeta>
      <FormActions
        pending={writer.pendingKey === key}
        submitLabel="Protect scope"
        disabled={changed || unavailable !== null}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

function ProtectedRevisionForm({
  surface,
  unavailable,
  onDone,
}: {
  surface: WorkTaskSurface;
  unavailable: string | null;
  onDone: () => void;
}) {
  const { context, writer } = surface;
  const task = context.task;
  const spec = task.specification;
  const review = useWorkReview(surface.current, true);
  const [objective, setObjective] = useState(spec?.objective ?? "");
  const [scopeIn, setScopeIn] = useState(spec?.scopeIn ?? "");
  const [scopeOut, setScopeOut] = useState(spec?.scopeOut ?? "");
  const [prepared, setPrepared] = useState<ReturnType<typeof buildProtectedRevision> | null>(null);
  const key = "scope:protected-revision";
  const complete = objective.trim() !== "" && scopeIn.trim() !== "" && scopeOut.trim() !== "";
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPrepared(null);
  };

  const prepare = () => {
    if (review.selected === null) return;
    const now = new Date().toISOString();
    setPrepared(
      buildProtectedRevision({
        context,
        expectedRevision: review.selected.revision,
        commandId: newCommandId(),
        approvalId: ProjectWorkApprovalId.make(randomUUID()),
        objective: objective.trim(),
        scopeIn: scopeIn.trim(),
        scopeOut: scopeOut.trim(),
        revisedAt: now,
        attribution: humanAttribution(now),
      }),
    );
  };
  const submit = async () => {
    if (review.selected === null || prepared === null || !("command" in prepared)) return;
    const sent = await writer.submit(key, review.selected, surface.current, prepared.command);
    if (sent) onDone();
  };
  const command = prepared !== null && "command" in prepared ? prepared.command : null;

  return (
    <WorkRow className="gap-3">
      {review.changed ? (
        <WorkReviewChanged
          onReview={() => {
            setPrepared(null);
            review.rebase();
          }}
        />
      ) : null}
      <ScopeFields
        objective={objective}
        scopeIn={scopeIn}
        scopeOut={scopeOut}
        onObjective={edit(setObjective)}
        onScopeIn={edit(setScopeIn)}
        onScopeOut={edit(setScopeOut)}
      />
      <WorkMeta>
        The {spec?.criterionIds.length ?? 0} acceptance criteria stay exactly as recorded. No worker
        results exist while execution is off, so none are marked affected.
      </WorkMeta>
      {command ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
          <p className="text-sm">
            Approve protected revision{" "}
            <WorkRevision>r{command.specification.revision}</WorkRevision> with fingerprint{" "}
            <WorkRevision title={command.approval.payloadFingerprint}>
              {shortHash(command.approval.payloadFingerprint)}
            </WorkRevision>
            ?
          </p>
          <WorkMeta>
            Your approval covers this exact text and criteria. It records the revision only and
            doesn't start any work.
          </WorkMeta>
          <FormActions
            pending={writer.pendingKey === key}
            submitLabel="Approve protected revision"
            disabled={review.changed || unavailable !== null}
            onSubmit={() => void submit()}
            onCancel={() => setPrepared(null)}
          />
        </div>
      ) : (
        <FormActions
          pending={false}
          submitLabel="Review revision"
          disabled={!complete || review.changed || unavailable !== null}
          onSubmit={prepare}
          onCancel={onDone}
        />
      )}
      <WorkFormStatus
        message={
          prepared !== null && "reason" in prepared ? prepared.reason : writer.failureFor(key)
        }
      />
    </WorkRow>
  );
}

interface CriterionDraft {
  readonly criterionId: ProjectWorkCriterionId;
  readonly description: string;
  readonly required: boolean;
  readonly existing: ProjectWorkCriterionRead | null;
}

function GuidedScopeForm({ surface, onDone }: { surface: WorkTaskSurface; onDone: () => void }) {
  const { context, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current, true);
  const [objective, setObjective] = useState(task.specification?.objective ?? task.title);
  const [scopeIn, setScopeIn] = useState(task.specification?.scopeIn ?? "");
  const [scopeOut, setScopeOut] = useState(task.specification?.scopeOut ?? "");
  const [criteria, setCriteria] = useState<ReadonlyArray<CriterionDraft>>(() =>
    context.criteria.length > 0
      ? context.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          description: criterion.description,
          required: criterion.required,
          existing: criterion,
        }))
      : [
          {
            criterionId: ProjectWorkCriterionId.make(randomUUID()),
            description: "",
            required: true,
            existing: null,
          },
        ],
  );
  const key = "scope";
  const complete =
    objective.trim() !== "" &&
    scopeIn.trim() !== "" &&
    scopeOut.trim() !== "" &&
    criteria.length > 0 &&
    criteria.every((criterion) => criterion.description.trim() !== "");

  const submit = async () => {
    if (review.selected === null) return;
    const now = new Date().toISOString();
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...guidedFields(surface, review.selected),
      type: "project-team.specification.propose",
      expectedSpecRevision: task.specRevision,
      specification: {
        objective: objective.trim(),
        scopeIn: scopeIn.trim(),
        scopeOut: scopeOut.trim(),
        criterionIds: criteria.map((criterion) => criterion.criterionId),
        revision: task.specRevision + 1,
        protected: false,
      },
      // Proposing resets satisfaction and waivers; the server derives new criterion revisions.
      criterionSnapshots: criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        taskId: task.taskId,
        description: criterion.description.trim(),
        required: criterion.required,
        status: "unsatisfied" as const,
        satisfiedByEvidenceIds: [],
        revision: criterion.existing?.revision ?? 0,
        updatedAt: criterion.existing?.updatedAt ?? now,
      })),
    });
    if (sent) onDone();
  };

  return (
    <WorkRow className="gap-3">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <ScopeFields
        objective={objective}
        scopeIn={scopeIn}
        scopeOut={scopeOut}
        onObjective={setObjective}
        onScopeIn={setScopeIn}
        onScopeOut={setScopeOut}
      />
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Acceptance criteria</span>
        {criteria.map((criterion, index) => (
          <div key={criterion.criterionId} className="flex items-start gap-2">
            <Input
              aria-label={`Acceptance criterion ${index + 1}`}
              value={criterion.description}
              onChange={(event) =>
                setCriteria(
                  criteria.map((entry) =>
                    entry.criterionId === criterion.criterionId
                      ? { ...entry, description: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            {criterion.existing === null && criteria.length > 1 ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove acceptance criterion ${index + 1}`}
                onClick={() =>
                  setCriteria(
                    criteria.filter((entry) => entry.criterionId !== criterion.criterionId),
                  )
                }
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ))}
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={criteria.length >= 64}
            onClick={() =>
              setCriteria([
                ...criteria,
                {
                  criterionId: ProjectWorkCriterionId.make(randomUUID()),
                  description: "",
                  required: true,
                  existing: null,
                },
              ])
            }
          >
            <PlusIcon /> Add criterion
          </Button>
        </div>
      </div>
      <WorkMeta>
        Proposing revision <WorkRevision>r{task.specRevision + 1}</WorkRevision> clears criterion
        progress and waivers and voids earlier scope and plan approvals.
      </WorkMeta>
      <FormActions
        pending={writer.pendingKey === key}
        submitLabel="Propose scope"
        disabled={!complete || review.changed || surface.blocked !== null}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

function OrdinaryScopeForm({ surface, onDone }: { surface: WorkTaskSurface; onDone: () => void }) {
  const { context, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current, true);
  const [objective, setObjective] = useState(task.specification?.objective ?? task.title);
  const [scopeIn, setScopeIn] = useState(task.specification?.scopeIn ?? "");
  const [scopeOut, setScopeOut] = useState(task.specification?.scopeOut ?? "");
  const key = "scope";
  const criterionIds = context.criteria.map((criterion) => criterion.criterionId);
  const complete =
    objective.trim() !== "" &&
    scopeIn.trim() !== "" &&
    scopeOut.trim() !== "" &&
    criterionIds.length > 0;

  const submit = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      type: "project-work.task.specify",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      taskId: task.taskId,
      expectedRevision: review.selected.revision,
      specification: {
        objective: objective.trim(),
        scopeIn: scopeIn.trim(),
        scopeOut: scopeOut.trim(),
        criterionIds,
        revision: task.specRevision + 1,
        protected: false,
      },
      updatedAt: new Date().toISOString(),
    });
    if (sent) onDone();
  };

  return (
    <WorkRow className="gap-3">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <ScopeFields
        objective={objective}
        scopeIn={scopeIn}
        scopeOut={scopeOut}
        onObjective={setObjective}
        onScopeIn={setScopeIn}
        onScopeOut={setScopeOut}
      />
      <WorkMeta>
        {criterionIds.length === 0
          ? "Add at least one acceptance criterion below before writing the scope."
          : `The scope covers all ${criterionIds.length} acceptance criteria below. Saving voids an earlier approval.`}
      </WorkMeta>
      <FormActions
        pending={writer.pendingKey === key}
        submitLabel="Save scope"
        disabled={!complete || review.changed || surface.blocked !== null}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

function ScopeFields(props: {
  readonly objective: string;
  readonly scopeIn: string;
  readonly scopeOut: string;
  readonly onObjective: (value: string) => void;
  readonly onScopeIn: (value: string) => void;
  readonly onScopeOut: (value: string) => void;
}) {
  return (
    <>
      <WorkField label="Objective">
        {(id) => (
          <Textarea
            id={id}
            size="sm"
            maxLength={4000}
            value={props.objective}
            onChange={(event) => props.onObjective(event.target.value)}
          />
        )}
      </WorkField>
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkField label="Included">
          {(id) => (
            <Textarea
              id={id}
              size="sm"
              maxLength={4000}
              value={props.scopeIn}
              onChange={(event) => props.onScopeIn(event.target.value)}
            />
          )}
        </WorkField>
        <WorkField label="Excluded">
          {(id) => (
            <Textarea
              id={id}
              size="sm"
              maxLength={4000}
              value={props.scopeOut}
              onChange={(event) => props.onScopeOut(event.target.value)}
            />
          )}
        </WorkField>
      </div>
    </>
  );
}

function WorkCriteria({ surface }: { surface: WorkTaskSurface }) {
  const { context, model } = surface;
  const criteria = context.criteria;
  const [adding, setAdding] = useState(false);
  const canAdd = !model.guided && context.policy.actions.specify.available;
  return (
    <>
      <WorkRow className="flex-row items-center justify-between gap-2 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          Acceptance criteria · {criteria.length}
        </span>
        {canAdd && !adding ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={surface.blocked !== null}
            onClick={() => setAdding(true)}
          >
            <PlusIcon /> Add criterion
          </Button>
        ) : null}
      </WorkRow>
      {adding ? <AddCriterionForm surface={surface} onDone={() => setAdding(false)} /> : null}
      {criteria.map((criterion) => (
        <CriterionRow key={criterion.criterionId} surface={surface} criterion={criterion} />
      ))}
    </>
  );
}

function AddCriterionForm({ surface, onDone }: { surface: WorkTaskSurface; onDone: () => void }) {
  const { writer, context } = surface;
  const review = useWorkReview(surface.current, true);
  const [description, setDescription] = useState("");
  const key = "criterion:add";
  const submit = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeProjectWorkCriterionUpsertCommand({
        projectId: surface.scope.projectId,
        taskId: context.task.taskId,
        taskRevision: review.selected.revision,
        criterionId: ProjectWorkCriterionId.make(randomUUID()),
        commandId: newCommandId(),
        description: description.trim(),
        updatedAt: new Date().toISOString(),
      }),
    );
    if (sent) onDone();
  };
  return (
    <WorkRow className="gap-2">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <WorkField label="New acceptance criterion">
        {(id) => (
          <Input
            id={id}
            maxLength={4000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </WorkField>
      <FormActions
        pending={writer.pendingKey === key}
        submitLabel="Add criterion"
        disabled={description.trim() === "" || review.changed || surface.blocked !== null}
        onSubmit={() => void submit()}
        onCancel={onDone}
      />
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

function waiverUnavailable(surface: WorkTaskSurface, task: ProjectWorkTaskRead): string | null {
  const { model, context } = surface;
  if (surface.blocked !== null) return surface.blocked;
  if (task.specification?.protected)
    return "Protected scopes change waivers only through a protected revision.";
  if (model.guided) {
    if (model.terminal) return "Reopen the task before changing a waiver.";
    if (model.specificationHash === null)
      return "Waivers bind to the current scope approval request, which isn't recorded yet.";
    return model.blockedReason;
  }
  const action = context.policy.actions["waive-criterion"];
  return action.available ? null : (action.reason ?? "Waivers aren't available in this state.");
}

function ordinaryRevokeUnavailable(surface: WorkTaskSurface): string | null {
  if (surface.blocked !== null) return surface.blocked;
  const action = surface.context.policy.actions["revoke-criterion-waiver"];
  return action.available
    ? null
    : (action.reason ?? "This waiver can't be revoked in the task's current state.");
}

/** Summaries of the evidence records a criterion or waiver cites, from the loaded task. */
function EvidenceRefs({
  surface,
  label,
  evidenceIds,
}: {
  surface: WorkTaskSurface;
  label: string;
  evidenceIds: ReadonlyArray<string>;
}) {
  if (evidenceIds.length === 0) return null;
  const found = surface.context.evidence.filter((evidence) =>
    evidenceIds.includes(evidence.evidenceId),
  );
  const missing = evidenceIds.length - found.length;
  return (
    <WorkMeta className="break-words">
      {label}: {found.map((evidence) => evidence.summary).join(" · ")}
      {missing > 0 ? `${found.length > 0 ? " · " : ""}${missing} record(s) not on this task` : ""}
    </WorkMeta>
  );
}

function CriterionRow({
  surface,
  criterion,
}: {
  surface: WorkTaskSurface;
  criterion: ProjectWorkCriterionRead;
}) {
  const { context, model, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current);
  const [reason, setReason] = useState("");
  const key = `waiver:${criterion.criterionId}`;
  const waived = criterion.waiver !== undefined;
  const unavailable = waived
    ? model.guided
      ? waiverUnavailable(surface, task)
      : ordinaryRevokeUnavailable(surface)
    : waiverUnavailable(surface, task);
  // Guided revocation is a gate action; an ordinary revocation records why.
  const reasonRequired = !waived || !model.guided;

  const send = async () => {
    if (review.selected === null) return;
    const now = new Date().toISOString();
    const intent = model.guided
      ? {
          ...guidedFields(surface, review.selected),
          type: "project-team.criterion.waiver",
          criterionId: criterion.criterionId,
          expectedCriterionRevision: criterion.revision,
          expectedSpecRevision: task.specRevision,
          expectedSpecificationHash: model.specificationHash,
          action: waived
            ? { kind: "revoke" }
            : { kind: "waive", reason: reason.trim(), evidenceIds: [] },
        }
      : waived
        ? {
            type: "project-work.criterion.revoke-waiver",
            commandId: newCommandId(),
            projectId: surface.scope.projectId,
            expectedRevision: review.selected.revision,
            taskId: task.taskId,
            expectedTaskRevision: review.selected.taskRevision,
            criterionId: criterion.criterionId,
            expectedCriterionRevision: criterion.revision,
            expectedSpecRevision: task.specRevision,
            reason: reason.trim(),
            attribution: humanAttribution(now),
            revokedAt: now,
          }
        : makeProjectWorkCriterionWaiveCommand({
            projectId: surface.scope.projectId,
            taskId: task.taskId,
            criterion,
            expectedRevision: review.selected.revision,
            commandId: newCommandId(),
            reason: reason.trim(),
            specRevision: task.specRevision,
            evidenceIds: [],
            waivedAt: now,
            attribution: humanAttribution(now),
          });
    const sent = await writer.submit(key, review.selected, surface.current, intent);
    if (sent) {
      review.close();
      setReason("");
    }
  };

  return (
    <WorkRow>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <p className="min-w-0 flex-1 text-sm break-words">{criterion.description}</p>
        <Badge variant={workStateVariant(criterion.status)}>
          {workStateLabel(criterion.status)}
        </Badge>
        {criterion.required ? null : <Badge variant="outline">Optional</Badge>}
      </div>
      <EvidenceRefs
        surface={surface}
        label="Supported by"
        evidenceIds={criterion.satisfiedByEvidenceIds}
      />
      {criterion.waiver ? (
        <>
          <WorkMeta>
            Waived for revision <WorkRevision>r{criterion.waiver.specRevision}</WorkRevision>
            {criterion.waiver.attribution.actor.displayName
              ? ` by ${criterion.waiver.attribution.actor.displayName}`
              : ""}
            : {criterion.waiver.reason}
          </WorkMeta>
          <EvidenceRefs
            surface={surface}
            label="Waiver cites"
            evidenceIds={criterion.waiver.evidenceIds}
          />
        </>
      ) : null}
      {review.selected === null ? (
        criterion.status === "waived" && !waived ? null : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={unavailable !== null}
              title={unavailable ?? undefined}
              onClick={review.open}
            >
              {waived ? "Revoke waiver…" : "Waive…"}
            </Button>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
          {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
          {waived ? (
            <WorkMeta>
              Revoking restores this criterion as unmet and voids the current scope approval. The
              original waiver stays in the task history.
            </WorkMeta>
          ) : null}
          {reasonRequired ? (
            <WorkField
              label={waived ? "Why revoke this waiver?" : "Why is this criterion waived?"}
              hint={waived ? undefined : "Waiving voids the current scope approval."}
            >
              {(id) => (
                <Textarea
                  id={id}
                  size="sm"
                  maxLength={4000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </WorkField>
          ) : null}
          <FormActions
            pending={writer.pendingKey === key}
            submitLabel={waived ? "Revoke waiver" : "Waive criterion"}
            disabled={
              review.changed || unavailable !== null || (reasonRequired && reason.trim() === "")
            }
            onSubmit={() => void send()}
            onCancel={review.close}
          />
          <WorkFormStatus message={writer.failureFor(key)} />
        </div>
      )}
    </WorkRow>
  );
}

export function WorkTaskPlan({
  surface,
  onOpenTask,
}: {
  surface: WorkTaskSurface;
  onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { context, model, writer } = surface;
  const task = context.task;
  const plan = model.plan;
  const review = useWorkReview(surface.current);
  const [content, setContent] = useState(plan?.content ?? "");
  const [dependencies, setDependencies] = useState<ReadonlyArray<ProjectWorkTaskId>>(
    plan?.dependencyTaskIds ?? [],
  );
  const [choosing, setChoosing] = useState(false);
  const key = "plan";
  const unavailable =
    task.specification === undefined
      ? "Propose a scope before the plan."
      : model.terminal
        ? "Reopen the task before changing its plan."
        : (model.blockedReason ?? surface.blocked);

  const submit = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...guidedFields(surface, review.selected),
      type: "project-team.plan.propose",
      specRevision: task.specRevision,
      content: content.trim(),
      dependencyTaskIds: dependencies,
      ...(plan
        ? { previousPlanId: plan.recordId, expectedPreviousPlanRevision: plan.revision }
        : {}),
    });
    if (sent) review.close();
  };

  return (
    <WorkSection
      title="Plan"
      description={
        plan ? (
          <>
            Revision <WorkRevision>r{plan.planRevision}</WorkRevision> for scope{" "}
            <WorkRevision>r{plan.specRevision}</WorkRevision>
            {model.planCurrent ? "" : " · out of date"}
          </>
        ) : (
          "No plan yet."
        )
      }
      actions={
        review.selected === null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={unavailable !== null}
            title={unavailable ?? undefined}
            onClick={() => {
              setContent(plan?.content ?? "");
              setDependencies(plan?.dependencyTaskIds ?? []);
              setChoosing(false);
              review.open();
            }}
          >
            {plan ? "Propose revision" : "Write plan"}
          </Button>
        ) : null
      }
    >
      {review.selected !== null ? (
        <WorkRow className="gap-3">
          {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
          <WorkField label="Implementation and validation plan">
            {(id) => (
              <Textarea
                id={id}
                maxLength={32000}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            )}
          </WorkField>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Depends on</span>
            {dependencies.length === 0 ? <WorkMeta>No dependencies.</WorkMeta> : null}
            {dependencies.map((dependency) => (
              <div key={dependency} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <WorkTaskLink scope={surface.scope} taskId={dependency} onOpen={onOpenTask} />
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove dependency"
                  onClick={() =>
                    setDependencies(dependencies.filter((entry) => entry !== dependency))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            {choosing ? (
              <WorkTaskPicker
                scope={surface.scope}
                label="Add a dependency"
                selectedTaskId={null}
                excludeTaskIds={[task.taskId, ...dependencies]}
                onSelect={(choice) => {
                  setDependencies([...dependencies, choice.taskId]);
                  setChoosing(false);
                }}
              />
            ) : (
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={dependencies.length >= 64}
                  onClick={() => setChoosing(true)}
                >
                  <PlusIcon /> Add dependency
                </Button>
              </div>
            )}
          </div>
          <WorkMeta>A new plan revision voids an earlier plan approval.</WorkMeta>
          <FormActions
            pending={writer.pendingKey === key}
            submitLabel="Propose plan"
            disabled={content.trim() === "" || review.changed || unavailable !== null}
            onSubmit={() => void submit()}
            onCancel={review.close}
          />
          <WorkFormStatus message={writer.failureFor(key)} />
        </WorkRow>
      ) : plan ? (
        <WorkRow className="gap-2">
          <p className="text-sm whitespace-pre-wrap break-words">{plan.content}</p>
          {plan.dependencyTaskIds.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {plan.dependencyTaskIds.map((dependency) => (
                <WorkTaskLink
                  key={dependency}
                  scope={surface.scope}
                  taskId={dependency}
                  prefix="Depends on"
                  onOpen={onOpenTask}
                />
              ))}
            </div>
          ) : null}
        </WorkRow>
      ) : (
        <WorkEmpty title="No plan yet" detail="Write how the work will be done and checked." />
      )}
      {unavailable !== null && review.selected === null ? (
        <WorkRow>
          <WorkFormStatus tone="muted" message={unavailable} />
        </WorkRow>
      ) : null}
    </WorkSection>
  );
}
