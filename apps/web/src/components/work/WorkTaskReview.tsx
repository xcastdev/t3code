import type { ProjectWorkCriterionId } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
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
import { WorkNotice, WorkReviewChanged } from "./WorkNotice";
import { useWorkRead } from "./useWorkRead";
import { gateResponses, shortHash, workStateLabel, workStateVariant } from "./workModel";
import {
  bindingPhase,
  deliveryGates,
  findingFreshness,
  FRESHNESS_LABEL,
  FRESHNESS_TONE,
  gateFreshness,
  makeVerificationProposal,
  recordsOfKind,
  reviewSummary,
  splitArguments,
  type WorkGate,
} from "./workPresentation";
import { guidedFields, teamFields, useWorkReview, type WorkTaskSurface } from "./workTaskSurface";

const GATE_LABEL: Record<string, string> = {
  verification: "Run checks",
  publication: "Open pull request",
  merge: "Merge",
};
const RESPONSE_LABEL = { approved: "Approve", rejected: "Reject", invalidated: "Revoke" } as const;

/**
 * What independent review and verification found for the current revisions,
 * and the exact gates a human approves before checks run or code ships.
 */
export function WorkTaskReview({ surface }: { surface: WorkTaskSurface }) {
  const { model, context } = surface;
  if (!model.guided) return null;
  const current = {
    specRevision: context.task.specRevision,
    planRevision: model.plan?.planRevision ?? null,
  };
  const gates = deliveryGates(surface.records);
  const findings = recordsOfKind(surface.records, "review-finding").toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const evidence = recordsOfKind(surface.records, "evidence-applicability").toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const summary = reviewSummary(findings, current);
  const nothing = gates.length === 0 && findings.length === 0 && evidence.length === 0;

  return (
    <WorkSection
      title="Review and checks"
      description={
        findings.length > 0
          ? `${summary.open} open · ${summary.stale} on an older revision · ${summary.resolved} resolved`
          : "Checks and review results bind to one exact revision. Newer scope makes them out of date."
      }
    >
      {nothing ? <WorkEmpty title="No checks or review yet" /> : null}
      {gates.map((gate) => (
        <GateRow key={gate.recordId} surface={surface} gate={gate} current={current} />
      ))}
      {findings.slice(0, 16).map((finding) => {
        const freshness = findingFreshness(finding, current);
        return (
          <WorkRow key={finding.recordId}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={finding.status === "resolved" ? "success" : "warning"}>
                {finding.status === "resolved" ? "Resolved" : "Finding"}
              </Badge>
              {finding.status === "open" ? (
                <Badge variant={FRESHNESS_TONE[freshness]}>{FRESHNESS_LABEL[freshness]}</Badge>
              ) : null}
              <WorkMeta>
                Scope <WorkRevision>r{finding.target.specRevision}</WorkRevision> · plan{" "}
                <WorkRevision>r{finding.target.planRevision}</WorkRevision> · head{" "}
                <WorkRevision>{finding.target.headSha.slice(0, 8)}</WorkRevision>
              </WorkMeta>
            </div>
            <p className="line-clamp-6 text-sm whitespace-pre-wrap break-words">{finding.detail}</p>
            {finding.status === "resolved" ? (
              <WorkMeta>
                Resolved with {finding.resolutionArtifactIds.length} recorded{" "}
                {finding.resolutionArtifactIds.length === 1 ? "artifact" : "artifacts"}.
              </WorkMeta>
            ) : freshness === "stale" ? (
              <WorkMeta>
                Raised on an older revision. A fresh review decides if it still holds.
              </WorkMeta>
            ) : null}
          </WorkRow>
        );
      })}
      {evidence.slice(0, 8).map((entry) => (
        <WorkRow key={entry.recordId}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                entry.status === "current"
                  ? entry.exitCode === 0
                    ? "success"
                    : "error"
                  : "outline"
              }
            >
              {entry.status === "current"
                ? entry.exitCode === 0
                  ? "Passed"
                  : `Failed (exit ${entry.exitCode})`
                : workStateLabel(entry.status)}
            </Badge>
            {entry.integration ? <Badge variant="outline">Integration</Badge> : null}
            <WorkMeta>
              Tested{" "}
              <WorkRevision>{(entry.testedCommit ?? entry.headSha).slice(0, 8)}</WorkRevision> ·{" "}
              <WorkTime value={entry.updatedAt} />
            </WorkMeta>
          </div>
          <p className="font-mono text-xs break-all">{entry.command}</p>
          {entry.status !== "current" ? (
            <WorkMeta>This result is for older code or scope and doesn't count now.</WorkMeta>
          ) : null}
        </WorkRow>
      ))}
      <ProposeVerification surface={surface} />
    </WorkSection>
  );
}

function GateRow({
  surface,
  gate,
  current,
}: {
  surface: WorkTaskSurface;
  gate: WorkGate;
  current: { specRevision: number; planRevision: number | null };
}) {
  const { writer } = surface;
  const [showJob, setShowJob] = useState(false);
  const [confirming, setConfirming] = useState<keyof typeof RESPONSE_LABEL | null>(null);
  const review = useWorkReview(surface.current);
  const freshness = gateFreshness(gate, current);
  const responses =
    freshness === "current"
      ? gateResponses(gate)
      : gateResponses(gate).filter((r) => r === "invalidated");
  const blocked = surface.model.blockedReason ?? surface.blocked;
  const key = `gate:${gate.recordId}`;
  const respond = async () => {
    if (confirming === null || review.selected === null) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...guidedFields(surface, review.selected),
      type: "project-team.gate.respond",
      specRevision: gate.specRevision,
      planRevision: gate.planRevision,
      gateId: gate.recordId,
      expectedGateRevision: gate.revision,
      response: confirming,
    });
    if (sent) {
      setConfirming(null);
      review.close();
    }
  };
  return (
    <WorkRow className="gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          {GATE_LABEL[gate.gate] ?? workStateLabel(gate.gate)}
        </span>
        <Badge variant={workStateVariant(gate.status)}>{workStateLabel(gate.status)}</Badge>
        <Badge variant={FRESHNESS_TONE[freshness]}>{FRESHNESS_LABEL[freshness]}</Badge>
        <WorkRevision className="text-muted-foreground" title={gate.contentHash}>
          {shortHash(gate.contentHash)}
        </WorkRevision>
        <span className="min-w-0 flex-1" />
        {gate.verificationJobId !== undefined ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showJob}
            onClick={() => setShowJob(!showJob)}
          >
            {showJob ? "Hide command" : "Show exact command"}
          </Button>
        ) : null}
        {confirming === null
          ? responses.map((response) => (
              <Button
                key={response}
                size="xs"
                variant={response === "approved" ? "default" : "outline"}
                disabled={blocked !== null || writer.pendingKey !== null}
                title={blocked ?? undefined}
                onClick={() => {
                  setConfirming(response);
                  review.open();
                }}
              >
                {RESPONSE_LABEL[response]}
              </Button>
            ))
          : null}
      </div>
      {gate.repository || gate.targetBranch ? (
        <WorkMeta className="break-all">
          {gate.repository}
          {gate.pullRequestNumber !== undefined ? ` #${gate.pullRequestNumber}` : ""}
          {gate.targetBranch ? ` → ${gate.targetBranch}` : ""}
          {gate.headSha ? ` · head ${gate.headSha.slice(0, 8)}` : ""}
          {gate.mergeMethod ? ` · ${gate.mergeMethod}` : ""}
        </WorkMeta>
      ) : null}
      {freshness === "stale" && gate.status !== "invalidated" ? (
        <WorkMeta>
          The scope or plan changed after this was proposed, so it can't be approved.
        </WorkMeta>
      ) : null}
      {showJob && gate.verificationJobId !== undefined ? (
        <VerificationJob surface={surface} jobId={gate.verificationJobId} gate={gate} />
      ) : null}
      {confirming !== null ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
          {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
          <p className="text-sm">
            {RESPONSE_LABEL[confirming]} {(GATE_LABEL[gate.gate] ?? gate.gate).toLowerCase()} for
            content <WorkRevision>{shortHash(gate.contentHash)}</WorkRevision>?
          </p>
          <WorkMeta>
            {confirming === "approved"
              ? gate.gate === "verification"
                ? "This runs exactly the command shown, once, on the recorded commit."
                : "This allows that one step. You still publish or merge it yourself."
              : "This records your decision only."}
          </WorkMeta>
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={review.changed || blocked !== null || writer.pendingKey !== null}
              onClick={() => void respond()}
            >
              {writer.pendingKey === key
                ? "Saving…"
                : `Confirm ${RESPONSE_LABEL[confirming].toLowerCase()}`}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setConfirming(null);
                review.close();
              }}
            >
              Cancel
            </Button>
          </div>
          <WorkFormStatus message={writer.failureFor(key)} />
        </div>
      ) : null}
    </WorkRow>
  );
}

/** Loaded only when opened: the exact executable, arguments and target this gate covers. */
function VerificationJob({
  surface,
  jobId,
  gate,
}: {
  surface: WorkTaskSurface;
  jobId: string;
  gate: WorkGate;
}) {
  const view = useWorkRead(surface.scope.environmentId, {
    projectId: surface.scope.projectId,
    operation: "verification-job",
    taskId: surface.context.task.taskId,
    verificationJobId: jobId,
  });
  const job = view.special?.operation === "verification-job" ? view.special.value : null;
  if (job === null)
    return (
      <div>
        <WorkNotice view={view} subject="the check" />
        {view.status === "ready" ? (
          <WorkMeta>This check's details aren't available.</WorkMeta>
        ) : null}
      </div>
    );
  const manifest = job.manifest;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="font-mono text-xs break-all">
        {[manifest.command.executable, ...manifest.command.argv].join(" ")}
      </p>
      <WorkMeta className="break-all">
        {manifest.target.branchRef} · commit{" "}
        <WorkRevision>{manifest.target.testedCommit.slice(0, 12)}</WorkRevision> ·{" "}
        {manifest.criteria.length} {manifest.criteria.length === 1 ? "criterion" : "criteria"} · up
        to {Math.round(manifest.command.limits.maxDurationMs / 1000)}s
      </WorkMeta>
      {job.sha256 !== gate.contentHash ? (
        <WorkMeta className="text-warning-foreground">
          This command doesn't match what the gate recorded. Don't approve it.
        </WorkMeta>
      ) : null}
    </div>
  );
}

/** A proposal only; the host captures the exact target and asks for approval before running. */
function ProposeVerification({ surface }: { surface: WorkTaskSurface }) {
  const { writer, context, model } = surface;
  const review = useWorkReview(surface.current);
  const [criteria, setCriteria] = useState<ReadonlyArray<ProjectWorkCriterionId>>([]);
  const [executable, setExecutable] = useState("");
  const [args, setArgs] = useState("");
  const [seconds, setSeconds] = useState("600");
  const key = "verification:propose";
  const binding = recordsOfKind(surface.records, "run-binding")
    .filter((entry) => entry.status === "settled" || bindingPhase(entry.status).live)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const blocked = model.blockedReason ?? surface.blocked;
  if (binding === undefined || model.plan === null) return null;
  const duration = Number.parseInt(seconds, 10);
  const valid =
    criteria.length > 0 &&
    /^(?:\/|[A-Za-z]:[\\/])/u.test(executable.trim()) &&
    Number.isSafeInteger(duration) &&
    duration > 0 &&
    duration <= 3600;

  if (review.selected === null)
    return (
      <WorkRow>
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={blocked !== null || writer.pendingKey !== null}
            title={blocked ?? undefined}
            onClick={review.open}
          >
            Propose a check…
          </Button>
        </div>
      </WorkRow>
    );

  const send = async () => {
    if (review.selected === null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeVerificationProposal(teamFields(surface, review.selected), {
        jobId: randomUUID(),
        binding,
        criterionIds: criteria,
        executable,
        argv: splitArguments(args),
        maxDurationMs: duration * 1000,
        maxOutputBytes: 262_144,
      }),
    );
    if (sent) {
      review.close();
      setCriteria([]);
    }
  };

  return (
    <WorkRow className="gap-3">
      {review.changed ? <WorkReviewChanged onReview={review.rebase} /> : null}
      <p className="text-sm font-medium">Propose a check</p>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          Criteria it checks
        </legend>
        {context.criteria.map((criterion) => {
          const checked = criteria.includes(criterion.criterionId);
          return (
            <div key={criterion.criterionId} className="flex items-start gap-2">
              <Checkbox
                id={`check-criterion-${criterion.criterionId}`}
                checked={checked}
                onCheckedChange={(next) =>
                  setCriteria(
                    next
                      ? [...criteria, criterion.criterionId]
                      : criteria.filter((id) => id !== criterion.criterionId),
                  )
                }
              />
              <Label htmlFor={`check-criterion-${criterion.criterionId}`}>
                {criterion.description}
              </Label>
            </div>
          );
        })}
      </fieldset>
      <WorkField label="Program" hint="Absolute path. Runs directly, without a shell.">
        {(id) => (
          <Input
            id={id}
            size="sm"
            value={executable}
            placeholder="/usr/bin/env"
            onChange={(event) => setExecutable(event.target.value)}
          />
        )}
      </WorkField>
      <WorkField label="Arguments">
        {(id) => (
          <Input id={id} size="sm" value={args} onChange={(event) => setArgs(event.target.value)} />
        )}
      </WorkField>
      <WorkField label="Time limit (seconds)">
        {(id) => (
          <Input
            id={id}
            size="sm"
            inputMode="numeric"
            value={seconds}
            onChange={(event) => setSeconds(event.target.value)}
          />
        )}
      </WorkField>
      <WorkMeta>
        Runs on the worker's last committed result ({binding.branch ?? "checkout"}). Nothing runs
        until you approve the exact command it captures.
      </WorkMeta>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid || review.changed || blocked !== null || writer.pendingKey !== null}
          onClick={() => void send()}
        >
          {writer.pendingKey === key ? "Saving…" : "Propose check"}
        </Button>
        <Button size="sm" variant="ghost" onClick={review.close}>
          Cancel
        </Button>
      </div>
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}
