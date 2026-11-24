import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  asProjectTeamRecord,
  asProjectWorkDecision,
  asProjectWorkKnowledge,
  asProjectWorkTaskContext,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  existingTaskRefineChanged,
  existingTaskRefineFields,
  existingTaskRefineSnapshot,
  knowledgeLineage,
  type ExistingTaskRefineReview,
} from "@t3tools/client-runtime/project-work-logic";
import {
  EnvironmentId,
  ProjectId,
  ProjectIssueRepositoryBindingsRead,
  ProjectIssueRepositoryIdentityRead,
  ProjectIssueSyncReceipt,
  ProjectWorkDecisionId,
  ProjectWorkKnowledgeId,
  ProjectWorkTaskId,
  type ProjectWorkActorRead,
  type ProjectWorkDecisionRead,
  type ProjectWorkKnowledgeRead,
  type ProjectWorkTaskRead,
} from "@t3tools/contracts";
import { useNavigation, useRoute, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { use, useEffect, useState, type ReactNode } from "react";
import { ScrollView as HorizontalScroll, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  ScreenScrollView as ScrollView,
  ScreenScrollViewSurface,
} from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectWorkEnvironment } from "../../state/projectWork";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import {
  WorkBlock,
  WorkFormActions,
  WorkInput,
  WorkPager,
  WorkReadNotice,
  WorkRecordsNotice,
  WorkTaskLink,
  WorkTaskPicker,
  WorkText,
} from "./WorkParts";
import { WorkHome, type WorkSectionName } from "./WorkHome";
import { WorkOverview } from "./WorkOverview";
import { WorkTaskList } from "./WorkTasks";
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
import { isIssueRecord, workStateLabel, type WorkIssueRecord } from "./workModel";
import {
  WorkEmptyRow,
  WorkHeading,
  WorkSeparator,
  WorkStatusChip,
  WorkTagChip,
} from "./WorkStatus";

const decodeBindings = Schema.decodeUnknownOption(ProjectIssueRepositoryBindingsRead);
const decodeIdentity = Schema.decodeUnknownOption(ProjectIssueRepositoryIdentityRead);
const decodeReceipt = Schema.decodeUnknownOption(ProjectIssueSyncReceipt);
const LIST_PAGE = 32;

export type WorkSection = WorkSectionName;
export const WORK_SECTIONS: ReadonlyArray<{ readonly value: WorkSection; readonly label: string }> =
  [
    { value: "overview", label: "Overview" },
    { value: "tasks", label: "Tasks" },
    { value: "team", label: "Team" },
    { value: "knowledge", label: "Knowledge" },
    { value: "intake", label: "Intake" },
  ];
const isSection = (value: unknown): value is WorkSection =>
  WORK_SECTIONS.some((section) => section.value === value);

function useBottomInset() {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom, 18) + 18;
}

/**
 * The bar and surface of a Work page. Settings pages keep the Settings sheet look; the same
 * page opened from the workspace is a plain page with native Back.
 */
export function WorkPageFrame(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AppBarAction>;
  readonly children: ReactNode;
}) {
  const route = useRoute();
  const navigation = useNavigation();
  if (route.name.startsWith("Settings"))
    return (
      <SettingsScreen title={props.title} {...(props.actions ? { actions: props.actions } : {})}>
        {props.children}
      </SettingsScreen>
    );
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        subtitle={props.subtitle ?? null}
        {...(props.actions ? { actions: props.actions } : {})}
        onBack={() => navigation.goBack()}
        hideBottomBorder
      />
      <ScreenScrollViewSurface value="bg-screen">
        <ScreenContent surface="screen">{props.children}</ScreenContent>
      </ScreenScrollViewSurface>
    </View>
  );
}

/** Settings › Work: the same cross-project home the Work tab shows. */
export function SettingsWorkRouteScreen() {
  const navigation = useNavigation();
  const bottom = useBottomInset();
  return (
    <SettingsScreen title="Work">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: bottom }}
      >
        <WorkHome
          onOpenProject={(environmentId, projectId, section) =>
            navigation.navigate("SettingsWorkProject", {
              environmentId,
              projectId,
              ...(section ? { section } : {}),
            })
          }
          onOpenTask={(environmentId, projectId, taskId) =>
            navigation.navigate("SettingsWorkTask", { environmentId, projectId, taskId })
          }
        />
      </ScrollView>
    </SettingsScreen>
  );
}

type ProjectProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly section?: WorkSection;
}>;

/**
 * One project's Work, opened at a section. Serves both `ProjectWork` (workspace pages, such as
 * from the Work tab or a thread's tools) and `SettingsWorkProject`.
 */
export function WorkProjectRouteScreen({ route }: ProjectProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const projectId = ProjectId.make(route.params.projectId);
  const section = isSection(route.params.section) ? route.params.section : "overview";
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const { environments, isReady } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const navigation = useNavigation();
  const settings = useRoute().name.startsWith("Settings");
  const subtitle = environment
    ? `${environment.label}${environment.connection.phase === "connected" ? "" : " · offline"}`
    : null;
  return (
    <WorkPageFrame title={project?.title ?? "Work"} subtitle={subtitle}>
      {project === null ? (
        <EmptyState
          variant="plain"
          title={isReady ? "Project not found" : "Loading project…"}
          detail={
            isReady
              ? "This project isn't on the selected environment, or it was removed."
              : "Waiting for this environment's projects."
          }
        />
      ) : (
        <WorkProjectContent
          key={`${environmentId}:${projectId}`}
          scope={{ environmentId, projectId, checkoutPath: project.workspaceRoot }}
          section={section}
          onSectionChange={(next) => navigation.setParams({ section: next })}
          onOpenTask={(taskId) =>
            navigation.navigate(settings ? "SettingsWorkTask" : "WorkTask", {
              environmentId,
              projectId,
              taskId,
            })
          }
        />
      )}
    </WorkPageFrame>
  );
}

/**
 * Pull-to-refresh refetches every Work read of the project. It spins until the supervision
 * read, which every section shows, has come back.
 */
function useProjectRefresh(scope: ProjectWorkScope) {
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "supervision",
  });
  const [pulled, setPulled] = useState<typeof view.result | null>(null);
  const refreshing =
    pulled !== null &&
    view.status !== "disconnected" &&
    (view.result === pulled || view.result.waiting);
  if (pulled !== null && !refreshing) setPulled(null);
  return {
    refreshing,
    onRefresh: () => {
      setPulled(view.result);
      projectWorkEnvironment.refreshProject(appAtomRegistry, scope.environmentId, scope.projectId);
    },
  };
}

/** The project's heading above its sections: checkout path, then the section tabs. */
function ProjectSectionTabs(props: {
  readonly section: WorkSection;
  readonly onSectionChange: (section: WorkSection) => void;
}) {
  const surface = use(ScreenScrollViewSurface) ?? "bg-screen";
  return (
    <View className={surface}>
      <HorizontalScroll
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 py-2"
        accessibilityRole="tablist"
      >
        {WORK_SECTIONS.map((entry) => (
          <Chip
            key={entry.value}
            label={entry.label}
            selected={props.section === entry.value}
            onPress={() => props.onSectionChange(entry.value)}
          />
        ))}
      </HorizontalScroll>
    </View>
  );
}

/** Work for one checkout, in web's sections. Hosts own navigation. */
export function WorkProjectContent(props: {
  readonly scope: ProjectWorkScope;
  readonly section: WorkSection;
  readonly onSectionChange: (section: WorkSection) => void;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { scope, section, onOpenTask } = props;
  const writer = useWorkWriter(scope.environmentId);
  const refresh = useProjectRefresh(scope);
  const bottom = useBottomInset();
  const refreshControl = (
    <RefreshControl
      refreshing={refresh.refreshing}
      onRefresh={refresh.onRefresh}
      tintColorClassName={String("accent-icon")}
    />
  );
  const path = (
    <Text
      selectable
      textRole="label"
      numberOfLines={1}
      ellipsizeMode="middle"
      className="px-2 text-foreground-tertiary"
    >
      {scope.checkoutPath}
    </Text>
  );
  const tabs = <ProjectSectionTabs section={section} onSectionChange={props.onSectionChange} />;
  // The task list is long, so it is its own virtualized scroller with the page as its header.
  if (section === "tasks")
    return (
      <WorkTaskList
        scope={scope}
        writer={writer}
        header={
          <View className="gap-2">
            {path}
            {tabs}
          </View>
        }
        refreshControl={refreshControl}
        bottomInset={bottom}
        onOpenTask={onOpenTask}
      />
    );
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: bottom }}
      keyboardShouldPersistTaps="handled"
      stickyHeaderIndices={[1]}
      refreshControl={refreshControl}
    >
      {path}
      {tabs}
      {section === "overview" ? (
        <WorkOverview
          scope={scope}
          writer={writer}
          onOpenTask={onOpenTask}
          onOpenTeam={() => props.onSectionChange("team")}
        />
      ) : section === "team" ? (
        <WorkTeamSection scope={scope} writer={writer} onOpenTask={onOpenTask} />
      ) : section === "knowledge" ? (
        <>
          <Knowledge scope={scope} writer={writer} onOpenTask={onOpenTask} />
          <Decisions scope={scope} writer={writer} />
        </>
      ) : (
        <Intake scope={scope} writer={writer} />
      )}
    </ScrollView>
  );
}

const projectSelection = (scope: ProjectWorkScope, revision: number): ProjectWorkSelection => ({
  ...scope,
  revision,
  taskRevision: 0,
});

function Knowledge({
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
    <View className="gap-3">
      <WorkReadNotice view={view} subject="knowledge" />
      {history.complete && history.status === "ready" ? null : (
        <WorkRecordsNotice set={history} subject="knowledge history" />
      )}
      <WorkHeading
        title="Knowledge"
        count={view.page === null ? null : entries.length}
        detail="Facts and conventions people confirmed for this project. Revising keeps the earlier version."
        trailing={
          editing === null ? (
            <Chip
              label="Add"
              icon="plus"
              accessibilityLabel={blocked ?? "Add knowledge"}
              disabled={blocked !== null}
              onPress={() => open("new")}
            />
          ) : undefined
        }
      />
      {editing !== null ? (
        <ListSection>
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
        </ListSection>
      ) : null}
      {view.page !== null && entries.length === 0 && editing === null ? (
        <ListSection>
          <WorkEmptyRow
            title={pager.offset === 0 ? "No knowledge yet" : "No more knowledge"}
            {...(pager.offset === 0
              ? { detail: "Add what agents should always know about this project." }
              : {})}
          />
        </ListSection>
      ) : null}
      {entries.map((entry) => {
        const replacement = lineage.supersededBy.get(entry.knowledgeId);
        const predecessor =
          entry.supersedesKnowledgeId === undefined
            ? null
            : (lineage.byId.get(entry.supersedesKnowledgeId) ?? null);
        const reason = reviseReason(entry);
        return (
          <KnowledgeCard
            key={entry.knowledgeId}
            scope={scope}
            entry={entry}
            status={history.complete ? (replacement ? "replaced" : "current") : null}
            replacementTitle={replacement?.title ?? null}
            predecessorTitle={
              entry.supersedesKnowledgeId === undefined
                ? null
                : (predecessor?.title ?? "an earlier entry")
            }
            reviseBlocked={reason}
            onRevise={replacement || editing !== null ? null : () => open(entry)}
            onOpenTask={onOpenTask}
          />
        );
      })}
      <WorkPager pager={pager} noun="Entries" />
    </View>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  manual: "Added by hand",
  task: "From a task",
  thread: "From a thread",
  session: "From a session",
  worktree: "From a worktree",
  attempt: "From an attempt",
};

function actorLabel(actor: ProjectWorkActorRead | undefined) {
  if (actor === undefined) return null;
  if (actor.displayName) return actor.displayName;
  return actor.kind === "human"
    ? "A person"
    : actor.kind === "agent"
      ? "An agent"
      : workStateLabel(actor.kind);
}

function KnowledgeCard(props: {
  readonly scope: ProjectWorkScope;
  readonly entry: ProjectWorkKnowledgeRead;
  readonly status: "current" | "replaced" | null;
  readonly replacementTitle: string | null;
  readonly predecessorTitle: string | null;
  readonly reviseBlocked: string | null;
  readonly onRevise: (() => void) | null;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { entry } = props;
  const [expanded, setExpanded] = useState(false);
  const replaced = props.status === "replaced";
  // Long entries clamp to an excerpt; the full text is one tap away.
  const long = entry.body.length > 280 || entry.body.split("\n").length > 4;
  const author = actorLabel(entry.attribution?.actor);
  return (
    <ListSection>
      <View className="gap-2.5 px-4 pt-4 pb-3">
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text
              selectable
              textRole="body"
              className={
                replaced ? "font-t3-bold text-foreground-muted" : "font-t3-bold text-foreground"
              }
            >
              {entry.title}
            </Text>
            <Text textRole="label" className="text-foreground-tertiary">
              {SOURCE_LABEL[entry.sourceKind] ??
                `From ${workStateLabel(entry.sourceKind).toLowerCase()}`}
            </Text>
          </View>
          {props.status === null ? null : (
            <WorkStatusChip
              state={replaced ? "superseded" : "accepted"}
              label={replaced ? "Replaced" : "Current"}
              icon={null}
            />
          )}
        </View>
        {entry.body ? (
          <View className="items-start gap-1">
            <Text
              selectable
              textRole="footnote"
              numberOfLines={long && !expanded ? 4 : undefined}
              className="text-foreground"
            >
              {entry.body}
            </Text>
            {long ? (
              <Chip
                size="small"
                label={expanded ? "Show less" : "Show more"}
                onPress={() => setExpanded(!expanded)}
              />
            ) : null}
          </View>
        ) : null}
        {props.replacementTitle !== null ? (
          <Text textRole="label" className="text-foreground-muted">
            Replaced by “{props.replacementTitle}”
          </Text>
        ) : null}
        {props.predecessorTitle !== null ? (
          <Text textRole="label" className="text-foreground-muted">
            Replaces “{props.predecessorTitle}”
          </Text>
        ) : null}
        <Text textRole="label" className="text-foreground-tertiary">
          {author ? `${author} · ` : ""}
          <RelativeTime timestamp={entry.updatedAt} />
        </Text>
      </View>
      {entry.sourceKind === "task" ? (
        <WorkTaskLink
          scope={props.scope}
          taskId={ProjectWorkTaskId.make(entry.sourceId)}
          prefix="From"
          onOpen={props.onOpenTask}
        />
      ) : null}
      {props.onRevise ? (
        <ListActionRow
          icon="pencil"
          label="Revise…"
          {...(props.reviseBlocked ? { description: props.reviseBlocked } : {})}
          disabled={props.reviseBlocked !== null}
          onPress={props.onRevise}
        />
      ) : null}
    </ListSection>
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
    <View className="gap-2">
      <WorkHeading
        title="Decisions"
        count={view.page === null ? null : decisions.length}
        detail="Proposed choices stay proposed until a person accepts or rejects them."
        trailing={
          form === null ? (
            <Chip
              label="Propose"
              icon="plus"
              accessibilityLabel={blocked ?? "Propose decision"}
              disabled={blocked !== null}
              onPress={() => open({ mode: "propose" })}
            />
          ) : undefined
        }
      />
      <WorkReadNotice view={view} subject="decisions" />
      <ListSection>
        {formFor(null)}
        {decisions.map((decision, index) => {
          const decisionForm = formFor(decision);
          const failure = decisionForm === null ? writer.failureFor(keyFor(decision)) : null;
          return (
            <View key={decision.decisionId}>
              {index > 0 || form?.mode === "propose" ? <WorkSeparator /> : null}
              <WorkBlock>
                <View className="flex-row items-start gap-2">
                  <Text
                    selectable
                    textRole="body"
                    className="min-w-0 flex-1 font-t3-medium text-foreground"
                  >
                    {decision.title}
                  </Text>
                  <WorkStatusChip state={decision.state} />
                </View>
                {decision.body ? <WorkText muted>{decision.body}</WorkText> : null}
                {decision.rejectionReason ? (
                  <WorkText muted>Rejected: {decision.rejectionReason}</WorkText>
                ) : null}
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
          <WorkEmptyRow
            title={pager.offset === 0 ? "No decisions recorded." : "No more decisions."}
          />
        ) : null}
        <WorkPager pager={pager} noun="Decisions" />
      </ListSection>
    </View>
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Issue bindings are fetched from the environment when the checkout changes.
  useEffect(() => {
    let live = true;
    void runAtomCommand(
      appAtomRegistry,
      projectWorkEnvironment.issue,
      {
        environmentId: scope.environmentId,
        input: { operation: "list", input: { projectId: scope.projectId } },
      },
      { reportFailure: false },
    ).then((result) => {
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
                  <View className="flex-row items-start gap-2">
                    <Text
                      selectable
                      textRole="body"
                      className="min-w-0 flex-1 font-t3-medium text-foreground"
                    >
                      {entry.repositoryName || entry.repositoryNodeId}
                    </Text>
                    <WorkStatusChip
                      state={entry.status}
                      tone={entry.status === "active" ? "success" : "outline"}
                    />
                  </View>
                  <WorkText muted>
                    {entry.host}
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
    <View className="gap-2">
      <WorkHeading title="Issues" count={view.page === null ? null : issues.length} />
      <WorkReadNotice view={view} subject="issues" />
      <ListSection>
        {view.page !== null && issues.length === 0 ? (
          <WorkEmptyRow
            title={pager.offset === 0 ? "No issues copied in" : "No more issues"}
            {...(pager.offset === 0
              ? { detail: "Sync a bound repository to bring its issues in." }
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
      </ListSection>
    </View>
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
        <View className="flex-row items-start gap-2">
          <Text selectable textRole="body" className="min-w-0 flex-1 text-foreground">
            <Text className="font-mono text-foreground-muted">#{issue.identity.number}</Text>{" "}
            {issue.title}
          </Text>
          <WorkStatusChip state={issue.status} />
        </View>
        <View className="flex-row flex-wrap items-center gap-1.5">
          <WorkText muted>{issue.repositoryName}</WorkText>
          {linked ? <WorkTagChip label="Refined" icon="checkmark" /> : null}
        </View>
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
