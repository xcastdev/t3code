import { useAtom } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  asProjectWorkTask,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  groupWorkTasks,
  taskApprovalBadge,
  taskMember,
  workTaskFilterOptions,
  type WorkTaskCounts,
  type WorkTaskFilter,
  type WorkTaskGroupId,
} from "@t3tools/client-runtime/project-work-team";
import { ProjectWorkTaskId, type ProjectWorkTaskRead } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo, useState, type ReactElement } from "react";
import { Platform, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import { uuidv4 } from "../../lib/uuid";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import {
  newCommandId,
  useWorkRead,
  WORK_PAGE_SIZE,
  workWriteBlockedReason,
  type WorkWriter,
} from "./useWork";
import { useWorkPage } from "./useWorkRecords";
import { useWorkTeamRoster, type WorkRosterMember } from "./useWorkTeamRoster";
import { workStateLabel } from "./workModel";
import { WorkFormActions, WorkInput, WorkPager, WorkReadNotice, WorkText } from "./WorkParts";
import { WorkEmptyRow, WorkMemberAvatar, WorkStatusChip, WorkStatusGlyph } from "./WorkStatus";

const DELIVERABLES = {
  code: "Code change",
  research: "Research",
  plan: "Plan",
  review: "Review",
  "non-code": "Other deliverable",
  reminder: "Reminder",
} as const;
type Deliverable = keyof typeof DELIVERABLES;

// Done starts folded, like web; the choice holds for the session across projects.
const collapsedGroupsAtom = Atom.make<ReadonlyArray<WorkTaskGroupId>>(["done"]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:work:collapsed-task-groups"),
);

const RADIUS = Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;

type Item =
  | {
      readonly kind: "group";
      readonly key: string;
      readonly id: WorkTaskGroupId;
      readonly label: string;
      readonly count: number;
      readonly collapsed: boolean;
      readonly last: boolean;
    }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly task: ProjectWorkTaskRead;
      readonly worker: WorkRosterMember | undefined;
      readonly last: boolean;
    };

/**
 * The project's tasks grouped by what they need from you, as one virtualized list. `header`
 * is the page above the list (project title and section tabs), scrolled with it.
 */
export function WorkTaskList(props: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly header: ReactElement;
  readonly refreshControl: ReactElement;
  readonly bottomInset: number;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { scope, writer } = props;
  const [filter, setFilter] = useState<WorkTaskFilter>("all");
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useAtom(collapsedGroupsAtom);
  const summaryView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "supervision",
  });
  const rawSummary =
    summaryView.special?.operation === "supervision" ? summaryView.special.value : null;
  const counts: WorkTaskCounts | null =
    summaryView.status === "ready" && rawSummary?.availability === "available"
      ? rawSummary.taskCounts
      : null;
  const pager = useWorkPage(
    scope.environmentId,
    {
      projectId: scope.projectId,
      operation: "tasks",
      ...(filter === "all" ? {} : { state: filter }),
    },
    WORK_PAGE_SIZE,
  );
  const view = pager.view;
  const { roster } = useWorkTeamRoster(scope);
  const createBlocked = workWriteBlockedReason(view, writer.canWrite);
  const tasks = (view.page?.items ?? []).flatMap((item): ProjectWorkTaskRead[] => {
    const task = asProjectWorkTask(item.value);
    return task === null || task.projectId !== scope.projectId ? [] : [task];
  });
  const unknown = (view.page?.items.length ?? 0) - tasks.length;
  const groups = groupWorkTasks(tasks, counts, filter).filter((group) => !group.empty);
  const items: Item[] = groups.flatMap((group): Item[] => {
    const folded = collapsed.includes(group.id);
    const shown = folded ? [] : group.tasks;
    return [
      {
        kind: "group",
        key: `group:${group.id}`,
        id: group.id,
        label: group.label,
        count: group.count,
        collapsed: folded,
        last: shown.length === 0,
      },
      ...shown.map((task, index): Item => ({
        kind: "task",
        key: task.taskId,
        task,
        worker: taskMember(roster, task),
        last: index === shown.length - 1,
      })),
    ];
  });
  const toggle = (id: WorkTaskGroupId) =>
    setCollapsed(
      collapsed.includes(id) ? collapsed.filter((entry) => entry !== id) : [...collapsed, id],
    );
  const total = filter === "all" ? counts?.total : counts?.[filter];
  const changeFilter = (next: WorkTaskFilter) => {
    setFilter(next);
    pager.reset();
  };

  const listHeader = (
    <View className="gap-4 pb-3">
      {props.header}
      <View className="flex-row items-center gap-2 px-2">
        <Text
          textRole="footnote"
          numberOfLines={1}
          className="min-w-0 flex-1 font-t3-medium text-foreground-muted"
        >
          {filter === "all" ? "Tasks" : `${workStateLabel(filter)} tasks`}
          {total === undefined ? "" : `  ${total}`}
        </Text>
        <ListFilterMenu
          label={filter === "all" ? "All" : workStateLabel(filter)}
          accessibilityLabel="Filter tasks"
          active={filter !== "all"}
          icon={filter === "all"}
          actions={workTaskFilterOptions(counts, filter).map((option) => ({
            id: option.state,
            title: option.label,
            ...(option.count === undefined ? {} : { subtitle: String(option.count) }),
            state: option.state === filter ? ("on" as const) : ("off" as const),
          }))}
          onSelect={(id) => {
            const option = workTaskFilterOptions(counts, filter).find(
              (entry) => entry.state === id,
            );
            if (option) changeFilter(option.state);
          }}
        />
        <Chip
          label="New"
          icon="plus"
          accessibilityLabel={createBlocked ?? "New task"}
          disabled={creating || createBlocked !== null}
          onPress={() => setCreating(true)}
        />
      </View>
      {creating && view.page ? (
        <ListSection>
          <NewTaskForm
            scope={scope}
            writer={writer}
            selection={{ ...scope, revision: view.page.revision, taskRevision: 0 }}
            blocked={createBlocked}
            onCancel={() => setCreating(false)}
            onCreated={(taskId) => {
              setCreating(false);
              props.onOpenTask(taskId);
            }}
          />
        </ListSection>
      ) : null}
      <WorkReadNotice view={view} subject="tasks" />
      {view.page !== null && view.page.items.length === 0 ? (
        <ListSection>
          <WorkEmptyRow
            title={
              filter === "all" ? "No tasks yet" : `No ${workStateLabel(filter).toLowerCase()} tasks`
            }
            detail={
              filter === "all"
                ? "Start with a title. Scope, plan and approvals come next."
                : "Try another status to find work."
            }
          />
          {filter !== "all" ? (
            <View className="items-center pb-4">
              <Button
                label="Show all tasks"
                tone="text"
                size="compact"
                onPress={() => changeFilter("all")}
              />
            </View>
          ) : null}
        </ListSection>
      ) : null}
    </View>
  );

  return (
    <LegendList
      renderScrollComponent={NativeScrollView}
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: props.bottomInset,
      }}
      data={items}
      estimatedItemSize={64}
      getItemType={(item) => item.kind}
      keyExtractor={(item) => item.key}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={listHeader}
      ListFooterComponent={
        <View className="gap-2 pt-3">
          {unknown > 0 ? (
            <WorkText muted>{unknown} records from a newer server can't be shown here.</WorkText>
          ) : null}
          <WorkPager pager={pager} noun="Tasks" />
        </View>
      }
      refreshControl={props.refreshControl}
      renderItem={({ item }) =>
        item.kind === "group" ? (
          <GroupHeader item={item} onToggle={toggle} />
        ) : (
          <TaskRow item={item} onOpenTask={props.onOpenTask} />
        )
      }
    />
  );
}

const GROUP_STATE: Record<WorkTaskGroupId, string> = {
  "needs-you": "in-review",
  running: "in-progress",
  "up-next": "ready",
  done: "completed",
};

const GroupHeader = memo(function GroupHeader(props: {
  readonly item: Extract<Item, { kind: "group" }>;
  readonly onToggle: (id: WorkTaskGroupId) => void;
}) {
  const { item } = props;
  return (
    // Each group is a card: its header opens it, its last row closes it.
    <View className="pt-3">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${item.label}, ${item.count}`}
        accessibilityState={{ expanded: !item.collapsed }}
        onPress={() => props.onToggle(item.id)}
        className="bg-grouped-card"
        style={{
          borderTopLeftRadius: RADIUS,
          borderTopRightRadius: RADIUS,
          ...(item.last ? { borderBottomLeftRadius: RADIUS, borderBottomRightRadius: RADIUS } : {}),
        }}
      >
        <View className="flex-row items-center gap-2 px-4 py-3">
          <WorkStatusGlyph state={GROUP_STATE[item.id]} size={14} />
          <Text
            textRole="footnote"
            className={
              item.id === "needs-you"
                ? "flex-1 font-t3-bold text-foreground"
                : "flex-1 font-t3-medium text-foreground-muted"
            }
          >
            {item.label}
          </Text>
          <View className="rounded-full bg-subtle px-2 py-0.5">
            <Text
              textRole="label"
              className="text-foreground-muted"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {item.count}
            </Text>
          </View>
          <SymbolView
            name={item.collapsed ? "chevron.right" : "chevron.down"}
            size={12}
            tintColorClassName="accent-chevron"
          />
        </View>
      </RowPressable>
    </View>
  );
});

const TaskRow = memo(function TaskRow(props: {
  readonly item: Extract<Item, { kind: "task" }>;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}) {
  const { task, worker, last } = props.item;
  const name = worker?.name ?? task.assignee?.displayName;
  const approval = taskApprovalBadge(task);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}, ${workStateLabel(task.state)}${name ? `, ${name}` : ""}`}
      onPress={() => props.onOpenTask(task.taskId)}
      className="bg-grouped-card"
      style={last ? { borderBottomLeftRadius: RADIUS, borderBottomRightRadius: RADIUS } : undefined}
    >
      <View className="ms-4 h-px bg-separator" />
      <View className="flex-row items-start gap-3 px-4 py-3">
        <View className="pt-0.5">
          <WorkStatusGlyph state={task.state} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text textRole="body" numberOfLines={2} className="font-t3-medium text-foreground">
            {task.title}
          </Text>
          <Text textRole="label" numberOfLines={1} className="text-foreground-muted">
            {workStateLabel(task.state)}
            {name ? ` · ${name}` : ""}
            {" · "}
            <RelativeTime timestamp={task.updatedAt} />
          </Text>
          {task.failureKind || approval ? (
            <View className="flex-row flex-wrap gap-1.5">
              {task.failureKind ? (
                <WorkStatusChip
                  state="failed"
                  icon="exclamationmark.circle"
                  label={workStateLabel(task.failureKind)}
                />
              ) : null}
              {approval === "approved" ? (
                <WorkStatusChip state="approved" icon="checkmark.circle" label="Approved" />
              ) : approval === "needs-approval" ? (
                <WorkStatusChip
                  state="pending"
                  tone="warning"
                  icon="exclamationmark.shield"
                  label="Needs approval"
                />
              ) : null}
            </View>
          ) : null}
        </View>
        {worker ? (
          <WorkMemberAvatar
            role={worker.role}
            name={worker.name}
            avatar={worker.avatar}
            size={24}
          />
        ) : null}
      </View>
    </RowPressable>
  );
});

function NewTaskForm(props: {
  readonly scope: ProjectWorkScope;
  readonly writer: WorkWriter;
  readonly selection: ProjectWorkSelection;
  readonly blocked: string | null;
  readonly onCancel: () => void;
  readonly onCreated: (taskId: ProjectWorkTaskId) => void;
}) {
  const { writer, selection } = props;
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [mode, setMode] = useState<"guided" | "simple">("guided");
  const [deliverable, setDeliverable] = useState<Deliverable>("code");
  const key = "task:create";
  const submit = async () => {
    const taskId = ProjectWorkTaskId.make(uuidv4());
    // A new task depends on nothing the user reviewed, so it binds to the current list revision.
    const sent = await writer.submit(key, selection, selection, {
      type: "project-work.task.create",
      commandId: newCommandId(),
      projectId: props.scope.projectId,
      expectedRevision: selection.revision,
      taskId,
      title: title.trim(),
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(mode === "guided" ? { deliverableKind: deliverable } : {}),
      createdAt: new Date().toISOString(),
    });
    if (sent) props.onCreated(taskId);
  };
  return (
    <View className="gap-3 px-4 py-3">
      <WorkInput label="Title" value={title} onChange={setTitle} />
      <WorkInput
        label="Summary (optional)"
        value={summary}
        onChange={setSummary}
        multiline
        maxLength={32000}
      />
      <SegmentedControl
        size="compact"
        options={[
          { value: "guided", label: "Guided" },
          { value: "simple", label: "Simple" },
        ]}
        selected={mode}
        onSelect={setMode}
      />
      {mode === "guided" ? (
        <View className="flex-row flex-wrap gap-2">
          {(Object.keys(DELIVERABLES) as Deliverable[]).map((value) => (
            <Chip
              key={value}
              label={DELIVERABLES[value]}
              selected={deliverable === value}
              onPress={() => setDeliverable(value)}
            />
          ))}
        </View>
      ) : null}
      <WorkText muted>
        {mode === "guided"
          ? "Guided tasks record scope and plan approvals. Approving never starts work."
          : "Simple tasks keep a scope, criteria and one approval, without a plan."}
      </WorkText>
      <WorkFormActions
        submitLabel="Create task"
        pending={writer.pendingKey === key}
        disabled={title.trim() === "" || props.blocked !== null || writer.pendingKey !== null}
        failure={writer.failureFor(key)}
        onSubmit={() => void submit()}
        onCancel={props.onCancel}
      />
    </View>
  );
}
