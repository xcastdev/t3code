import {
  asProjectTeamRecord,
  asProjectWorkTaskContext,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProjectWorkApprovalId,
  ProjectWorkBlockerId,
  ProjectWorkCommentId,
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkRelationshipId,
  ProjectWorkTaskId,
  type ProjectTeamRecordRead,
  type ProjectWorkCriterionRead,
  type ProjectWorkRelationshipRead,
  type ProjectWorkTaskContext,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useProject } from "../../state/entities";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  WorkBlock,
  WorkFormActions,
  WorkInput,
  WorkReadNotice,
  WorkRecordsNotice,
  WorkScopeLabel,
  WorkTaskLink,
  WorkTaskPicker,
  WorkText,
} from "./WorkParts";
import {
  humanAttribution,
  newCommandId,
  useWorkRead,
  useWorkReview,
  useWorkWriter,
  workWriteBlockedReason,
  type WorkWriter,
} from "./useWork";
import { useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import { planIntegrationRefs } from "./workPresentation";
import {
  buildProtectedRevision,
  decisionChanged,
  decisionSnapshot,
  isMemberRecord,
  RELATIONSHIP_KINDS,
  relationshipFromTask,
  relationshipKindLabel,
  type WorkDecisionResponse,
  type WorkDecisionSnapshot,
} from "./workLogic";
import {
  TaskDelivery,
  TaskMemory,
  TaskReview,
  TaskWorkers,
  executionState,
} from "./WorkTaskSections";
import {
  deriveWorkTask,
  gateResponses,
  GUIDED_CONTROL_LABELS,
  guidedControls,
  shortHash,
  workStateLabel,
  type WorkApprovalStep,
  type WorkTaskModel,
} from "./workModel";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly taskId: string;
}>;

export interface Surface {
  readonly scope: ProjectWorkScope;
  readonly current: ProjectWorkSelection;
  readonly context: ProjectWorkTaskContext;
  readonly model: WorkTaskModel;
  /** The task's complete team record set at the reviewed revision. */
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly writer: WorkWriter;
  readonly blocked: string | null;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}

export const guidedFields = (surface: Surface, selected: ProjectWorkSelection) => ({
  commandId: newCommandId(),
  projectId: surface.scope.projectId,
  taskId: surface.context.task.taskId,
  expectedRevision: selected.revision,
  expectedTaskRevision: selected.taskRevision,
});

export function SettingsWorkTaskRouteScreen({ route }: Props) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const taskId = ProjectWorkTaskId.make(route.params.taskId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Task">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {project === null ? (
          <WorkText muted>This project isn't on the selected environment.</WorkText>
        ) : (
          <WorkTaskContent
            key={`${environmentId}:${projectId}:${taskId}`}
            scope={{ environmentId, projectId, checkoutPath: project.workspaceRoot }}
            taskId={taskId}
            onOpenTask={(next) =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsWorkTask",
                  params: { environmentId, projectId, taskId: next },
                },
              })
            }
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

/** One task's detail. Hosts own navigation, so the Work tab and Settings share it. */
export function WorkTaskContent({
  scope,
  taskId,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  taskId: ProjectWorkTaskId;
  onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const writer = useWorkWriter(scope.environmentId);
  const contextView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "task-context",
    taskId,
  });
  // Membership and current gates can sit anywhere in a task's history; the
  // kind is only known once the whole task-filtered set loads at one revision.
  const records = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    taskId,
  });
  const context = asProjectWorkTaskContext(contextView.value);
  if (context === null || context.task.taskId !== taskId || context.projectId !== scope.projectId)
    return (
      <>
        <WorkScopeLabel scope={scope} />
        <WorkReadNotice view={contextView} subject="this task" />
        {contextView.status === "ready" ? (
          <WorkText muted>This task isn't in this project, or it was removed.</WorkText>
        ) : null}
      </>
    );

  const task = context.task;
  const header = (
    <View className="gap-1.5 px-1">
      <WorkScopeLabel scope={scope} />
      <WorkText>{task.title}</WorkText>
      {task.summary ? <WorkText muted>{task.summary}</WorkText> : null}
    </View>
  );
  if (!records.complete)
    return (
      <>
        {header}
        <WorkText muted>
          {workStateLabel(task.state)} · task r{task.revision} · project r{context.revision}
        </WorkText>
        <WorkReadNotice view={contextView} subject="this task" />
        <WorkRecordsNotice set={records} subject="this task's team records" />
        <WorkText muted>
          Approvals and controls appear once Work knows whether this task is guided.
        </WorkText>
      </>
    );

  const teamRecords = records.records.flatMap((value): ProjectTeamRecordRead[] => {
    const record = asProjectTeamRecord(value);
    return record === null ? [] : [record];
  });
  const model = deriveWorkTask({
    context,
    records: teamRecords,
    recordsRevision: records.revision,
  });
  const surface: Surface = {
    scope,
    current: { ...scope, taskId, revision: context.revision, taskRevision: task.revision },
    context,
    model,
    records: teamRecords,
    writer,
    blocked:
      workWriteBlockedReason(contextView, writer.canWrite) ??
      workRecordsBlockedReason(records, "team records") ??
      (records.revision === context.revision
        ? null
        : "Team records are catching up with this task."),
    onOpenTask,
  };

  return (
    <>
      {header}
      <WorkText muted>
        {workStateLabel(task.state)} ·{" "}
        {model.guided
          ? `Guided${model.membership ? ` ${workStateLabel(model.membership.deliverableKind)}` : ""}`
          : "Simple"}
        {model.controlState !== "active" ? ` · ${workStateLabel(model.controlState)}` : ""} · task r
        {task.revision} · project r{context.revision}
      </WorkText>
      <WorkReadNotice view={contextView} subject="this task" />
      <WorkRecordsNotice set={records} subject="this task's team records" />
      <Approvals surface={surface} />
      <Scope surface={surface} />
      {model.guided ? <Plan surface={surface} /> : null}
      <Relationships surface={surface} />
      <TaskWorkers surface={surface} />
      <TaskReview surface={surface} />
      <TaskDelivery key={`${surface.scope.checkoutPath}:${taskId}`} surface={surface} />
      <TaskMemory surface={surface} />
      <Controls surface={surface} />
      <Evidence surface={surface} />
      <Comments surface={surface} />
    </>
  );
}

const STEP_STATE: Record<WorkApprovalStep["state"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  pending: "Waiting",
  stale: "Needs approval again",
  missing: "Not proposed",
};
const RESPONSE: Record<WorkDecisionResponse, string> = {
  approved: "Approve",
  rejected: "Reject",
  invalidated: "Revoke decision",
};

function Approvals({ surface }: { surface: Surface }) {
  const { model, context, writer } = surface;
  const [pending, setPending] = useState<WorkDecisionSnapshot | null>(null);
  const key = "approval";
  const blocked = model.blockedReason ?? surface.blocked;
  const responses = (step: WorkApprovalStep): ReadonlyArray<WorkDecisionResponse> =>
    model.guided
      ? gateResponses(step.gate)
      : (step.state === "pending" || step.state === "stale") &&
          context.policy.actions.approve.available
        ? ["approved"]
        : [];
  const confirm = async () => {
    if (pending === null) return;
    const step = model.steps.find((entry) => entry.id === pending.step);
    if (decisionChanged(pending, step, surface.current)) return;
    const gate = step?.gate ?? null;
    const intent = model.guided
      ? gate !== null
        ? {
            ...guidedFields(surface, pending.selected),
            type: "project-team.gate.respond",
            specRevision: gate.specRevision,
            planRevision: gate.planRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
            response: pending.response,
          }
        : null
      : {
          type: "project-work.task.approve",
          commandId: newCommandId(),
          projectId: surface.scope.projectId,
          taskId: context.task.taskId,
          expectedRevision: pending.selected.revision,
          approvalId: ProjectWorkApprovalId.make(uuidv4()),
          specRevision: pending.revision ?? context.task.specRevision,
          approvedAt: new Date().toISOString(),
        };
    if (await writer.submit(key, pending.selected, surface.current, intent)) setPending(null);
  };
  return (
    <ListSection
      title="Approvals"
      footer="A human decision covers one exact revision and never starts work."
    >
      {model.steps.map((step) => {
        const deciding = pending?.step === step.id ? pending : null;
        const changed = deciding !== null && decisionChanged(deciding, step, surface.current);
        const hash = shortHash(step.hash);
        return (
          <View key={step.id}>
            <WorkBlock>
              <WorkText>
                {step.label}
                {step.revision === null ? "" : ` r${step.revision}`} · {STEP_STATE[step.state]}
                {hash ? ` · ${hash}` : ""}
              </WorkText>
              <WorkText muted>{step.detail}</WorkText>
            </WorkBlock>
            {deciding ? (
              <WorkBlock>
                <WorkText>
                  {RESPONSE[deciding.response]} {deciding.label.toLowerCase()} r{deciding.revision}
                  {deciding.hash ? ` with content ${shortHash(deciding.hash)}` : ""}?
                </WorkText>
                <WorkText muted>
                  {deciding.response === "invalidated"
                    ? "This withdraws the recorded decision. The text stays as written."
                    : "This records your decision only. It does not start any work."}
                </WorkText>
                {blocked && !changed ? <WorkText muted>{blocked}</WorkText> : null}
                <WorkFormActions
                  submitLabel={`Confirm ${RESPONSE[deciding.response].toLowerCase()}`}
                  pending={writer.pendingKey === key}
                  disabled={blocked !== null}
                  failure={writer.failureFor(key)}
                  changed={changed}
                  onReview={() =>
                    setPending(
                      responses(step).includes(deciding.response)
                        ? decisionSnapshot(step, deciding.response, surface.current)
                        : null,
                    )
                  }
                  onSubmit={() => void confirm()}
                  onCancel={() => setPending(null)}
                />
              </WorkBlock>
            ) : (
              responses(step).map((response) => (
                <ListActionRow
                  key={response}
                  label={`${RESPONSE[response]} ${step.label.toLowerCase()} r${step.revision ?? ""}…`}
                  {...(blocked ? { description: blocked } : {})}
                  disabled={blocked !== null || writer.pendingKey !== null}
                  tone={response === "approved" ? "default" : "danger"}
                  onPress={() => setPending(decisionSnapshot(step, response, surface.current))}
                />
              ))
            )}
          </View>
        );
      })}
      {model.guided ? (
        <WorkBlock>
          <WorkText>Execution · {executionState(surface).label}</WorkText>
          <WorkText muted>{executionState(surface).detail}</WorkText>
        </WorkBlock>
      ) : null}
      {model.invalidated.slice(0, 3).map((gate) => (
        <WorkBlock key={gate.recordId}>
          <WorkText muted>
            {gate.gate === "plan" ? "Plan" : "Scope"} decision for r
            {gate.gate === "plan" ? gate.planRevision : gate.specRevision} was voided because the
            scope changed.
          </WorkText>
        </WorkBlock>
      ))}
    </ListSection>
  );
}

type ScopeMode = "edit" | "protect" | "revise-protected" | null;

function Scope({ surface }: { surface: Surface }) {
  const { context, model, writer } = surface;
  const task = context.task;
  const spec = task.specification;
  const actions = context.policy.actions;
  const review = useWorkReview(surface.current);
  const [mode, setMode] = useState<ScopeMode>(null);
  const [objective, setObjective] = useState("");
  const [scopeIn, setScopeIn] = useState("");
  const [scopeOut, setScopeOut] = useState("");
  const [criteria, setCriteria] = useState<
    ReadonlyArray<{
      id: ProjectWorkCriterionId;
      text: string;
      existing: ProjectWorkCriterionRead | null;
    }>
  >([]);
  const [newCriterion, setNewCriterion] = useState("");
  const [newCriterionId, setNewCriterionId] = useState(() => ProjectWorkCriterionId.make(uuidv4()));
  const [prepared, setPrepared] = useState<ReturnType<typeof buildProtectedRevision> | null>(null);
  const [protectRevision, setProtectRevision] = useState(task.specRevision);
  const key = "scope";
  const editReason = spec?.protected
    ? "This scope is protected. Changes go through an approved protected revision."
    : model.guided
      ? model.terminal
        ? "Reopen the task before changing its scope."
        : (model.blockedReason ?? surface.blocked)
      : actions.specify.available
        ? surface.blocked
        : (actions.specify.reason ?? "The scope can't change in this state.");
  const protectReason = actions["protect-specification"].available
    ? (model.blockedReason ?? surface.blocked)
    : (actions["protect-specification"].reason ?? "This scope can't be protected now.");
  const reviseReason = actions["revise-protected-specification"].available
    ? (model.blockedReason ?? surface.blocked)
    : (actions["revise-protected-specification"].reason ??
      "A protected revision isn't available now.");

  const open = (next: Exclude<ScopeMode, null>) => {
    setObjective(spec?.objective ?? task.title);
    setScopeIn(spec?.scopeIn ?? "");
    setScopeOut(spec?.scopeOut ?? "");
    setCriteria(
      context.criteria.map((criterion) => ({
        id: criterion.criterionId,
        text: criterion.description,
        existing: criterion,
      })),
    );
    setNewCriterion("");
    setNewCriterionId(ProjectWorkCriterionId.make(uuidv4()));
    setPrepared(null);
    setProtectRevision(task.specRevision);
    setMode(next);
    review.open();
  };
  const close = () => {
    setMode(null);
    review.close();
  };
  const edit = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPrepared(null);
  };
  const allCriteria = [
    ...criteria,
    ...(newCriterion.trim() && model.guided
      ? [{ id: newCriterionId, text: newCriterion, existing: null }]
      : []),
  ];
  const submit = async () => {
    const selected = review.selected;
    if (selected === null) return;
    const now = new Date().toISOString();
    const specification = {
      objective: objective.trim(),
      scopeIn: scopeIn.trim(),
      scopeOut: scopeOut.trim(),
      criterionIds: model.guided
        ? allCriteria.map((criterion) => criterion.id)
        : context.criteria.map((criterion) => criterion.criterionId),
      revision: task.specRevision + 1,
      protected: false,
    };
    const intent = model.guided
      ? {
          ...guidedFields(surface, selected),
          type: "project-team.specification.propose",
          expectedSpecRevision: task.specRevision,
          specification,
          criterionSnapshots: allCriteria.map((criterion) => ({
            criterionId: criterion.id,
            taskId: task.taskId,
            description: criterion.text.trim(),
            required: criterion.existing?.required ?? true,
            status: "unsatisfied" as const,
            satisfiedByEvidenceIds: [],
            revision: criterion.existing?.revision ?? 0,
            updatedAt: criterion.existing?.updatedAt ?? now,
          })),
        }
      : {
          type: "project-work.task.specify",
          commandId: newCommandId(),
          projectId: surface.scope.projectId,
          taskId: task.taskId,
          expectedRevision: selected.revision,
          specification,
          updatedAt: now,
        };
    if (await writer.submit(key, selected, surface.current, intent)) close();
  };
  const protect = async () => {
    const selected = review.selected;
    if (selected === null) return;
    const sent = await writer.submit(key, selected, surface.current, {
      type: "project-work.task.protect-specification",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      taskId: task.taskId,
      expectedRevision: selected.revision,
      specRevision: protectRevision,
      protectedAt: new Date().toISOString(),
    });
    if (sent) close();
  };
  const prepareProtected = () => {
    const selected = review.selected;
    if (selected === null) return;
    const now = new Date().toISOString();
    setPrepared(
      buildProtectedRevision({
        context,
        expectedRevision: selected.revision,
        commandId: newCommandId(),
        approvalId: ProjectWorkApprovalId.make(uuidv4()),
        objective: objective.trim(),
        scopeIn: scopeIn.trim(),
        scopeOut: scopeOut.trim(),
        revisedAt: now,
        attribution: humanAttribution(now),
      }),
    );
  };
  const submitProtected = async () => {
    const selected = review.selected;
    if (selected === null || prepared === null || !("command" in prepared)) return;
    if (await writer.submit(key, selected, surface.current, prepared.command)) close();
  };
  const addCriterion = async () => {
    const selected = surface.current;
    const now = new Date().toISOString();
    const sent = await writer.submit("criterion:add", selected, selected, {
      type: "project-work.criterion.upsert",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      taskId: task.taskId,
      expectedRevision: selected.revision,
      criterion: {
        criterionId: ProjectWorkCriterionId.make(uuidv4()),
        taskId: task.taskId,
        description: newCriterion.trim(),
        required: true,
        status: "unsatisfied",
        satisfiedByEvidenceIds: [],
        revision: 0,
        updatedAt: now,
      },
      updatedAt: now,
    });
    if (sent) setNewCriterion("");
  };
  const textComplete = objective.trim() !== "" && scopeIn.trim() !== "" && scopeOut.trim() !== "";
  const complete =
    textComplete &&
    (model.guided
      ? allCriteria.length > 0 && allCriteria.every((criterion) => criterion.text.trim() !== "")
      : context.criteria.length > 0);
  const command = prepared !== null && "command" in prepared ? prepared.command : null;
  const protectChanged = review.changed || protectRevision !== task.specRevision;

  return (
    <>
      <ListSection
        title={
          spec ? `Scope r${task.specRevision}${spec.protected ? " · protected" : ""}` : "Scope"
        }
        footer={
          mode === null ? ((spec?.protected ? reviseReason : editReason) ?? undefined) : undefined
        }
      >
        {mode === "edit" ? (
          <WorkBlock>
            <WorkInput label="Objective" value={objective} onChange={setObjective} multiline />
            <WorkInput label="Included" value={scopeIn} onChange={setScopeIn} multiline />
            <WorkInput label="Excluded" value={scopeOut} onChange={setScopeOut} multiline />
            {model.guided
              ? criteria.map((criterion, index) => (
                  <WorkInput
                    key={criterion.id}
                    label={`Acceptance criterion ${index + 1}`}
                    value={criterion.text}
                    onChange={(text) =>
                      setCriteria(
                        criteria.map((entry) =>
                          entry.id === criterion.id ? { ...entry, text } : entry,
                        ),
                      )
                    }
                  />
                ))
              : null}
            {model.guided ? (
              <WorkInput
                label="New acceptance criterion"
                value={newCriterion}
                onChange={setNewCriterion}
              />
            ) : (
              <WorkText muted>
                {context.criteria.length === 0
                  ? "Add an acceptance criterion below first."
                  : `Covers all ${context.criteria.length} acceptance criteria.`}
              </WorkText>
            )}
            <WorkText muted>
              Saving revision r{task.specRevision + 1} voids earlier scope approvals
              {model.guided ? " and clears waivers." : "."}
            </WorkText>
            <WorkFormActions
              submitLabel={model.guided ? "Propose scope" : "Save scope"}
              pending={writer.pendingKey === key}
              disabled={!complete || editReason !== null}
              failure={writer.failureFor(key)}
              changed={review.changed}
              onReview={review.rebase}
              onSubmit={() => void submit()}
              onCancel={close}
            />
          </WorkBlock>
        ) : mode === "protect" ? (
          <WorkBlock>
            <WorkText>Protect scope revision r{protectRevision}?</WorkText>
            <WorkText muted>
              After this, the scope only changes through a protected revision that you review and
              approve as a whole. Protection can't be removed.
            </WorkText>
            <WorkFormActions
              submitLabel="Protect scope"
              pending={writer.pendingKey === key}
              disabled={protectReason !== null}
              failure={writer.failureFor(key)}
              changed={protectChanged}
              onReview={close}
              onSubmit={() => void protect()}
              onCancel={close}
            />
          </WorkBlock>
        ) : mode === "revise-protected" ? (
          <WorkBlock>
            <WorkInput
              label="Objective"
              value={objective}
              onChange={edit(setObjective)}
              multiline
            />
            <WorkInput label="Included" value={scopeIn} onChange={edit(setScopeIn)} multiline />
            <WorkInput label="Excluded" value={scopeOut} onChange={edit(setScopeOut)} multiline />
            <WorkText muted>
              The {spec?.criterionIds.length ?? 0} acceptance criteria stay exactly as recorded. No
              worker results exist while execution is off, so none are marked affected.
            </WorkText>
            {prepared !== null && "reason" in prepared ? (
              <Notice tone="danger" message={prepared.reason} />
            ) : null}
            {command ? (
              <>
                <WorkText>
                  Approve protected revision r{command.specification.revision} with fingerprint{" "}
                  {shortHash(command.approval.payloadFingerprint)}?
                </WorkText>
                <WorkText muted>
                  Your approval covers this exact text and criteria. It doesn't start any work.
                </WorkText>
                <WorkFormActions
                  submitLabel="Approve protected revision"
                  pending={writer.pendingKey === key}
                  disabled={reviseReason !== null}
                  failure={writer.failureFor(key)}
                  changed={review.changed}
                  onReview={() => {
                    setPrepared(null);
                    review.rebase();
                  }}
                  onSubmit={() => void submitProtected()}
                  onCancel={() => setPrepared(null)}
                />
              </>
            ) : (
              <WorkFormActions
                submitLabel="Review revision"
                pending={false}
                disabled={!textComplete || reviseReason !== null}
                failure={null}
                changed={review.changed}
                onReview={review.rebase}
                onSubmit={prepareProtected}
                onCancel={close}
              />
            )}
          </WorkBlock>
        ) : (
          <>
            {spec ? (
              <WorkBlock>
                <WorkText>{spec.objective}</WorkText>
                <WorkText muted>Included: {spec.scopeIn}</WorkText>
                <WorkText muted>Excluded: {spec.scopeOut}</WorkText>
              </WorkBlock>
            ) : (
              <WorkBlock>
                <WorkText muted>No scope yet.</WorkText>
              </WorkBlock>
            )}
            {spec?.protected ? (
              <ListActionRow
                icon="exclamationmark.shield"
                label="Revise protected scope…"
                disabled={reviseReason !== null}
                onPress={() => open("revise-protected")}
              />
            ) : (
              <>
                <ListActionRow
                  icon="pencil"
                  label={
                    spec ? (model.guided ? "Propose scope revision" : "Edit scope") : "Write scope"
                  }
                  disabled={editReason !== null}
                  onPress={() => open("edit")}
                />
                {spec ? (
                  <ListActionRow
                    icon="exclamationmark.shield"
                    label="Protect scope…"
                    {...(protectReason ? { description: protectReason } : {})}
                    disabled={protectReason !== null}
                    onPress={() => open("protect")}
                  />
                ) : null}
              </>
            )}
          </>
        )}
      </ListSection>
      <ListSection title={`Acceptance criteria · ${context.criteria.length}`}>
        {context.criteria.map((criterion) => (
          <Criterion key={criterion.criterionId} surface={surface} criterion={criterion} />
        ))}
        {!model.guided && actions.specify.available && mode === null ? (
          <WorkBlock>
            <WorkInput
              label="New acceptance criterion"
              value={newCriterion}
              onChange={setNewCriterion}
            />
            {writer.failureFor("criterion:add") ? (
              <Notice tone="danger" message={writer.failureFor("criterion:add")!} />
            ) : null}
            <Button
              label="Add criterion"
              tone="secondary"
              loading={writer.pendingKey === "criterion:add"}
              disabled={newCriterion.trim() === "" || surface.blocked !== null}
              onPress={() => void addCriterion()}
            />
          </WorkBlock>
        ) : null}
      </ListSection>
    </>
  );
}

function evidenceSummaries(surface: Surface, ids: ReadonlyArray<string>): string | null {
  if (ids.length === 0) return null;
  const found = surface.context.evidence.filter((evidence) => ids.includes(evidence.evidenceId));
  const missing = ids.length - found.length;
  return [
    ...found.map((evidence) => evidence.summary),
    ...(missing > 0 ? [`${missing} record(s) not on this task`] : []),
  ].join(" · ");
}

function Criterion({
  surface,
  criterion,
}: {
  surface: Surface;
  criterion: ProjectWorkCriterionRead;
}) {
  const { model, context, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current);
  const [reason, setReason] = useState("");
  const key = `waiver:${criterion.criterionId}`;
  const waived = criterion.waiver !== undefined;
  const actions = context.policy.actions;
  const unavailable =
    surface.blocked ??
    (task.specification?.protected
      ? "Protected scopes change waivers only through a protected revision."
      : model.guided
        ? model.terminal
          ? "Reopen the task before changing a waiver."
          : model.specificationHash === null
            ? "Waivers bind to the current scope approval request, which isn't recorded yet."
            : model.blockedReason
        : waived
          ? actions["revoke-criterion-waiver"].available
            ? null
            : (actions["revoke-criterion-waiver"].reason ?? "This waiver can't be revoked now.")
          : actions["waive-criterion"].available
            ? null
            : (actions["waive-criterion"].reason ?? "Waivers aren't available now."));
  const reasonRequired = !waived || !model.guided;
  const send = async () => {
    const selected = review.selected;
    if (selected === null) return;
    const now = new Date().toISOString();
    const intent = model.guided
      ? {
          ...guidedFields(surface, selected),
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
            expectedRevision: selected.revision,
            taskId: task.taskId,
            expectedTaskRevision: selected.taskRevision,
            criterionId: criterion.criterionId,
            expectedCriterionRevision: criterion.revision,
            expectedSpecRevision: task.specRevision,
            reason: reason.trim(),
            attribution: humanAttribution(now),
            revokedAt: now,
          }
        : {
            type: "project-work.criterion.waive",
            commandId: newCommandId(),
            projectId: surface.scope.projectId,
            taskId: task.taskId,
            expectedRevision: selected.revision,
            criterionId: criterion.criterionId,
            waiver: {
              reason: reason.trim(),
              evidenceIds: [],
              specRevision: task.specRevision,
              waivedAt: now,
              attribution: humanAttribution(now),
            },
            waivedAt: now,
          };
    if (await writer.submit(key, selected, surface.current, intent)) {
      review.close();
      setReason("");
    }
  };
  const supported = evidenceSummaries(surface, criterion.satisfiedByEvidenceIds);
  const cited = criterion.waiver ? evidenceSummaries(surface, criterion.waiver.evidenceIds) : null;
  return (
    <View>
      <WorkBlock>
        <WorkText>{criterion.description}</WorkText>
        <WorkText muted>
          {workStateLabel(criterion.status)}
          {criterion.required ? "" : " · optional"}
          {criterion.waiver
            ? ` · waived for r${criterion.waiver.specRevision}${criterion.waiver.attribution.actor.displayName ? ` by ${criterion.waiver.attribution.actor.displayName}` : ""}: ${criterion.waiver.reason}`
            : ""}
        </WorkText>
        {supported ? <WorkText muted>Supported by: {supported}</WorkText> : null}
        {cited ? <WorkText muted>Waiver cites: {cited}</WorkText> : null}
      </WorkBlock>
      {review.selected !== null ? (
        <WorkBlock>
          {waived ? (
            <WorkText muted>
              Revoking restores this criterion as unmet and voids the scope approval. The original
              waiver stays in history.
            </WorkText>
          ) : null}
          {reasonRequired ? (
            <WorkInput
              label={waived ? "Why revoke this waiver?" : "Why is this criterion waived?"}
              value={reason}
              onChange={setReason}
              multiline
            />
          ) : null}
          <WorkFormActions
            submitLabel={waived ? "Revoke waiver" : "Waive criterion"}
            pending={writer.pendingKey === key}
            disabled={unavailable !== null || (reasonRequired && reason.trim() === "")}
            failure={writer.failureFor(key)}
            changed={review.changed}
            onReview={review.rebase}
            onSubmit={() => void send()}
            onCancel={review.close}
          />
        </WorkBlock>
      ) : criterion.status === "waived" && !waived ? null : (
        <ListActionRow
          label={waived ? "Revoke waiver…" : "Waive…"}
          {...(unavailable ? { description: unavailable } : {})}
          disabled={unavailable !== null}
          onPress={review.open}
        />
      )}
    </View>
  );
}

function Plan({ surface }: { surface: Surface }) {
  const { context, model, writer } = surface;
  const task = context.task;
  const plan = model.plan;
  const review = useWorkReview(surface.current);
  const [content, setContent] = useState("");
  const [dependencies, setDependencies] = useState<ReadonlyArray<ProjectWorkTaskId>>([]);
  const [choosing, setChoosing] = useState(false);
  const key = "plan";
  const keptInputs = planIntegrationRefs(plan);
  const unavailable =
    task.specification === undefined
      ? "Propose a scope before the plan."
      : model.terminal
        ? "Reopen the task before changing its plan."
        : (model.blockedReason ?? surface.blocked);
  const submit = async () => {
    const selected = review.selected;
    if (selected === null) return;
    const intent = {
      ...guidedFields(surface, selected),
      type: "project-team.plan.propose",
      specRevision: task.specRevision,
      content: content.trim(),
      dependencyTaskIds: dependencies,
      // Editing prose keeps the plan's ordered reviewed inputs; the server re-qualifies them.
      ...(keptInputs.length > 0 ? { integrationSourceRefs: keptInputs } : {}),
      ...(plan
        ? { previousPlanId: plan.recordId, expectedPreviousPlanRevision: plan.revision }
        : {}),
    };
    if (await writer.submit(key, selected, surface.current, intent)) review.close();
  };
  return (
    <ListSection
      title={
        plan ? `Plan r${plan.planRevision}${model.planCurrent ? "" : " · out of date"}` : "Plan"
      }
      footer={unavailable ?? undefined}
    >
      {review.selected !== null ? (
        <>
          <WorkBlock>
            <WorkInput
              label="Implementation and validation plan"
              value={content}
              onChange={setContent}
              multiline
              maxLength={32000}
            />
            {keptInputs.length > 0 ? (
              <WorkText muted>
                Keeps its {keptInputs.length} ordered reviewed{" "}
                {keptInputs.length === 1 ? "input" : "inputs"}. Change them under Integration
                inputs.
              </WorkText>
            ) : null}
            <WorkText muted>
              {dependencies.length === 0 ? "No dependencies." : "Depends on:"}
            </WorkText>
          </WorkBlock>
          {dependencies.map((dependency) => (
            <ListActionRow
              key={dependency}
              icon="xmark"
              label="Remove dependency"
              description={dependency}
              onPress={() => setDependencies(dependencies.filter((entry) => entry !== dependency))}
            />
          ))}
          {choosing ? (
            <WorkTaskPicker
              scope={surface.scope}
              selectedTaskId={null}
              excludeTaskIds={[task.taskId, ...dependencies]}
              onSelect={(choice) => {
                setDependencies([...dependencies, choice.taskId]);
                setChoosing(false);
              }}
            />
          ) : (
            <ListActionRow
              icon="plus"
              label="Add dependency"
              disabled={dependencies.length >= 64}
              onPress={() => setChoosing(true)}
            />
          )}
          <WorkBlock>
            <WorkText muted>A new plan revision voids an earlier plan approval.</WorkText>
            <WorkFormActions
              submitLabel="Propose plan"
              pending={writer.pendingKey === key}
              disabled={content.trim() === "" || unavailable !== null}
              failure={writer.failureFor(key)}
              changed={review.changed}
              onReview={review.rebase}
              onSubmit={() => void submit()}
              onCancel={review.close}
            />
          </WorkBlock>
        </>
      ) : (
        <>
          <WorkBlock>
            <WorkText muted={plan === null}>{plan?.content ?? "No plan yet."}</WorkText>
          </WorkBlock>
          {(plan?.dependencyTaskIds ?? []).map((dependency) => (
            <WorkTaskLink
              key={dependency}
              scope={surface.scope}
              taskId={dependency}
              prefix="Depends on"
              onOpen={surface.onOpenTask}
            />
          ))}
          <ListActionRow
            icon="pencil"
            label={plan ? "Propose plan revision" : "Write plan"}
            disabled={unavailable !== null}
            onPress={() => {
              setContent(plan?.content ?? "");
              setDependencies(plan?.dependencyTaskIds ?? []);
              setChoosing(false);
              review.open();
            }}
          />
        </>
      )}
    </ListSection>
  );
}

function Relationships({ surface }: { surface: Surface }) {
  const { context, writer, scope } = surface;
  const task = context.task;
  const actions = context.policy.actions;
  const linkReason = actions["link-relationship"].available
    ? surface.blocked
    : (actions["link-relationship"].reason ?? "Links can't change in this state.");
  const unlinkReason = actions["unlink-relationship"].available
    ? surface.blocked
    : (actions["unlink-relationship"].reason ?? "Links can't change in this state.");
  const review = useWorkReview(surface.current);
  const [kind, setKind] = useState<(typeof RELATIONSHIP_KINDS)[number]>("depends-on");
  const [target, setTarget] = useState<ProjectWorkTaskId | null>(null);
  const [unlinking, setUnlinking] = useState<ProjectWorkRelationshipRead | null>(null);
  const linkKey = "relationship:link";
  const linked = context.relationships.map(
    (relationship) => relationshipFromTask(relationship, task.taskId).otherTaskId,
  );
  const link = async () => {
    if (review.selected === null || target === null) return;
    const now = new Date().toISOString();
    const sent = await writer.submit(linkKey, review.selected, surface.current, {
      type: "project-work.relationship.link",
      commandId: newCommandId(),
      projectId: scope.projectId,
      expectedRevision: review.selected.revision,
      relationship: {
        relationshipId: ProjectWorkRelationshipId.make(uuidv4()),
        projectId: scope.projectId,
        fromTaskId: task.taskId,
        toTaskId: target,
        kind,
        revision: 0,
        createdAt: now,
      },
      linkedAt: now,
    });
    if (sent) {
      review.close();
      setTarget(null);
    }
  };
  const unlink = async (relationship: ProjectWorkRelationshipRead) => {
    const selected = surface.current;
    const sent = await writer.submit(
      `relationship:${relationship.relationshipId}`,
      selected,
      surface.current,
      {
        type: "project-work.relationship.unlink",
        commandId: newCommandId(),
        projectId: scope.projectId,
        expectedRevision: selected.revision,
        relationshipId: relationship.relationshipId,
        unlinkedAt: new Date().toISOString(),
      },
    );
    if (sent) setUnlinking(null);
  };
  return (
    <ListSection title="Related tasks" footer={linkReason ?? undefined}>
      {context.relationships.length === 0 && review.selected === null ? (
        <WorkBlock>
          <WorkText muted>No linked tasks.</WorkText>
        </WorkBlock>
      ) : null}
      {context.relationships.map((relationship) => {
        const view = relationshipFromTask(relationship, task.taskId);
        const key = `relationship:${relationship.relationshipId}`;
        return (
          <View key={relationship.relationshipId}>
            <WorkTaskLink
              scope={scope}
              taskId={view.otherTaskId}
              prefix={view.label}
              onOpen={surface.onOpenTask}
            />
            {unlinking?.relationshipId === relationship.relationshipId ? (
              <WorkBlock>
                <WorkText muted>Remove this link? Both tasks stay as they are.</WorkText>
                <WorkFormActions
                  submitLabel="Confirm unlink"
                  pending={writer.pendingKey === key}
                  disabled={unlinkReason !== null}
                  failure={writer.failureFor(key)}
                  onSubmit={() => void unlink(relationship)}
                  onCancel={() => setUnlinking(null)}
                />
              </WorkBlock>
            ) : (
              <ListActionRow
                label="Unlink…"
                tone="danger"
                {...(unlinkReason ? { description: unlinkReason } : {})}
                disabled={unlinkReason !== null || writer.pendingKey !== null}
                onPress={() => setUnlinking(relationship)}
              />
            )}
          </View>
        );
      })}
      {review.selected !== null ? (
        <>
          <WorkBlock>
            <WorkText muted>This task…</WorkText>
          </WorkBlock>
          {RELATIONSHIP_KINDS.map((value) => (
            <ListChoiceRow
              key={value}
              label={relationshipKindLabel(value)}
              selected={kind === value}
              onPress={() => setKind(value)}
            />
          ))}
          <WorkTaskPicker
            scope={scope}
            selectedTaskId={target}
            excludeTaskIds={[task.taskId, ...linked]}
            onSelect={(choice) => setTarget(choice.taskId)}
          />
          <WorkBlock>
            <WorkFormActions
              submitLabel="Link task"
              pending={writer.pendingKey === linkKey}
              disabled={target === null || linkReason !== null}
              failure={writer.failureFor(linkKey)}
              changed={review.changed}
              onReview={review.rebase}
              onSubmit={() => void link()}
              onCancel={review.close}
            />
          </WorkBlock>
        </>
      ) : (
        <ListActionRow
          icon="link"
          label="Link task…"
          disabled={linkReason !== null}
          onPress={() => {
            setTarget(null);
            review.open();
          }}
        />
      )}
    </ListSection>
  );
}

type OrdinaryAction = "ready" | "block" | "reopen" | "cancel";
const ORDINARY: Record<OrdinaryAction, string> = {
  ready: "Mark ready",
  block: "Block",
  reopen: "Reopen",
  cancel: "Cancel task",
};

function Controls({ surface }: { surface: Surface }) {
  const { context, model, writer } = surface;
  const task = context.task;
  const review = useWorkReview(surface.current);
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [resolver, setResolver] = useState("");
  const key = "control";
  const blocked = model.blockedReason ?? surface.blocked;
  const actions: ReadonlyArray<{ id: string; label: string }> = model.guided
    ? guidedControls(model).map((id) => ({ id, label: GUIDED_CONTROL_LABELS[id] }))
    : (["ready", "block", "reopen", "cancel"] as const)
        .filter((id) => context.policy.actions[id].available)
        .map((id) => ({ id, label: ORDINARY[id] }));
  const reasonRequired = model.guided || action === "block";
  const send = async () => {
    const selected = review.selected;
    if (selected === null || action === null) return;
    const now = new Date().toISOString();
    const common = {
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      taskId: task.taskId,
      expectedRevision: selected.revision,
    };
    const intent = model.guided
      ? {
          ...guidedFields(surface, selected),
          type: "project-team.task.control",
          control: { action, reason: reason.trim() },
        }
      : action === "ready"
        ? { ...common, type: "project-work.task.ready", updatedAt: now }
        : action === "block"
          ? {
              ...common,
              type: "project-work.task.block",
              blockerId: ProjectWorkBlockerId.make(uuidv4()),
              reason: reason.trim(),
              resolver: resolver.trim(),
              referenceIds: [],
              blockedAt: now,
            }
          : action === "reopen"
            ? { ...common, type: "project-work.task.reopen", reopenedAt: now }
            : {
                ...common,
                type: "project-work.task.cancel",
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                canceledAt: now,
              };
    if (await writer.submit(key, selected, surface.current, intent)) {
      setAction(null);
      review.close();
    }
  };
  const resolve = async (blockerId: ProjectWorkBlockerId) => {
    const selected = surface.current;
    await writer.submit(`blocker:${blockerId}`, selected, selected, {
      type: "project-work.task.resolve-blocker",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      taskId: task.taskId,
      expectedRevision: selected.revision,
      blockerId,
      resolvedAt: new Date().toISOString(),
    });
  };
  const label = actions.find((entry) => entry.id === action)?.label ?? "";
  return (
    <>
      <ListSection title="Task controls" footer={blocked ?? "Each change is recorded on the task."}>
        {context.blockers
          .filter((blocker) => blocker.resolvedAt === undefined)
          .map((blocker) =>
            model.guided ? (
              <WorkBlock key={blocker.blockerId}>
                <WorkText muted>Blocked: {blocker.reason}</WorkText>
              </WorkBlock>
            ) : (
              <ListActionRow
                key={blocker.blockerId}
                label="Resolve blocker"
                description={blocker.reason}
                loading={writer.pendingKey === `blocker:${blocker.blockerId}`}
                disabled={blocked !== null}
                onPress={() => void resolve(blocker.blockerId)}
              />
            ),
          )}
        {action !== null ? (
          <WorkBlock>
            <WorkText>{label}</WorkText>
            <WorkInput
              label={reasonRequired ? "Reason" : "Reason (optional)"}
              value={reason}
              onChange={setReason}
              multiline
            />
            {action === "block" ? (
              <WorkInput label="Resolves when" value={resolver} onChange={setResolver} />
            ) : null}
            <WorkFormActions
              submitLabel={`Confirm ${label.toLowerCase()}`}
              pending={writer.pendingKey === key}
              disabled={
                blocked !== null ||
                (reasonRequired && reason.trim() === "") ||
                (action === "block" && resolver.trim() === "")
              }
              failure={writer.failureFor(key)}
              changed={review.changed}
              onReview={review.rebase}
              onSubmit={() => void send()}
              onCancel={() => {
                setAction(null);
                review.close();
              }}
            />
          </WorkBlock>
        ) : actions.length === 0 ? (
          <WorkBlock>
            <WorkText muted>No steering change applies in this state.</WorkText>
          </WorkBlock>
        ) : (
          actions.map((entry) => (
            <ListActionRow
              key={entry.id}
              label={entry.label}
              tone={entry.id === "cancel" ? "danger" : "default"}
              disabled={blocked !== null || writer.pendingKey !== null}
              onPress={() => {
                setAction(entry.id);
                setReason("");
                setResolver("");
                review.open();
              }}
            />
          ))
        )}
        {model.guided && !model.terminal && action === null ? <Reassign surface={surface} /> : null}
      </ListSection>
    </>
  );
}

/** Names who should take over; the server records the successor and pauses the task. */
function Reassign({ surface }: { surface: Surface }) {
  const { model, writer, scope } = surface;
  const membersSet = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "foundation-records",
    recordKind: "member",
  });
  const members = membersSet.records.flatMap((value) => {
    const record = asProjectTeamRecord(value);
    return record !== null && isMemberRecord(record) && record.status === "active" ? [record] : [];
  });
  const review = useWorkReview(surface.current);
  const [recipient, setRecipient] = useState<{ id: string; revision: number } | null>(null);
  const [reason, setReason] = useState("");
  const key = "control:reassign";
  const listBlocked = workRecordsBlockedReason(membersSet, "team members");
  const blocked = model.blockedReason ?? surface.blocked ?? listBlocked;
  const chosen =
    recipient === null ? null : members.find((member) => member.recordId === recipient.id);
  const recipientChanged =
    recipient !== null && (chosen === undefined || chosen?.revision !== recipient.revision);
  const send = async () => {
    if (review.selected === null || recipient === null) return;
    const sent = await writer.submit(key, review.selected, surface.current, {
      ...guidedFields(surface, review.selected),
      type: "project-team.task.control",
      control: {
        action: "reassign",
        reason: reason.trim(),
        recipientMemberId: recipient.id,
        expectedMemberRevision: recipient.revision,
      },
    });
    if (sent) {
      review.close();
      setRecipient(null);
      setReason("");
    }
  };
  if (review.selected === null)
    return (
      <ListActionRow
        label="Reassign…"
        {...(blocked ? { description: blocked } : {})}
        disabled={blocked !== null || writer.pendingKey !== null}
        onPress={() => {
          setRecipient(null);
          setReason("");
          review.open();
        }}
      />
    );
  return (
    <>
      <WorkBlock>
        <WorkText>Reassign to</WorkText>
        {members.length === 0 ? (
          <WorkText muted>
            {listBlocked ?? "No active team members. Configure the team in Overview first."}
          </WorkText>
        ) : null}
      </WorkBlock>
      {members.map((member) => (
        <ListChoiceRow
          key={member.recordId}
          label={member.name}
          description={`${member.coordinator ? "Coordinator · " : ""}r${member.revision}`}
          selected={recipient?.id === member.recordId}
          onPress={() => setRecipient({ id: member.recordId, revision: member.revision })}
        />
      ))}
      <WorkBlock>
        <WorkInput label="Reason" value={reason} onChange={setReason} multiline />
        <WorkText muted>
          This records who should take over and pauses the task. It doesn't start a worker.
        </WorkText>
        <WorkFormActions
          submitLabel="Confirm reassignment"
          pending={writer.pendingKey === key}
          disabled={recipient === null || reason.trim() === "" || blocked !== null}
          failure={writer.failureFor(key)}
          changed={review.changed || recipientChanged}
          onReview={() => {
            setRecipient(null);
            review.rebase();
          }}
          onSubmit={() => void send()}
          onCancel={review.close}
        />
      </WorkBlock>
    </>
  );
}

/** Recorded observations. Evidence never marks a criterion met by itself. */
function Evidence({ surface }: { surface: Surface }) {
  const { context, writer } = surface;
  const action = context.policy.actions["add-evidence"];
  const unavailable = action.available
    ? surface.blocked
    : (action.reason ?? "Evidence can't be added in this state.");
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [uri, setUri] = useState("");
  const [criterionId, setCriterionId] = useState<ProjectWorkCriterionId | null>(null);
  const key = "evidence";
  const add = async () => {
    const selected = surface.current;
    const now = new Date().toISOString();
    const sent = await writer.submit(key, selected, selected, {
      type: "project-work.evidence.add",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      expectedRevision: selected.revision,
      evidence: {
        evidenceId: ProjectWorkEvidenceId.make(uuidv4()),
        taskId: context.task.taskId,
        ...(criterionId ? { criterionId } : {}),
        kind: "observation",
        summary: summary.trim(),
        ...(detail.trim() ? { detail: detail.trim() } : {}),
        ...(uri.trim() ? { uri: uri.trim() } : {}),
        recordedAt: now,
        revision: 0,
      },
      addedAt: now,
    });
    if (sent) {
      setOpen(false);
      setSummary("");
      setDetail("");
      setUri("");
      setCriterionId(null);
    }
  };
  return (
    <ListSection
      title="Evidence"
      footer="Observations people recorded. They don't verify a criterion by themselves."
    >
      {context.evidence.length === 0 && !open ? (
        <WorkBlock>
          <WorkText muted>No evidence recorded.</WorkText>
        </WorkBlock>
      ) : null}
      {context.evidence.map((evidence) => (
        <WorkBlock key={evidence.evidenceId}>
          <WorkText>{evidence.summary}</WorkText>
          {evidence.detail ? <WorkText muted>{evidence.detail}</WorkText> : null}
          <WorkText muted>
            {workStateLabel(evidence.kind)} ·{" "}
            {evidence.attribution?.actor.displayName ??
              evidence.attribution?.actor.kind ??
              "Unknown"}
            {evidence.criterionId
              ? ` · about: ${context.criteria.find((entry) => entry.criterionId === evidence.criterionId)?.description ?? "a criterion no longer on this task"}`
              : ""}
            {evidence.uri ? ` · ${evidence.uri}` : ""}
          </WorkText>
        </WorkBlock>
      ))}
      {open ? (
        <>
          <WorkBlock>
            <WorkInput label="What was observed" value={summary} onChange={setSummary} multiline />
            <WorkInput label="Detail (optional)" value={detail} onChange={setDetail} multiline />
            <WorkInput label="Link (optional)" value={uri} onChange={setUri} />
            <WorkText muted>About</WorkText>
          </WorkBlock>
          <ListChoiceRow
            label="The whole task"
            selected={criterionId === null}
            onPress={() => setCriterionId(null)}
          />
          {context.criteria.map((criterion) => (
            <ListChoiceRow
              key={criterion.criterionId}
              label={criterion.description}
              selected={criterionId === criterion.criterionId}
              onPress={() => setCriterionId(criterion.criterionId)}
            />
          ))}
          <WorkBlock>
            <WorkText muted>
              Saved as your observation, attributed to this session. It doesn't mark a criterion
              met.
            </WorkText>
            <WorkFormActions
              submitLabel="Record evidence"
              pending={writer.pendingKey === key}
              disabled={summary.trim() === "" || unavailable !== null}
              failure={writer.failureFor(key)}
              onSubmit={() => void add()}
              onCancel={() => setOpen(false)}
            />
          </WorkBlock>
        </>
      ) : (
        <ListActionRow
          icon="plus"
          label="Add evidence…"
          {...(unavailable ? { description: unavailable } : {})}
          disabled={unavailable !== null}
          onPress={() => setOpen(true)}
        />
      )}
    </ListSection>
  );
}

function Comments({ surface }: { surface: Surface }) {
  const { context, writer } = surface;
  const [body, setBody] = useState("");
  const key = "comment";
  const add = async () => {
    const selected = surface.current;
    const now = new Date().toISOString();
    const sent = await writer.submit(key, selected, selected, {
      type: "project-work.comment.add",
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      expectedRevision: selected.revision,
      comment: {
        commentId: ProjectWorkCommentId.make(uuidv4()),
        projectId: surface.scope.projectId,
        taskId: context.task.taskId,
        body: body.trim(),
        createdAt: now,
        revision: 0,
      },
      addedAt: now,
    });
    if (sent) setBody("");
  };
  return (
    <ListSection title="Comments">
      {context.comments.map((comment) => (
        <WorkBlock key={comment.commentId}>
          <WorkText>{comment.body}</WorkText>
          <WorkText muted>
            {comment.attribution?.actor.displayName ?? comment.attribution?.actor.kind ?? "Unknown"}
          </WorkText>
        </WorkBlock>
      ))}
      <WorkBlock>
        <WorkInput
          label="Add a comment"
          value={body}
          onChange={setBody}
          multiline
          maxLength={32000}
        />
        {writer.failureFor(key) ? <Notice tone="danger" message={writer.failureFor(key)!} /> : null}
        <View className={Platform.OS === "android" ? "items-start" : undefined}>
          <Button
            label="Comment"
            tone="secondary"
            loading={writer.pendingKey === key}
            disabled={body.trim() === "" || surface.blocked !== null}
            onPress={() => void add()}
          />
        </View>
      </WorkBlock>
    </ListSection>
  );
}
