import { asProjectWorkTask, type ProjectWorkScope } from "@t3tools/client-runtime/project-work";
import type { ProjectWorkTaskId, ProjectWorkTaskRead } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { Notice } from "../../components/ui/Notice";
import { useEnvironments } from "../../state/environments";
import { useWorkRead, workReadMessage, type WorkReadView } from "./useWork";
import { useWorkPage, type WorkPageView, type WorkRecordsView } from "./useWorkRecords";
import { workStateLabel } from "./workModel";

export function WorkInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly numeric?: boolean;
}) {
  return (
    <View className="gap-1.5">
      <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
        {props.label}
      </Text>
      <AppTextInput
        accessibilityLabel={props.label}
        className="min-h-11 rounded-xl border-continuous bg-card px-3 py-2.5 text-base text-foreground"
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        maxLength={props.maxLength ?? 4000}
        textAlignVertical={props.multiline ? "top" : "center"}
        {...(props.numeric ? { keyboardType: "number-pad" as const } : {})}
      />
    </View>
  );
}

/** A padded block inside a list section for text, forms and inline confirmations. */
export function WorkBlock(props: { readonly children: ReactNode }) {
  return <View className="gap-3 px-4 py-3">{props.children}</View>;
}

export function WorkText(props: { readonly children: ReactNode; readonly muted?: boolean }) {
  return (
    <Text
      selectable
      textRole={props.muted ? "footnote" : "body"}
      className={props.muted ? "text-foreground-muted" : "text-foreground"}
    >
      {props.children}
    </Text>
  );
}

export function WorkFormActions(props: {
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly failure: string | null;
  readonly changed?: boolean;
  readonly onReview?: () => void;
}) {
  return (
    <View className="gap-2">
      {props.changed && props.onReview ? (
        <View className="gap-2">
          <Notice
            icon="info.circle"
            message="This changed while you were reviewing it. Your text is kept; check the current revision before sending."
          />
          <Button label="Review current revision" tone="secondary" onPress={props.onReview} />
        </View>
      ) : null}
      {props.failure ? <Notice tone="danger" message={props.failure} /> : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={props.submitLabel}
          loading={props.pending}
          disabled={props.disabled || props.changed === true}
          onPress={props.onSubmit}
        />
        <Button label="Cancel" tone="text" disabled={props.pending} onPress={props.onCancel} />
      </View>
    </View>
  );
}

/** The truthful state of one read, with Retry when it failed. */
export function WorkReadNotice({ view, subject }: { view: WorkReadView; subject: string }) {
  const message = workReadMessage(view, subject);
  if (message === null) return null;
  return (
    <View className="gap-2">
      <Notice
        icon="info.circle"
        {...(view.error !== null ? { tone: "danger" as const } : {})}
        message={message}
      />
      {view.error !== null ? (
        <View className="flex-row">
          <Button label="Retry" tone="secondary" onPress={view.retry} />
        </View>
      ) : null}
    </View>
  );
}

export function workRecordsMessage(set: WorkRecordsView, subject: string): string | null {
  if (set.status === "disconnected")
    return set.complete
      ? `Disconnected. Showing the last loaded ${subject}; changes are off.`
      : `Reconnect this environment to load ${subject}.`;
  if (set.truncated)
    return `There are more ${subject} than Work can check at once. Nothing is inferred from a partial list, so changes that depend on them stay off.`;
  if (set.failed) return `Couldn't load all ${subject}.`;
  if (!set.complete) return `Loading ${subject}…`;
  if (set.status !== "ready") return `Checking for newer ${subject}.`;
  return null;
}

/** State of a complete record set, with Retry when a page failed. */
export function WorkRecordsNotice({ set, subject }: { set: WorkRecordsView; subject: string }) {
  const message = workRecordsMessage(set, subject);
  if (message === null) return null;
  return (
    <View className="gap-2">
      <Notice
        icon="info.circle"
        {...(set.failed ? { tone: "danger" as const } : {})}
        message={message}
      />
      {set.failed ? (
        <View className="flex-row">
          <Button label="Retry" tone="secondary" onPress={set.retry} />
        </View>
      ) : null}
    </View>
  );
}

/** Position and Previous/Next for one bounded window of a collection. */
export function WorkPager({
  pager,
  noun,
}: {
  pager: Pick<WorkPageView, "window" | "next" | "previous">;
  noun: string;
}) {
  const { window } = pager;
  if (window.previousOffset === null && window.nextOffset === null) return null;
  return (
    <View className="flex-row items-center justify-between gap-2 px-4 py-2">
      <Text textRole="footnote" className="text-foreground-muted">
        {window.to < window.from
          ? `No more ${noun.toLowerCase()}`
          : `${noun} ${window.from}–${window.to}`}
      </Text>
      <View className="flex-row gap-2">
        <Button
          label="Previous"
          tone="text"
          disabled={window.previousOffset === null}
          onPress={pager.previous}
        />
        <Button
          label="Next"
          tone="text"
          disabled={window.nextOffset === null}
          onPress={pager.next}
        />
      </View>
    </View>
  );
}

/** Which environment and checkout a Work view acts on; two checkouts can share a title. */
export function useWorkScopeLabel(scope: ProjectWorkScope): string {
  const { environments } = useEnvironments();
  const environment = environments.find((entry) => entry.environmentId === scope.environmentId);
  return `${environment?.label ?? "Environment"} · ${scope.checkoutPath}`;
}

export function WorkScopeLabel({ scope }: { scope: ProjectWorkScope }) {
  const label = useWorkScopeLabel(scope);
  return (
    <Text selectable textRole="footnote" className="text-foreground-muted">
      {label}
    </Text>
  );
}

/** A task named by ID elsewhere (relationship, dependency, mission), opened in this project. */
export function WorkTaskLink(props: {
  readonly scope: ProjectWorkScope;
  readonly taskId: ProjectWorkTaskId;
  readonly prefix?: string;
  readonly onOpen: (taskId: ProjectWorkTaskId) => void;
}) {
  const view = useWorkRead(props.scope.environmentId, {
    projectId: props.scope.projectId,
    operation: "task",
    taskId: props.taskId,
  });
  const task = asProjectWorkTask(view.value);
  const known = task !== null && task.taskId === props.taskId;
  const title = known
    ? task.title
    : view.status === "loading"
      ? "Loading task…"
      : view.error
        ? "Task unavailable"
        : `Task ${props.taskId.slice(0, 8)}`;
  return (
    <ListRow
      label={props.prefix ? `${props.prefix}: ${title}` : title}
      {...(known ? { description: workStateLabel(task.state) } : {})}
      onPress={() => props.onOpen(props.taskId)}
    />
  );
}

/** Bounded, pageable task choice for links, dependencies and intake targets. */
export function WorkTaskPicker(props: {
  readonly scope: ProjectWorkScope;
  readonly selectedTaskId: ProjectWorkTaskId | null;
  readonly excludeTaskIds?: ReadonlyArray<ProjectWorkTaskId>;
  readonly onSelect: (task: ProjectWorkTaskRead) => void;
}) {
  const pager = useWorkPage(
    props.scope.environmentId,
    { projectId: props.scope.projectId, operation: "tasks" },
    16,
  );
  const tasks = (pager.view.page?.items ?? []).flatMap((item): ProjectWorkTaskRead[] => {
    const task = asProjectWorkTask(item.value);
    return task === null || task.projectId !== props.scope.projectId ? [] : [task];
  });
  return (
    <View>
      <WorkReadNotice view={pager.view} subject="tasks" />
      {tasks.map((task) => (
        <ListChoiceRow
          key={task.taskId}
          label={task.title}
          description={`${workStateLabel(task.state)} · r${task.revision}`}
          selected={task.taskId === props.selectedTaskId}
          disabled={props.excludeTaskIds?.includes(task.taskId) ?? false}
          onPress={() => props.onSelect(task)}
        />
      ))}
      {pager.view.page !== null && tasks.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No tasks here.</WorkText>
        </WorkBlock>
      ) : null}
      <WorkPager pager={pager} noun="Tasks" />
    </View>
  );
}
