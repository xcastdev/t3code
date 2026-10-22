import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  asProjectTeamRecord,
  asProjectWorkBriefing,
  asProjectWorkDecision,
  asProjectWorkKnowledge,
  asProjectWorkTask,
  asProjectWorkTaskContext,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  EnvironmentId,
  ProjectId,
  ProjectIssueRepositoryBindingsRead,
  ProjectIssueRepositoryIdentityRead,
  ProjectIssueSyncReceipt,
  ProjectWorkAttentionRead,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
  type ProjectWorkDecisionRead,
  type ProjectWorkKnowledgeRead,
  type ProjectWorkTaskRead,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Chip } from "../../components/ui/Chip";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProject } from "../../state/entities";
import { projectWorkEnvironment } from "../../state/projectWork";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  WorkBlock,
  WorkFormActions,
  WorkInput,
  WorkPager,
  WorkReadNotice,
  WorkRecordsNotice,
  WorkScopeLabel,
  WorkTaskLink,
  WorkTaskPicker,
  WorkText,
} from "./WorkParts";
import { WorkInboxSection, WorkProjectList, WorkSupervisionSection } from "./WorkOverviewSections";
import { WorkTeamSection } from "./WorkTeam";
import {
  humanAttribution,
  newCommandId,
  useWorkRead,
  useWorkReview,
  useWorkWriter,
  workWriteBlockedReason,
  type WorkWriter,
} from "./useWork";
import { useWorkPage, useWorkRecords, workRecordsBlockedReason } from "./useWorkRecords";
import {
  existingTaskRefineChanged,
  existingTaskRefineFields,
  existingTaskRefineSnapshot,
  knowledgeLineage,
  pageWindow,
  type ExistingTaskRefineReview,
} from "./workLogic";
import {
  isIssueRecord,
  isMissionRecord,
  workStateLabel,
  type WorkIssueRecord,
  type WorkMissionRecord,
} from "./workModel";

const isAttention = Schema.is(ProjectWorkAttentionRead);
const decodeBindings = Schema.decodeUnknownOption(ProjectIssueRepositoryBindingsRead);
const decodeIdentity = Schema.decodeUnknownOption(ProjectIssueRepositoryIdentityRead);
const decodeReceipt = Schema.decodeUnknownOption(ProjectIssueSyncReceipt);
const LIST_PAGE = 32;

export { WorkProjectList };
export type WorkSection = "overview" | "tasks" | "knowledge" | "intake";

function useScrollInsets() {
  const insets = useSafeAreaInsets();
  return { paddingBottom: Math.max(insets.bottom, 18) + 18 };
}

export function SettingsWorkRouteScreen() {
  const navigation = useNavigation();
  const style = useScrollInsets();
  return (
    <SettingsScreen title="Work">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        <WorkProjectList
          onOpenProject={(environmentId, projectId) =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsWorkProject", params: { environmentId, projectId } },
            })
          }
          onOpenTask={(environmentId, projectId, taskId) =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsWorkTask", params: { environmentId, projectId, taskId } },
            })
          }
        />
      </ScrollView>
    </SettingsScreen>
  );
}

type ProjectProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

export function SettingsWorkProjectRouteScreen({ route }: ProjectProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const navigation = useNavigation();
  const [section, setSection] = useState<WorkSection>("overview");
  const style = useScrollInsets();
  return (
    <SettingsScreen title={project?.title ?? "Work"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={style}
      >
        {project === null ? (
          <WorkText muted>
            This project isn't on the selected environment, or it was removed.
          </WorkText>
        ) : (
          <WorkProjectContent
            key={`${environmentId}:${projectId}`}
            scope={{ environmentId, projectId, checkoutPath: project.workspaceRoot }}
            section={section}
            onSectionChange={setSection}
            onOpenTask={(taskId) =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsWorkTask",
                  params: { environmentId, projectId, taskId },
                },
              })
            }
          />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

/** Work for one checkout. Hosts own navigation, so the Work tab and Settings share it. */
export function WorkProjectContent(props: {
  readonly scope: ProjectWorkScope;
  readonly section: WorkSection;
  readonly onSectionChange: (section: WorkSection) => void;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { scope, section, onOpenTask } = props;
  const writer = useWorkWriter(scope.environmentId);
  return (
    <>
      <WorkScopeLabel scope={scope} />
      <SegmentedControl
        role="tab"
        options={[
          { value: "overview", label: "Overview" },
          { value: "tasks", label: "Tasks" },
          { value: "knowledge", label: "Knowledge" },
          { value: "intake", label: "Intake" },
        ]}
        selected={section}
        onSelect={props.onSectionChange}
      />
      {section === "overview" ? (
        <Overview scope={scope} writer={writer} onOpenTask={onOpenTask} />
      ) : section === "tasks" ? (
        <Tasks scope={scope} writer={writer} onOpenTask={onOpenTask} />
      ) : section === "knowledge" ? (
        <>
          <Knowledge scope={scope} writer={writer} />
          <Decisions scope={scope} writer={writer} />
        </>
      ) : (
        <Intake scope={scope} writer={writer} />
      )}
    </>
  );
}

function Overview({
  scope,
  writer,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const briefingView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "briefing",
    kind: "standard",
  });
  const attention = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "attention" },
    LIST_PAGE,
  );
  const missions = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "foundation-records", recordKind: "mission" },
    LIST_PAGE,
  );
  const briefing = asProjectWorkBriefing(briefingView.value);
  const attentionItems = (attention.view.page?.items ?? [])
    .map((item) => item.value)
    .filter(isAttention)
    .filter((entry) => entry.resolvedAt === undefined);
  const missionItems = (missions.view.page?.items ?? []).flatMap((item): WorkMissionRecord[] => {
    const record = asProjectTeamRecord(item.value);
    return record !== null && isMissionRecord(record) ? [record] : [];
  });
  return (
    <>
      <WorkReadNotice view={briefingView} subject="the brief" />
      <ListSection title="Brief">
        <WorkBlock>
          <WorkText muted={briefing === null}>
            {briefing ? (briefing.narrative ?? briefing.text) : "No brief is available yet."}
          </WorkText>
        </WorkBlock>
      </ListSection>
      <WorkSupervisionSection scope={scope} onOpenTask={onOpenTask} />
      <WorkInboxSection scope={scope} writer={writer} onOpenTask={onOpenTask} />
      <WorkReadNotice view={attention.view} subject="attention" />
      <ListSection title="Needs attention">
        {attentionItems.length === 0 ? (
          <WorkBlock>
            <WorkText muted>
              {attention.offset === 0 ? "Nothing needs attention." : "Nothing open on this page."}
            </WorkText>
          </WorkBlock>
        ) : (
          attentionItems.map((entry) => (
            <ListRow
              key={`${entry.taskId}:${entry.reason}`}
              icon="exclamationmark.triangle"
              label={workStateLabel(entry.reason)}
              {...(entry.detail ? { description: entry.detail } : {})}
              onPress={() => onOpenTask(entry.taskId)}
            />
          ))
        )}
        <WorkPager pager={attention} noun="Items" />
      </ListSection>
      <WorkReadNotice view={missions.view} subject="missions" />
      <ListSection title="Missions" footer="New missions come from refining an issue in Intake.">
        {missionItems.length === 0 ? (
          <WorkBlock>
            <WorkText muted>
              {missions.offset === 0 ? "No missions." : "No more missions."}
            </WorkText>
          </WorkBlock>
        ) : (
          missionItems.map((mission) => (
            <MissionRow
              key={mission.recordId}
              scope={scope}
              mission={mission}
              onOpenTask={onOpenTask}
            />
          ))
        )}
        <WorkPager pager={missions} noun="Missions" />
      </ListSection>
      <WorkTeamSection scope={scope} writer={writer} />
    </>
  );
}

const REQUIRED_WINDOW = 10;

function MissionRow(props: {
  scope: ProjectWorkScope;
  mission: WorkMissionRecord;
  onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { mission } = props;
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const required = mission.requiredTaskIds;
  const shown = required.slice(offset, offset + REQUIRED_WINDOW);
  const window = pageWindow(
    offset,
    shown.length,
    REQUIRED_WINDOW,
    offset + REQUIRED_WINDOW < required.length,
  );
  return (
    <View>
      <WorkBlock>
        <WorkText>{mission.title}</WorkText>
        <WorkText muted>{workStateLabel(mission.status)}</WorkText>
        {mission.objective ? <WorkText>{mission.objective}</WorkText> : null}
      </WorkBlock>
      <ListActionRow
        icon={open ? "chevron.down" : "chevron.right"}
        label={`${required.length} required ${required.length === 1 ? "task" : "tasks"}`}
        disabled={required.length === 0}
        onPress={() => setOpen(!open)}
      />
      {open
        ? shown.map((taskId) => (
            <WorkTaskLink
              key={taskId}
              scope={props.scope}
              taskId={taskId}
              onOpen={props.onOpenTask}
            />
          ))
        : null}
      {open && required.length > REQUIRED_WINDOW ? (
        <WorkPager
          noun="Tasks"
          pager={{
            window,
            next: () => window.nextOffset !== null && setOffset(window.nextOffset),
            previous: () => window.previousOffset !== null && setOffset(window.previousOffset),
          }}
        />
      ) : null}
    </View>
  );
}

const DELIVERABLES = ["code", "research", "plan", "review", "non-code", "reminder"] as const;

function Tasks({
  scope,
  writer,
  onOpenTask,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "tasks" },
    LIST_PAGE,
  );
  const view = pager.view;
  const tasks = (view.page?.items ?? []).flatMap((item): ProjectWorkTaskRead[] => {
    const task = asProjectWorkTask(item.value);
    return task === null || task.projectId !== scope.projectId ? [] : [task];
  });
  const blocked = workWriteBlockedReason(view, writer.canWrite);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"guided" | "simple">("guided");
  const [deliverable, setDeliverable] = useState<(typeof DELIVERABLES)[number]>("code");
  const key = "task:create";
  const create = async () => {
    if (view.page === null) return;
    const selected: ProjectWorkSelection = {
      ...scope,
      revision: view.page.revision,
      taskRevision: 0,
    };
    const taskId = ProjectWorkTaskId.make(uuidv4());
    const sent = await writer.submit(key, selected, selected, {
      type: "project-work.task.create",
      commandId: newCommandId(),
      projectId: scope.projectId,
      expectedRevision: selected.revision,
      taskId,
      title: title.trim(),
      ...(kind === "guided" ? { deliverableKind: deliverable } : {}),
      createdAt: new Date().toISOString(),
    });
    if (sent) {
      setCreating(false);
      setTitle("");
      onOpenTask(taskId);
    }
  };
  return (
    <>
      <WorkReadNotice view={view} subject="tasks" />
      <ListSection title="Tasks">
        {creating ? (
          <WorkBlock>
            <WorkInput label="Title" value={title} onChange={setTitle} />
            <SegmentedControl
              size="compact"
              options={[
                { value: "guided", label: "Guided" },
                { value: "simple", label: "Simple" },
              ]}
              selected={kind}
              onSelect={setKind}
            />
            {kind === "guided" ? (
              <View className="flex-row flex-wrap gap-2">
                {DELIVERABLES.map((value) => (
                  <Chip
                    key={value}
                    label={workStateLabel(value)}
                    selected={deliverable === value}
                    onPress={() => setDeliverable(value)}
                  />
                ))}
              </View>
            ) : null}
            <WorkText muted>
              {kind === "guided"
                ? "Guided tasks record scope and plan approvals. Approving never starts work."
                : "Simple tasks keep a scope, criteria and one approval."}
            </WorkText>
            <WorkFormActions
              submitLabel="Create task"
              pending={writer.pendingKey === key}
              disabled={title.trim() === "" || blocked !== null}
              failure={writer.failureFor(key)}
              onSubmit={() => void create()}
              onCancel={() => setCreating(false)}
            />
          </WorkBlock>
        ) : (
          <ListActionRow
            icon="plus"
            label="New task"
            {...(blocked ? { description: blocked } : {})}
            disabled={blocked !== null}
            onPress={() => setCreating(true)}
          />
        )}
        {tasks.map((task) => (
          <ListRow
            key={task.taskId}
            label={task.title}
            description={`${workStateLabel(task.state)} · r${task.revision}`}
            onPress={() => onOpenTask(task.taskId)}
          />
        ))}
        {view.page !== null && tasks.length === 0 && !creating ? (
          <WorkBlock>
            <WorkText muted>{pager.offset === 0 ? "No tasks yet." : "No more tasks."}</WorkText>
          </WorkBlock>
        ) : null}
        <WorkPager pager={pager} noun="Tasks" />
      </ListSection>
    </>
  );
}

const projectSelection = (scope: ProjectWorkScope, revision: number): ProjectWorkSelection => ({
  ...scope,
  revision,
  taskRevision: 0,
});

function Knowledge({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "knowledge" },
    LIST_PAGE,
  );
  // A replacement may be on any page, so currentness reads the whole history.
  const history = useWorkRecords(scope.environmentId, {
    projectId: scope.projectId,
    operation: "knowledge",
  });
  const view = pager.view;
  const entries = (view.page?.items ?? []).flatMap((item): ProjectWorkKnowledgeRead[] => {
    const entry = asProjectWorkKnowledge(item.value);
    return entry === null ? [] : [entry];
  });
  const lineage = knowledgeLineage(
    history.records.flatMap((value): ProjectWorkKnowledgeRead[] => {
      const entry = asProjectWorkKnowledge(value);
      return entry === null ? [] : [entry];
    }),
  );
  const current = view.page ? projectSelection(scope, view.page.revision) : null;
  const blocked = workWriteBlockedReason(view, writer.canWrite);
  const historyBlocked =
    workRecordsBlockedReason(history, "knowledge history") ??
    (history.revision === view.page?.revision ? null : "Knowledge history is catching up.");
  const [editing, setEditing] = useState<ProjectWorkKnowledgeRead | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const review = useWorkReview(current ?? projectSelection(scope, -1));
  const key = "knowledge";
  const reviseReason = (entry: ProjectWorkKnowledgeRead) => {
    const replacement = lineage.supersededBy.get(entry.knowledgeId);
    return (
      blocked ??
      historyBlocked ??
      (replacement ? `Replaced by “${replacement.title}”. Revise the current version.` : null)
    );
  };
  const editingReason =
    editing === null ? null : editing === "new" ? blocked : reviseReason(editing);

  const open = (target: ProjectWorkKnowledgeRead | "new") => {
    setEditing(target);
    setTitle(target === "new" ? "" : target.title);
    setBody(target === "new" ? "" : target.body);
    review.open();
  };
  const save = async () => {
    if (review.selected === null || current === null || editing === null) return;
    if (editingReason !== null) return;
    const now = new Date().toISOString();
    const sent = await writer.submit(key, review.selected, current, {
      type: "project-work.knowledge.promote",
      commandId: newCommandId(),
      projectId: scope.projectId,
      expectedRevision: review.selected.revision,
      knowledge: {
        knowledgeId: ProjectWorkKnowledgeId.make(uuidv4()),
        ...(editing === "new" ? {} : { supersedesKnowledgeId: editing.knowledgeId }),
        projectId: scope.projectId,
        title: title.trim(),
        body: body.trim(),
        sourceKind: "manual",
        sourceId: "mobile",
        revision: 0,
        createdAt: now,
        updatedAt: now,
      },
      promotedAt: now,
    });
    if (sent) {
      setEditing(null);
      review.close();
    }
  };

  return (
    <>
      <WorkReadNotice view={view} subject="knowledge" />
      {history.complete && history.status === "ready" ? null : (
        <WorkRecordsNotice set={history} subject="knowledge history" />
      )}
      <ListSection
        title="Knowledge"
        footer="Revising keeps the earlier version as history and marks it replaced."
      >
        {editing !== null ? (
          <WorkBlock>
            {editing !== "new" ? <WorkText muted>Revising “{editing.title}”</WorkText> : null}
            <WorkInput label="Title" value={title} onChange={setTitle} />
            <WorkInput
              label="What should be remembered"
              value={body}
              onChange={setBody}
              multiline
              maxLength={32000}
            />
            {editingReason ? <WorkText muted>{editingReason}</WorkText> : null}
            <WorkFormActions
              submitLabel={editing === "new" ? "Save knowledge" : "Save revision"}
              pending={writer.pendingKey === key}
              disabled={title.trim() === "" || editingReason !== null}
              failure={writer.failureFor(key)}
              changed={review.changed}
              onReview={review.rebase}
              onSubmit={() => void save()}
              onCancel={() => {
                setEditing(null);
                review.close();
              }}
            />
          </WorkBlock>
        ) : (
          <ListActionRow
            icon="plus"
            label="Add knowledge"
            {...(blocked ? { description: blocked } : {})}
            disabled={blocked !== null}
            onPress={() => open("new")}
          />
        )}
        {entries.map((entry) => {
          const replacement = lineage.supersededBy.get(entry.knowledgeId);
          const predecessor =
            entry.supersedesKnowledgeId === undefined
              ? null
              : (lineage.byId.get(entry.supersedesKnowledgeId) ?? null);
          const reason = reviseReason(entry);
          return (
            <View key={entry.knowledgeId}>
              <WorkBlock>
                <WorkText muted={replacement !== undefined}>{entry.title}</WorkText>
                {entry.body ? <WorkText muted>{entry.body}</WorkText> : null}
                <WorkText muted>
                  {history.complete
                    ? replacement
                      ? "Replaced"
                      : "Current"
                    : "Checking currentness"}
                  {replacement ? ` by “${replacement.title}”` : ""}
                  {entry.supersedesKnowledgeId !== undefined
                    ? ` · replaces ${predecessor ? `“${predecessor.title}”` : "an earlier entry"}`
                    : ""}
                </WorkText>
              </WorkBlock>
              {replacement || editing !== null ? null : (
                <ListActionRow
                  icon="pencil"
                  label="Revise…"
                  {...(reason ? { description: reason } : {})}
                  disabled={reason !== null}
                  onPress={() => open(entry)}
                />
              )}
            </View>
          );
        })}
        {view.page !== null && entries.length === 0 && editing === null ? (
          <WorkBlock>
            <WorkText muted>
              {pager.offset === 0 ? "No knowledge yet." : "No more knowledge."}
            </WorkText>
          </WorkBlock>
        ) : null}
        <WorkPager pager={pager} noun="Entries" />
      </ListSection>
    </>
  );
}

type DecisionForm =
  | { readonly mode: "propose" }
  | {
      readonly mode: "reject" | "supersede" | "accept";
      readonly decision: ProjectWorkDecisionRead;
    };

function Decisions({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "decisions" },
    LIST_PAGE,
  );
  const view = pager.view;
  const decisions = (view.page?.items ?? []).flatMap((item): ProjectWorkDecisionRead[] => {
    const entry = asProjectWorkDecision(item.value);
    return entry === null ? [] : [entry];
  });
  const current = view.page ? projectSelection(scope, view.page.revision) : null;
  const blocked = workWriteBlockedReason(view, writer.canWrite);
  const review = useWorkReview(current ?? projectSelection(scope, -1));
  const [form, setForm] = useState<DecisionForm | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const keyFor = (decision: ProjectWorkDecisionRead | null) =>
    `decision:${decision?.decisionId ?? "new"}`;

  const open = (next: DecisionForm) => {
    setForm(next);
    setTitle(next.mode === "supersede" ? next.decision.title : "");
    setBody(next.mode === "supersede" ? next.decision.body : "");
    setReason("");
    review.open();
  };
  const send = async () => {
    if (form === null || review.selected === null || current === null) return;
    const selected = review.selected;
    const now = new Date().toISOString();
    const base = {
      commandId: newCommandId(),
      projectId: scope.projectId,
      expectedRevision: selected.revision,
    };
    const intent =
      form.mode === "propose"
        ? {
            ...base,
            type: "project-work.decision.propose",
            decision: {
              decisionId: ProjectWorkDecisionId.make(uuidv4()),
              projectId: scope.projectId,
              title: title.trim(),
              body: body.trim(),
              state: "proposed",
              revision: 0,
              createdAt: now,
              updatedAt: now,
            },
            proposedAt: now,
          }
        : form.mode === "accept"
          ? {
              ...base,
              type: "project-work.decision.accept",
              decisionId: form.decision.decisionId,
              acceptedAt: now,
            }
          : form.mode === "reject"
            ? {
                ...base,
                type: "project-work.decision.reject",
                decisionId: form.decision.decisionId,
                reason: reason.trim(),
                rejectedAt: now,
              }
            : {
                ...base,
                type: "project-work.decision.supersede",
                decisionId: form.decision.decisionId,
                replacement: {
                  decisionId: ProjectWorkDecisionId.make(uuidv4()),
                  projectId: scope.projectId,
                  title: title.trim(),
                  body: body.trim(),
                  state: "proposed",
                  supersedesDecisionId: form.decision.decisionId,
                  revision: 0,
                  createdAt: now,
                  updatedAt: now,
                  attribution: humanAttribution(now),
                },
                supersededAt: now,
                attribution: humanAttribution(now),
              };
    const key = keyFor(form.mode === "propose" ? null : form.decision);
    if (await writer.submit(key, selected, current, intent)) {
      setForm(null);
      review.close();
    }
  };
  const close = () => {
    setForm(null);
    review.close();
  };
  const formFor = (decision: ProjectWorkDecisionRead | null) => {
    if (form === null) return null;
    if (decision === null ? form.mode !== "propose" : form.mode === "propose") return null;
    if (
      decision !== null &&
      form.mode !== "propose" &&
      form.decision.decisionId !== decision.decisionId
    )
      return null;
    const key = keyFor(decision);
    const submitLabel =
      form.mode === "accept"
        ? "Confirm acceptance"
        : form.mode === "reject"
          ? "Confirm rejection"
          : form.mode === "supersede"
            ? "Propose replacement"
            : "Propose decision";
    const textForm = form.mode === "propose" || form.mode === "supersede";
    return (
      <WorkBlock>
        {form.mode === "accept" ? (
          <WorkText muted>
            Accepting records this decision as agreed. It doesn't start any work.
          </WorkText>
        ) : null}
        {form.mode === "supersede" ? (
          <WorkText muted>
            The accepted decision stays in history as superseded; the replacement starts as a
            proposal.
          </WorkText>
        ) : null}
        {textForm ? (
          <>
            <WorkInput
              label={form.mode === "supersede" ? "Replacement decision" : "Decision"}
              value={title}
              onChange={setTitle}
            />
            <WorkInput
              label="Context and consequences"
              value={body}
              onChange={setBody}
              multiline
              maxLength={32000}
            />
          </>
        ) : null}
        {form.mode === "reject" ? (
          <WorkInput label="Why reject it?" value={reason} onChange={setReason} multiline />
        ) : null}
        <WorkFormActions
          submitLabel={submitLabel}
          pending={writer.pendingKey === key}
          disabled={
            blocked !== null ||
            (textForm && title.trim() === "") ||
            (form.mode === "reject" && reason.trim() === "")
          }
          failure={writer.failureFor(key)}
          changed={review.changed}
          onReview={review.rebase}
          onSubmit={() => void send()}
          onCancel={close}
        />
      </WorkBlock>
    );
  };

  return (
    <>
      <WorkReadNotice view={view} subject="decisions" />
      <ListSection
        title="Decisions"
        footer="Proposed choices stay proposed until a person accepts or rejects them."
      >
        {formFor(null) ?? (
          <ListActionRow
            icon="plus"
            label="Propose decision"
            {...(blocked ? { description: blocked } : {})}
            disabled={blocked !== null || form !== null}
            onPress={() => open({ mode: "propose" })}
          />
        )}
        {decisions.map((decision) => {
          const decisionForm = formFor(decision);
          const failure = decisionForm === null ? writer.failureFor(keyFor(decision)) : null;
          return (
            <View key={decision.decisionId}>
              <WorkBlock>
                <WorkText>{decision.title}</WorkText>
                {decision.body ? <WorkText>{decision.body}</WorkText> : null}
                <WorkText muted>
                  {workStateLabel(decision.state)}
                  {decision.rejectionReason ? ` · ${decision.rejectionReason}` : ""}
                </WorkText>
              </WorkBlock>
              {failure ? (
                <WorkBlock>
                  <Notice tone="danger" message={failure} />
                </WorkBlock>
              ) : null}
              {decisionForm ??
                (form !== null ? null : decision.state === "proposed" ? (
                  <>
                    <ListActionRow
                      label="Accept…"
                      disabled={blocked !== null}
                      onPress={() => open({ mode: "accept", decision })}
                    />
                    <ListActionRow
                      label="Reject…"
                      tone="danger"
                      disabled={blocked !== null}
                      onPress={() => open({ mode: "reject", decision })}
                    />
                  </>
                ) : decision.state === "accepted" ? (
                  <ListActionRow
                    label="Supersede…"
                    disabled={blocked !== null}
                    onPress={() => open({ mode: "supersede", decision })}
                  />
                ) : null)}
            </View>
          );
        })}
        {view.page !== null && decisions.length === 0 && form === null ? (
          <WorkBlock>
            <WorkText muted>
              {pager.offset === 0 ? "No decisions recorded." : "No more decisions."}
            </WorkText>
          </WorkBlock>
        ) : null}
        <WorkPager pager={pager} noun="Decisions" />
      </ListSection>
    </>
  );
}

type Binding = ProjectIssueRepositoryBindingsRead["items"][number];
type Identity = ProjectIssueRepositoryIdentityRead;
const bindingKey = (entry: { host: string; repositoryNodeId: string }) =>
  `${entry.host}:${entry.repositoryNodeId}`;

function Intake({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const [generation, setGeneration] = useState(0);
  return (
    <>
      {writer.canIssue ? (
        <Bindings
          key={generation}
          scope={scope}
          writer={writer}
          onReload={() => setGeneration(generation + 1)}
        />
      ) : (
        <Notice icon="info.circle" message="This connection can't manage issue intake here." />
      )}
      <Issues scope={scope} writer={writer} />
    </>
  );
}

/** Listing is a guarded command, not a stream: each generation lists once; changes reload. */
function Bindings({
  scope,
  writer,
  onReload,
}: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  onReload: () => void;
}) {
  const [items, setItems] = useState<ReadonlyArray<Binding> | "loading" | "unavailable">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [detaching, setDetaching] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void projectWorkEnvironment.issue
      .run(appAtomRegistry, {
        environmentId: scope.environmentId,
        input: { operation: "list", input: { projectId: scope.projectId } },
      })
      .then((result) => {
        if (!live) return;
        const decoded =
          result._tag === "Success" ? Option.getOrNull(decodeBindings(result.value)) : null;
        setItems(decoded === null ? "unavailable" : decoded.items);
      });
    return () => {
      live = false;
    };
  }, [scope.environmentId, scope.projectId]);
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
    setDetaching(null);
    if (value === null) return;
    if (operation === "detach") return onReload();
    const receipt = Option.getOrNull(decodeReceipt(value));
    setNotice(
      receipt === null
        ? "Sync finished with an unrecognized response."
        : receipt.status === "committed"
          ? `Saved ${receipt.count} issues.${receipt.nextPage === null ? "" : " Sync again for more."}`
          : receipt.status === "paused"
            ? "GitHub asked to slow down. Try again later."
            : `Sync failed: ${receipt.reason}`,
    );
  };
  return (
    <ListSection
      title="GitHub issue intake"
      footer="Issues arrive only when you sync. Their text is a proposal until you refine it."
    >
      {items === "loading" ? (
        <WorkBlock>
          <WorkText muted>Loading repository bindings…</WorkText>
        </WorkBlock>
      ) : items === "unavailable" ? (
        <>
          <WorkBlock>
            <Notice tone="danger" message="Couldn't list repository bindings." />
          </WorkBlock>
          <ListActionRow icon="arrow.clockwise" label="Retry" onPress={onReload} />
        </>
      ) : (
        <>
          {binding ? (
            <BindFlow
              scope={scope}
              writer={writer}
              bindings={items}
              onDone={(bound) => {
                setBinding(false);
                if (bound) onReload();
              }}
            />
          ) : (
            <ListActionRow
              icon="plus"
              label="Bind repository…"
              disabled={writer.pendingKey !== null}
              onPress={() => setBinding(true)}
            />
          )}
          {items.length === 0 ? (
            <WorkBlock>
              <WorkText muted>No repository bound.</WorkText>
            </WorkBlock>
          ) : null}
          {items.map((entry) => {
            const key = `issue:${bindingKey(entry)}`;
            return (
              <View key={bindingKey(entry)}>
                <WorkBlock>
                  <WorkText>{entry.repositoryName || entry.repositoryNodeId}</WorkText>
                  <WorkText muted>
                    {workStateLabel(entry.status)} · {entry.host}
                    {entry.accountLogin ? ` · as ${entry.accountLogin}` : ""} · r
                    {entry.bindingRevision}
                  </WorkText>
                </WorkBlock>
                {entry.status === "active" ? (
                  detaching === bindingKey(entry) ? (
                    <WorkBlock>
                      <WorkText muted>
                        Detaching stops syncing. Issues already copied stay.
                      </WorkText>
                      <WorkFormActions
                        submitLabel="Confirm detach"
                        pending={writer.pendingKey === key}
                        disabled={false}
                        failure={null}
                        onSubmit={() => void run("detach", entry)}
                        onCancel={() => setDetaching(null)}
                      />
                    </WorkBlock>
                  ) : (
                    <>
                      <ListActionRow
                        icon="arrow.clockwise"
                        label="Sync one page"
                        loading={writer.pendingKey === key}
                        disabled={writer.pendingKey !== null}
                        onPress={() => void run("sync", entry)}
                      />
                      <ListActionRow
                        label="Detach…"
                        tone="danger"
                        disabled={writer.pendingKey !== null}
                        onPress={() => setDetaching(bindingKey(entry))}
                      />
                    </>
                  )
                ) : binding ? null : (
                  <ListActionRow
                    icon="link"
                    label="Bind again…"
                    disabled={writer.pendingKey !== null}
                    onPress={() => setBinding(true)}
                  />
                )}
                {writer.failureFor(key) ? (
                  <WorkBlock>
                    <Notice tone="danger" message={writer.failureFor(key)!} />
                  </WorkBlock>
                ) : null}
              </View>
            );
          })}
        </>
      )}
      {notice ? (
        <WorkBlock>
          <WorkText muted>{notice}</WorkText>
        </WorkBlock>
      ) : null}
    </ListSection>
  );
}

/** Ask the server which repository and account this checkout resolves to, then bind exactly that. */
function BindFlow(props: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  bindings: ReadonlyArray<Binding>;
  onDone: (bound: boolean) => void;
}) {
  const { writer } = props;
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [unrecognized, setUnrecognized] = useState(false);
  const existing =
    identity === null
      ? null
      : (props.bindings.find((entry) => bindingKey(entry) === bindingKey(identity)) ?? null);
  const discover = async () => {
    setUnrecognized(false);
    const value = await writer.runIssue("issue:identity", {
      operation: "identity",
      input: { projectId: props.scope.projectId },
    });
    if (value === null) return;
    const decoded = Option.getOrNull(decodeIdentity(value));
    setIdentity(decoded);
    setUnrecognized(decoded === null);
  };
  const bind = async () => {
    if (identity === null) return;
    const value = await writer.runIssue("issue:bind", {
      operation: "bind",
      input: {
        projectId: props.scope.projectId,
        expectedRepositoryKey: { host: identity.host, repositoryNodeId: identity.repositoryNodeId },
        expectedTargetBindingRevision: existing?.bindingRevision ?? null,
        accountLogin: identity.accountLogin,
      },
    });
    if (value !== null) props.onDone(true);
  };
  if (identity === null)
    return (
      <WorkBlock>
        <WorkText muted>
          Work asks the server which GitHub repository this checkout points to and which account is
          signed in there. Nothing is bound until you confirm.
        </WorkText>
        <WorkFormActions
          submitLabel="Find repository"
          pending={writer.pendingKey === "issue:identity"}
          disabled={writer.pendingKey !== null}
          failure={
            unrecognized
              ? "The server answered with a repository this client doesn't recognize."
              : writer.failureFor("issue:identity")
          }
          onSubmit={() => void discover()}
          onCancel={() => props.onDone(false)}
        />
      </WorkBlock>
    );
  return (
    <WorkBlock>
      <WorkText>{identity.repositoryName}</WorkText>
      <WorkText muted>
        {identity.host} · as {identity.accountLogin}
      </WorkText>
      <WorkText muted>
        {existing === null
          ? "Binding lets you sync this repository's issues on request."
          : existing.status === "active"
            ? "Already bound. Binding again refreshes the account it syncs as."
            : `Resumes the detached binding at revision ${existing.bindingRevision}.`}
      </WorkText>
      <WorkFormActions
        submitLabel="Bind repository"
        pending={writer.pendingKey === "issue:bind"}
        disabled={writer.pendingKey !== null}
        failure={writer.failureFor("issue:bind")}
        onSubmit={() => void bind()}
        onCancel={() => props.onDone(false)}
      />
    </WorkBlock>
  );
}

function Issues({ scope, writer }: { scope: ProjectWorkScope; writer: WorkWriter }) {
  const pager = useWorkPage(
    scope.environmentId,
    { projectId: scope.projectId, operation: "foundation-records", recordKind: "issue" },
    LIST_PAGE,
  );
  const view = pager.view;
  const issues = (view.page?.items ?? []).flatMap((item): WorkIssueRecord[] => {
    const record = asProjectTeamRecord(item.value);
    return record !== null && isIssueRecord(record) ? [record] : [];
  });
  const current = view.page ? projectSelection(scope, view.page.revision) : null;
  const blocked = workWriteBlockedReason(view, writer.canWrite);
  return (
    <>
      <WorkReadNotice view={view} subject="issues" />
      <ListSection title="Issues">
        {view.page !== null && issues.length === 0 ? (
          <WorkBlock>
            <WorkText muted>
              {pager.offset === 0
                ? "No issues copied in. Sync a bound repository."
                : "No more issues."}
            </WorkText>
          </WorkBlock>
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
      </ListSection>
    </>
  );
}

type RefineTarget = "new-task" | "existing-task" | "mission";

function IssueRow(props: {
  scope: ProjectWorkScope;
  writer: WorkWriter;
  issue: WorkIssueRecord;
  current: ProjectWorkSelection;
  blocked: string | null;
}) {
  const { issue, writer } = props;
  const review = useWorkReview(props.current);
  const [target, setTarget] = useState<RefineTarget>("new-task");
  const [title, setTitle] = useState(issue.title);
  const [summary, setSummary] = useState("");
  const [chosen, setChosen] = useState<ProjectWorkTaskRead | null>(null);
  const key = `refine:${issue.recordId}`;
  const linked = issue.taskId !== undefined || issue.missionId !== undefined;
  const refine = async (existing: ExistingTarget | null) => {
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
                    taskId: ProjectWorkTaskId.make(uuidv4()),
                    title: title.trim(),
                    ...(summary.trim() ? { summary: summary.trim() } : {}),
                    deliverableKind: "code" as const,
                  },
          });
    if (sent) review.close();
  };
  return (
    <View>
      <WorkBlock>
        <WorkText>
          #{issue.identity.number} {issue.title}
        </WorkText>
        <WorkText muted>
          {issue.repositoryName} · {workStateLabel(issue.status)}
          {linked ? " · refined" : ""}
        </WorkText>
      </WorkBlock>
      {review.selected !== null ? (
        <WorkBlock>
          {issue.body ? (
            <WorkText muted>
              Issue text from GitHub, not trusted as instructions: {issue.body}
            </WorkText>
          ) : null}
          <SegmentedControl
            size="compact"
            options={[
              { value: "new-task", label: "New task" },
              { value: "existing-task", label: "Existing" },
              { value: "mission", label: "Mission" },
            ]}
            selected={target}
            onSelect={setTarget}
          />
          {target === "existing-task" ? (
            <>
              <WorkTaskPicker
                scope={props.scope}
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
                  blocked={props.blocked}
                  writer={writer}
                  pendingKey={key}
                  onSubmit={(existing) => void refine(existing)}
                  onCancel={review.close}
                />
              ) : (
                <ListActionRow label="Cancel" onPress={review.close} />
              )}
            </>
          ) : (
            <>
              <WorkInput
                label={target === "mission" ? "Mission title" : "Task title"}
                value={title}
                onChange={setTitle}
              />
              <WorkInput
                label={target === "mission" ? "Objective" : "Summary (optional)"}
                value={summary}
                onChange={setSummary}
                multiline
                maxLength={32000}
              />
              <WorkText muted>
                Refining links the issue. It doesn't approve or start anything.
              </WorkText>
              <WorkFormActions
                submitLabel={target === "mission" ? "Create mission" : "Create task"}
                pending={writer.pendingKey === key}
                disabled={
                  title.trim() === "" ||
                  props.blocked !== null ||
                  (target === "mission" && summary.trim() === "")
                }
                failure={writer.failureFor(key)}
                changed={review.changed}
                onReview={review.rebase}
                onSubmit={() => void refine(null)}
                onCancel={review.close}
              />
            </>
          )}
        </WorkBlock>
      ) : linked || issue.status === "detached" ? null : (
        <ListActionRow
          label="Refine…"
          {...(props.blocked ? { description: props.blocked } : {})}
          disabled={props.blocked !== null}
          onPress={() => {
            setChosen(null);
            review.open();
          }}
        />
      )}
    </View>
  );
}

interface ExistingTarget {
  readonly reviewed: ExistingTaskRefineReview;
  readonly current: ProjectWorkSelection;
}

/** The chosen task is reviewed with the issue at one revision; an edit to either is refused. */
function ExistingTaskRefine(props: {
  scope: ProjectWorkScope;
  taskId: ProjectWorkTaskId;
  issueRevision: number;
  issuePageRevision: number;
  blocked: string | null;
  writer: WorkWriter;
  pendingKey: string;
  onSubmit: (target: ExistingTarget) => void;
  onCancel: () => void;
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
    <View className="gap-2">
      <WorkReadNotice view={view} subject="the task" />
      {owned && reviewed ? (
        <WorkText muted>
          Attach to “{context.task.title}” at task revision r{reviewed.selected.taskRevision}. It
          doesn't change the task's scope or approvals.
        </WorkText>
      ) : null}
      {reason && !changed ? <WorkText muted>{reason}</WorkText> : null}
      <WorkFormActions
        submitLabel="Attach issue"
        pending={props.writer.pendingKey === props.pendingKey}
        disabled={reviewed === null || current === null || reason !== null}
        failure={props.writer.failureFor(props.pendingKey)}
        changed={changed}
        onReview={() => snapshot && setReviewed(snapshot)}
        onSubmit={() => reviewed && current && props.onSubmit({ reviewed, current })}
        onCancel={props.onCancel}
      />
    </View>
  );
}
