import {
  assistantSelectionIsCurrent,
  prepareAssistantRoutineMutation,
  type AssistantRoutineMutationIntent,
  type AssistantRoutineRecord,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import type { AssistantRoutineReadResult, ScheduledTaskId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { WorkBlock, WorkFormActions, WorkText } from "../work/WorkParts";
import {
  ROUTINE_TRIGGER_LABELS,
  routineDraftError,
  routineDraftFrom,
  routineDraftSchedule,
  routineFireStatus,
  routineTimingLabel,
  type RoutineDraft,
} from "@t3tools/client-runtime/assistant-presentation";
import { AgentInput, TONE_PREFIX } from "./AssistantParts";
import { agentBlockedReason, type MobileAgentContext } from "./AssistantScreens";
import { newAssistantCommandId, useCursorPages, useMountedRef } from "./useAssistants";

const PAGE = 32;
const WEEKDAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
] as const;

type WebhookHandoff = Extract<AssistantRoutineReadResult, { operation: "webhook" }>;

interface Editing {
  /** The agent and connection the form was opened on; a change to either blocks Save. */
  readonly selected: AssistantSelection;
  readonly reviewed: AssistantRoutineRecord | null;
  readonly draft: RoutineDraft;
  /** A new routine started only by its webhook URL. */
  readonly webhook: boolean;
  readonly commandId: ReturnType<typeof newAssistantCommandId>;
}

/** Title and message checks for a new webhook routine, which has no schedule to validate. */
function webhookDraftError(draft: RoutineDraft): string | null {
  return routineDraftError({ ...draft, mode: "interval", intervalMinutes: "60" }, null);
}

export function AgentRoutinesSection({ context }: { readonly context: MobileAgentContext }) {
  const { environmentId, detail, writer } = context;
  const scope = { environmentId, assistantId: detail.summary.assistantId };
  const pages = useCursorPages();
  const query = useEnvironmentQuery(
    assistantsEnvironment.routines({
      environmentId,
      input: {
        ...scope,
        operation: "list",
        limit: PAGE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    }),
  );
  const list =
    query.data?.operation === "list"
      ? (query.data as Extract<AssistantRoutineReadResult, { operation: "list" }>)
      : null;
  const routines = (list?.routines ?? []).filter((routine) => !routine.deleted);
  const latest = useRef(routines);
  useEffect(() => {
    latest.current = routines;
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [handoff, setHandoff] = useState<WebhookHandoff | null>(null);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const mounted = useMountedRef();
  const blocked = agentBlockedReason(context, writer.permissions.routines);
  const next = list?.nextCursor ?? null;

  const submit = (
    key: string,
    selected: AssistantSelection,
    intent: AssistantRoutineMutationIntent,
    reviewed?: AssistantRoutineRecord,
  ) => {
    const current = context.latestSelection();
    const currentRoutine =
      reviewed === undefined
        ? undefined
        : latest.current.find((routine) => routine.taskId === reviewed.taskId);
    return writer.run(
      key,
      assistantsEnvironment.routineWrite,
      current === null
        ? null
        : prepareAssistantRoutineMutation({
            selected,
            current,
            intent,
            ...(reviewed === undefined ? {} : { reviewedRoutine: reviewed }),
            ...(currentRoutine === undefined ? {} : { currentRoutine }),
          }),
    );
  };

  /** The URL is read once, on explicit intent, and only ever held on this screen. */
  const revealWebhook = async (taskId: ScheduledTaskId) => {
    setHandoff(null);
    setHandoffFailed(false);
    const result = await writer.run(`webhook:${taskId}`, assistantsEnvironment.routineWebhook, {
      ...scope,
      operation: "webhook",
      taskId,
    });
    if (!mounted.current) return;
    if (result?.operation === "webhook") setHandoff(result);
    else setHandoffFailed(true);
  };

  const open = (reviewed: AssistantRoutineRecord | null) => {
    if (context.selection === null) return;
    setEditing({
      selected: context.selection,
      reviewed,
      draft: routineDraftFrom(reviewed),
      webhook: false,
      commandId: newAssistantCommandId(),
    });
  };

  if (editing !== null) {
    const current =
      editing.reviewed === null
        ? null
        : (routines.find((routine) => routine.taskId === editing.reviewed?.taskId) ?? null);
    return (
      <RoutineEditor
        context={context}
        editing={editing}
        current={current}
        onChange={setEditing}
        onCancel={() => setEditing(null)}
        onDiscard={() => {
          if (editing.reviewed === null) return open(null);
          if (current === null) setEditing(null);
          else open(current);
        }}
        onSave={async (intent) => {
          const result = await submit(
            `routine:${editing.reviewed?.taskId ?? "new"}`,
            editing.selected,
            intent,
            editing.reviewed ?? undefined,
          );
          if (result === null || !mounted.current) return;
          setEditing(null);
          if (editing.webhook) void revealWebhook(result.taskId);
        }}
      />
    );
  }

  return (
    <>
      {handoff !== null || handoffFailed ? (
        <WebhookHandoffSection
          handoff={handoff}
          failed={handoffFailed}
          onDismiss={() => {
            setHandoff(null);
            setHandoffFailed(false);
          }}
        />
      ) : null}
      <ListSection
        title="Routines"
        footer="Routines message this agent's chat on the server's clock, or when their webhook URL is called, and keep running while every client is closed. New routines start paused."
      >
        {list === null ? (
          <WorkBlock>
            <WorkText muted>
              {query.error ? "Routines aren't available." : "Loading routines…"}
            </WorkText>
          </WorkBlock>
        ) : routines.length === 0 ? (
          <WorkBlock>
            <WorkText muted>No routines.</WorkText>
          </WorkBlock>
        ) : (
          routines.map((routine) => (
            <RoutineItem
              key={routine.taskId}
              context={context}
              routine={routine}
              blocked={blocked}
              onEdit={() => open(routine)}
              onAction={(key, selected, intent) => submit(key, selected, intent, routine)}
              onRevealWebhook={() => void revealWebhook(routine.taskId)}
            />
          ))
        )}
        {pages.hasPrevious ? <ListActionRow label="Previous" onPress={pages.previous} /> : null}
        {next !== null ? <ListActionRow label="Next" onPress={() => pages.next(next)} /> : null}
        <ListActionRow
          icon="plus"
          label="New routine"
          disabled={blocked !== null}
          onPress={() => open(null)}
        />
      </ListSection>
    </>
  );
}

function WebhookHandoffSection(props: {
  readonly handoff: WebhookHandoff | null;
  readonly failed: boolean;
  readonly onDismiss: () => void;
}) {
  const url = props.handoff?.url ?? null;
  const [copied, setCopied] = useState(false);
  return (
    <ListSection title="Webhook URL">
      <WorkBlock>
        <WorkText muted>
          {props.failed
            ? "The webhook URL couldn't be read. Revealing it needs permission to operate this environment."
            : url !== null
              ? "Anyone with this URL can start this routine. It isn't shown again; reveal it from the routine when you need it."
              : "This environment has no public URL yet. Turn on remote access (T3 Connect) for it, then reveal the URL from the routine."}
        </WorkText>
        {url !== null ? <WorkText>{url}</WorkText> : null}
      </WorkBlock>
      {url !== null ? (
        <ListActionRow
          icon="doc.on.doc"
          label={copied ? "Copied" : "Copy URL"}
          onPress={() =>
            void Clipboard.setStringAsync(url).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        />
      ) : null}
      <ListActionRow label="Done" onPress={props.onDismiss} />
    </ListSection>
  );
}

function RoutineItem(props: {
  readonly context: MobileAgentContext;
  readonly routine: AssistantRoutineRecord;
  readonly blocked: string | null;
  readonly onEdit: () => void;
  readonly onAction: (
    key: string,
    selected: AssistantSelection,
    intent: AssistantRoutineMutationIntent,
  ) => Promise<unknown>;
  readonly onRevealWebhook: () => void;
}) {
  const { context, routine } = props;
  const { writer, detail, environmentId } = context;
  const target = { environmentId, assistantId: detail.summary.assistantId, taskId: routine.taskId };
  const key = `routine:${routine.taskId}`;
  const timing = routineTimingLabel(routine);
  const [showFires, setShowFires] = useState(false);
  // A retried Run now is the same run request; a new one gets a new ID after it settles.
  const [runCommandId, setRunCommandId] = useState(newAssistantCommandId);
  const disabled = props.blocked !== null || writer.pendingKey !== null;
  const isWebhook = routine.schedule?.type === "webhook";
  const failure = writer.failureFor(key) ?? writer.failureFor(`webhook:${routine.taskId}`);

  /** The selection is taken at the press, so a change during the dialog is refused. */
  const act = (
    intent: AssistantRoutineMutationIntent,
    then?: (result: unknown) => void,
    confirm?: { readonly title: string; readonly message: string; readonly destructive: boolean },
  ) => {
    const selected = context.selection;
    if (selected === null) return;
    const run = () => void props.onAction(key, selected, intent).then((result) => then?.(result));
    if (confirm === undefined) return run();
    Dialog.confirm({
      title: confirm.title,
      message: confirm.message,
      confirmText: confirm.title,
      destructive: confirm.destructive,
      onConfirm: run,
    });
  };

  return (
    <>
      <WorkBlock>
        <WorkText>{`${routine.title}${routine.enabled ? "" : " · paused"}`}</WorkText>
        <WorkText muted>{timing.schedule}</WorkText>
        <WorkText muted>
          {`${
            timing.next !== null
              ? `Next ${new Date(timing.next).toLocaleString()} · `
              : timing.nextNote !== null
                ? `${timing.nextNote} · `
                : ""
          }saved with configuration r${routine.configurationRevision}`}
        </WorkText>
        {failure ? <Notice tone="danger" message={failure} /> : null}
        {detail.summary.lifecycle !== "active" ? (
          <WorkText muted>This agent isn't active, so routines don't start runs.</WorkText>
        ) : null}
      </WorkBlock>
      <ListActionRow
        icon="play"
        label="Run now"
        disabled={disabled || detail.summary.lifecycle !== "active"}
        onPress={() =>
          act({ ...target, operation: "run-now", commandId: runCommandId }, (result) => {
            if (result !== null) setRunCommandId(newAssistantCommandId());
          })
        }
      />
      <ListActionRow
        label={routine.enabled ? "Pause" : "Turn on"}
        disabled={disabled}
        onPress={() => act({ ...target, operation: "set-enabled", enabled: !routine.enabled })}
      />
      <ListActionRow icon="pencil" label="Edit" disabled={disabled} onPress={props.onEdit} />
      {isWebhook ? (
        <>
          <ListActionRow
            label="Show webhook URL"
            disabled={disabled || !writer.permissions.webhook}
            onPress={props.onRevealWebhook}
          />
          <ListActionRow
            label="Rotate webhook URL"
            disabled={disabled}
            onPress={() =>
              act(
                { ...target, operation: "rotate-webhook-token" },
                (result) => {
                  if (result !== null) props.onRevealWebhook();
                },
                {
                  title: "Rotate",
                  message:
                    "Senders using the old URL stop working. The new URL is shown once afterwards.",
                  destructive: false,
                },
              )
            }
          />
        </>
      ) : null}
      <ListActionRow
        icon="trash"
        label="Delete"
        tone="danger"
        disabled={disabled}
        onPress={() =>
          act({ ...target, operation: "delete" }, undefined, {
            title: "Delete",
            message: "Runs it already started stay in the agent's chat.",
            destructive: true,
          })
        }
      />
      <ListActionRow
        label={showFires ? "Hide history" : "History"}
        onPress={() => setShowFires(!showFires)}
      />
      {showFires ? <RoutineFires context={context} routine={routine} /> : null}
    </>
  );
}

function RoutineFires(props: {
  readonly context: MobileAgentContext;
  readonly routine: AssistantRoutineRecord;
}) {
  const { environmentId, detail } = props.context;
  const pages = useCursorPages();
  const query = useEnvironmentQuery(
    assistantsEnvironment.routines({
      environmentId,
      input: {
        environmentId,
        assistantId: detail.summary.assistantId,
        operation: "fires",
        taskId: props.routine.taskId,
        limit: PAGE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    }),
  );
  const result = query.data?.operation === "fires" ? query.data : null;
  const fires = result?.fires ?? null;
  const next = result?.nextCursor ?? null;
  return (
    <>
      <WorkBlock>
        {fires === null ? (
          <WorkText muted>{query.error ? "History isn't available." : "Loading history…"}</WorkText>
        ) : fires.length === 0 ? (
          <WorkText muted>This routine hasn't fired yet.</WorkText>
        ) : (
          fires.map((fire) => {
            const status = routineFireStatus(fire);
            return (
              <WorkText key={fire.fireKey} muted>
                {`${TONE_PREFIX[status.tone]}${status.label} · ${ROUTINE_TRIGGER_LABELS[fire.trigger]} · ${new Date(fire.startedAt).toLocaleString()} · r${fire.configurationRevision}${fire.admittedConfigurationRevision === null ? ", not admitted" : `, admitted r${fire.admittedConfigurationRevision}`}`}
              </WorkText>
            );
          })
        )}
      </WorkBlock>
      {pages.hasPrevious ? <ListActionRow label="Newer fires" onPress={pages.previous} /> : null}
      {next !== null ? (
        <ListActionRow label="Older fires" onPress={() => pages.next(next)} />
      ) : null}
    </>
  );
}

type TriggerChoice = "fixed" | "interval" | "keep" | "webhook";

function RoutineEditor(props: {
  readonly context: MobileAgentContext;
  readonly editing: Editing;
  readonly current: AssistantRoutineRecord | null;
  readonly onChange: (editing: Editing) => void;
  readonly onCancel: () => void;
  readonly onDiscard: () => void;
  readonly onSave: (intent: AssistantRoutineMutationIntent) => Promise<void>;
}) {
  const { context, editing, current } = props;
  const { draft, reviewed } = editing;
  const existing = reviewed?.schedule ?? null;
  const error = editing.webhook ? webhookDraftError(draft) : routineDraftError(draft, existing);
  const live = context.selection;
  const selectionChanged = live === null || !assistantSelectionIsCurrent(editing.selected, live);
  const routineChanged =
    reviewed !== null && (current === null || JSON.stringify(current) !== JSON.stringify(reviewed));
  const stale = selectionChanged || routineChanged;
  const pendingKey = `routine:${reviewed?.taskId ?? "new"}`;
  const pending = context.writer.pendingKey === pendingKey;
  const set = (patch: Partial<RoutineDraft>) => {
    if (!pending) props.onChange({ ...editing, draft: { ...draft, ...patch } });
  };
  const modes: ReadonlyArray<{ value: TriggerChoice; label: string }> = [
    { value: "fixed", label: "At a time" },
    { value: "interval", label: "Every…" },
    ...(reviewed === null ? [{ value: "webhook" as const, label: "Webhook" }] : []),
    ...(existing?.type === "webhook" ? [{ value: "keep" as const, label: "Webhook" }] : []),
  ];
  return (
    <>
      {stale ? (
        <>
          <Notice
            icon="info.circle"
            message={
              live === null
                ? "Offline. Your edits are kept; reconnect, then review the current version."
                : routineChanged
                  ? "This routine changed after you started editing. Your edits are kept; discard them to edit the current version."
                  : "The agent or the connection changed after you started editing. Your edits are kept; discard them to start again from the current version."
            }
          />
          <ListSection>
            <ListActionRow
              label="Discard edits"
              disabled={pending || live === null}
              onPress={props.onDiscard}
            />
          </ListSection>
        </>
      ) : null}
      <ListSection title={reviewed === null ? "New routine" : "Edit routine"}>
        <WorkBlock>
          <AgentInput
            label="Title"
            value={draft.title}
            maxLength={200}
            disabled={pending}
            onChange={(title) => set({ title })}
          />
          <AgentInput
            label="Message"
            multiline
            maxLength={65536}
            disabled={pending}
            value={draft.prompt}
            onChange={(prompt) => set({ prompt })}
          />
          <SegmentedControl
            options={modes}
            selected={editing.webhook ? "webhook" : draft.mode}
            onSelect={(mode) => {
              if (pending) return;
              if (mode === "webhook") props.onChange({ ...editing, webhook: true });
              else props.onChange({ ...editing, webhook: false, draft: { ...draft, mode } });
            }}
            size="compact"
          />
          {editing.webhook ? (
            <WorkText muted>
              Runs when its private URL is called. The URL is shown once after saving and can be
              rotated later.
            </WorkText>
          ) : draft.mode === "interval" ? (
            <AgentInput
              label="Every (minutes)"
              numeric
              disabled={pending}
              value={draft.intervalMinutes}
              onChange={(intervalMinutes) => set({ intervalMinutes })}
            />
          ) : draft.mode === "fixed" ? (
            <AgentInput
              label={`Time (HH:MM, server time${current ? ` ${current.timeZone}` : ""})`}
              value={draft.timeOfDay}
              maxLength={5}
              disabled={pending}
              onChange={(timeOfDay) => set({ timeOfDay })}
            />
          ) : (
            <WorkText muted>Keeps the webhook URL, signature and filters as they are.</WorkText>
          )}
        </WorkBlock>
        {!editing.webhook && draft.mode === "fixed"
          ? WEEKDAYS.map(([day, label]) => (
              <ListChoiceRow
                key={day}
                label={label}
                selected={draft.weekdays.includes(day)}
                disabled={pending}
                onPress={() =>
                  set({
                    weekdays: draft.weekdays.includes(day)
                      ? draft.weekdays.filter((value) => value !== day)
                      : [...draft.weekdays, day],
                  })
                }
              />
            ))
          : null}
        <ListToggleRow
          label="Turn on after saving"
          value={draft.enabled}
          disabled={pending}
          onValueChange={(enabled) => set({ enabled })}
        />
      </ListSection>
      <WorkFormActions
        submitLabel="Save routine"
        pending={pending}
        disabled={error !== null || stale}
        failure={context.writer.failureFor(pendingKey) ?? error}
        onCancel={props.onCancel}
        onSubmit={() => {
          const schedule = editing.webhook
            ? { schedule: { type: "webhook" as const, signature: null } }
            : routineDraftSchedule(draft, existing);
          if ("error" in schedule) return;
          void props.onSave({
            environmentId: context.environmentId,
            assistantId: context.detail.summary.assistantId,
            operation: "upsert",
            commandId: editing.commandId,
            ...(reviewed === null ? {} : { taskId: reviewed.taskId }),
            title: draft.title.trim(),
            prompt: draft.prompt,
            enabled: draft.enabled,
            schedule: schedule.schedule,
          });
        }}
      />
    </>
  );
}
