import { ProjectWorkApprovalId } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { makeProjectWorkSimpleTaskCommand } from "./workMutations";
import {
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
  WorkTime,
} from "./WorkLayout";
import { WorkReviewChanged } from "./WorkNotice";
import {
  decisionChanged,
  decisionSnapshot,
  type WorkDecisionResponse as Response,
  type WorkDecisionSnapshot,
} from "./workLogic";
import { gateResponses, shortHash, workStateVariant, type WorkApprovalStep } from "./workModel";
import { bindingPhase, recordsOfKind, startAvailability } from "./workPresentation";
import { guidedFields, newCommandId, type WorkTaskSurface } from "./workTaskSurface";

const RESPONSE_LABEL: Record<Response, string> = {
  approved: "Approve",
  rejected: "Reject",
  invalidated: "Revoke decision",
};

const STATE_LABEL: Record<WorkApprovalStep["state"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  pending: "Waiting",
  stale: "Needs approval again",
  missing: "Not proposed",
};

/**
 * The approval ledger for one task: which exact revision a human decided on,
 * whether that decision still holds, and that approving never starts work.
 */
export function WorkApprovalRow({ surface }: { surface: WorkTaskSurface }) {
  const { model, context, writer } = surface;
  const [pending, setPending] = useState<WorkDecisionSnapshot | null>(null);
  const key = "approval";
  const approveAction = context.policy.actions.approve;

  const confirm = async () => {
    if (pending === null) return;
    const step = model.steps.find((entry) => entry.id === pending.step);
    if (decisionChanged(pending, step, surface.current)) return;
    let intent: unknown = null;
    if (model.guided) {
      const gate = step?.gate ?? null;
      if (gate !== null)
        intent = {
          ...guidedFields(surface, pending.selected),
          type: "project-team.gate.respond",
          specRevision: gate.specRevision,
          planRevision: gate.planRevision,
          gateId: gate.recordId,
          expectedGateRevision: gate.revision,
          response: pending.response,
        };
    } else if (pending.response === "approved") {
      intent = makeProjectWorkSimpleTaskCommand("project-work.task.approve", {
        projectId: surface.scope.projectId,
        taskId: context.task.taskId,
        expectedRevision: pending.selected.revision,
        commandId: newCommandId(),
        now: new Date().toISOString(),
        approvalId: ProjectWorkApprovalId.make(randomUUID()),
        specRevision: pending.revision ?? context.task.specRevision,
      });
    }
    const sent = await writer.submit(key, pending.selected, surface.current, intent);
    if (sent) setPending(null);
  };

  const responsesFor = (step: WorkApprovalStep): ReadonlyArray<Response> => {
    if (model.guided) return gateResponses(step.gate);
    return step.state === "pending" || step.state === "stale"
      ? approveAction.available
        ? ["approved"]
        : []
      : [];
  };
  const unavailableReason = model.blockedReason ?? surface.blocked;
  const execution = executionState(surface);

  return (
    <WorkSection
      title="Approvals"
      description="A human decision covers one exact revision. Changing the scope or plan voids it."
    >
      {model.steps.map((step) => {
        const responses = responsesFor(step);
        const deciding = pending?.step === step.id ? pending : null;
        const changed = deciding !== null && decisionChanged(deciding, step, surface.current);
        return (
          <WorkRow key={step.id}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="w-16 shrink-0 text-sm font-medium">{step.label}</span>
              <WorkRevision className="w-8 text-muted-foreground">
                {step.revision === null ? "–" : `r${step.revision}`}
              </WorkRevision>
              <Badge variant={workStateVariant(step.state)}>{STATE_LABEL[step.state]}</Badge>
              {step.hash ? (
                <WorkRevision className="text-muted-foreground" title={step.hash}>
                  {shortHash(step.hash)}
                </WorkRevision>
              ) : null}
              <span className="min-w-0 flex-1" />
              {deciding === null
                ? responses.map((response) => (
                    <Button
                      key={response}
                      size="xs"
                      variant={response === "approved" ? "default" : "outline"}
                      disabled={unavailableReason !== null || writer.pendingKey !== null}
                      title={unavailableReason ?? undefined}
                      onClick={() => setPending(decisionSnapshot(step, response, surface.current))}
                    >
                      {RESPONSE_LABEL[response]}
                    </Button>
                  ))
                : null}
            </div>
            <WorkMeta>
              {step.detail}
              {step.id === "specification" &&
              !model.guided &&
              !approveAction.available &&
              approveAction.reason
                ? ` ${approveAction.reason}`
                : ""}
            </WorkMeta>
            {deciding ? (
              <DecisionConfirmation
                pending={deciding}
                changed={changed}
                unavailable={unavailableReason}
                busy={writer.pendingKey !== null}
                saving={writer.pendingKey === key}
                failure={writer.failureFor(key)}
                onConfirm={() => void confirm()}
                onReview={() => {
                  const stillOffered = responsesFor(step).includes(deciding.response);
                  setPending(
                    stillOffered
                      ? decisionSnapshot(step, deciding.response, surface.current)
                      : null,
                  );
                }}
                onCancel={() => setPending(null)}
              />
            ) : null}
          </WorkRow>
        );
      })}
      {model.guided ? (
        <WorkRow>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="w-16 shrink-0 text-sm font-medium">Execution</span>
            <WorkRevision className="w-8 text-muted-foreground">–</WorkRevision>
            <Badge variant={execution.tone}>{execution.label}</Badge>
          </div>
          <WorkMeta>{execution.detail}</WorkMeta>
        </WorkRow>
      ) : null}
      {model.invalidated.slice(0, 3).map((gate) => (
        <WorkRow key={gate.recordId}>
          <WorkMeta>
            {gate.gate === "plan" ? "Plan" : "Scope"} decision for revision{" "}
            <WorkRevision>
              r{gate.gate === "plan" ? gate.planRevision : gate.specRevision}
            </WorkRevision>{" "}
            was voided <WorkTime value={gate.updatedAt} /> because the scope changed.
          </WorkMeta>
        </WorkRow>
      ))}
      {unavailableReason ? (
        <WorkRow>
          <WorkFormStatus tone="muted" message={unavailableReason} />
        </WorkRow>
      ) : null}
    </WorkSection>
  );
}

/** Approval and starting stay separate: this only reports whether a worker has started. */
function executionState(surface: WorkTaskSurface) {
  const live = recordsOfKind(surface.records, "run-binding").find(
    (binding) => bindingPhase(binding.status).live,
  );
  if (live !== undefined) {
    const phase = bindingPhase(live.status);
    return {
      label: phase.label,
      tone: phase.tone,
      detail: "A worker is on this task. See Workers.",
    };
  }
  const start = startAvailability({
    membership: surface.model.membership,
    records: surface.records,
    terminal: surface.model.terminal,
  });
  return "plan" in start
    ? {
        label: "Ready to start",
        tone: "info" as const,
        detail: "Approved. Nothing runs until someone starts a worker in Workers.",
      }
    : { label: "Not started", tone: "outline" as const, detail: start.reason };
}

function DecisionConfirmation(props: {
  readonly pending: WorkDecisionSnapshot;
  readonly changed: boolean;
  readonly unavailable: string | null;
  readonly busy: boolean;
  readonly saving: boolean;
  readonly failure: string | null;
  readonly onConfirm: () => void;
  readonly onReview: () => void;
  readonly onCancel: () => void;
}) {
  const { pending } = props;
  const verb = RESPONSE_LABEL[pending.response];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
      {props.changed ? <WorkReviewChanged onReview={props.onReview} /> : null}
      <p className="text-sm">
        {verb} {pending.label.toLowerCase()} revision{" "}
        <WorkRevision>{pending.revision}</WorkRevision>
        {pending.hash ? (
          <>
            {" "}
            with content <WorkRevision title={pending.hash}>{shortHash(pending.hash)}</WorkRevision>
          </>
        ) : null}
        ?
      </p>
      <WorkMeta>
        {pending.response === "invalidated"
          ? "This withdraws the recorded decision. The scope or plan stays as written."
          : "This records your decision only. It does not start any work."}
      </WorkMeta>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant={pending.response === "approved" ? "default" : "outline"}
          disabled={props.changed || props.unavailable !== null || props.busy}
          title={props.unavailable ?? undefined}
          onClick={props.onConfirm}
        >
          {props.saving ? "Saving…" : `Confirm ${verb.toLowerCase()}`}
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {props.unavailable !== null && !props.changed ? (
        <WorkFormStatus tone="muted" message={props.unavailable} />
      ) : null}
      <WorkFormStatus message={props.failure} />
    </div>
  );
}
