import {
  assistantSelectionIsCurrent,
  prepareAssistantRoutineMutation,
  type AssistantRoutineMutationIntent,
  type AssistantRoutineRecord,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import {
  CommandId,
  type AssistantRoutineReadResult,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { assistantsEnvironment } from "../../state/assistants";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
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
  WorkTime,
} from "../work/WorkLayout";
import { agentBlockedReason, type AgentContext } from "./AgentDetailPage";
import {
  ROUTINE_TRIGGER_LABELS,
  routineDraftError,
  routineDraftFrom,
  routineDraftSchedule,
  routineFireStatus,
  routineTimingLabel,
  type RoutineDraft,
} from "@t3tools/client-runtime/assistant-presentation";
import { AssistantToneBadge } from "./AssistantParts";
import { newAssistantCommandId, useCursorPages, useMountedRef } from "./useAssistants";

const ROUTINE_PAGE = 32;
const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"],
] as const;

type RoutineList = Extract<AssistantRoutineReadResult, { operation: "list" }>;
type WebhookHandoff = Extract<AssistantRoutineReadResult, { operation: "webhook" }>;

interface Editing {
  /** The agent and connection the form was opened on; a change to either blocks Save. */
  readonly selected: AssistantSelection;
  /** The routine as it was when editing began; null for a new routine. */
  readonly reviewed: AssistantRoutineRecord | null;
  readonly draft: RoutineDraft;
  /** A new routine started only by its webhook URL. */
  readonly webhook: boolean;
  readonly commandId: CommandId;
}

/** Title and message checks for a new webhook routine, which has no schedule to validate. */
function webhookDraftError(draft: RoutineDraft): string | null {
  return routineDraftError({ ...draft, mode: "interval", intervalMinutes: "60" }, null);
}

export function AgentRoutines({ context }: { readonly context: AgentContext }) {
  const { environmentId, detail, writer } = context;
  const scope = { environmentId, assistantId: detail.summary.assistantId };
  const pages = useCursorPages();
  const query = useEnvironmentQuery(
    assistantsEnvironment.routines({
      environmentId,
      input: {
        ...scope,
        operation: "list",
        limit: ROUTINE_PAGE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    }),
  );
  const list = query.data?.operation === "list" ? (query.data as RoutineList) : null;
  const routines = (list?.routines ?? []).filter((routine) => !routine.deleted);
  // Confirmations are async; actions compare against the newest list, not the one clicked on.
  const latest = useRef(routines);
  useEffect(() => {
    latest.current = routines;
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [handoff, setHandoff] = useState<WebhookHandoff | null>(null);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const mounted = useMountedRef();
  const blocked = agentBlockedReason(context, writer.permissions.routines);
  const nextCursor = list?.nextCursor ?? null;

  const submit = async (
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

  /** The URL is read once, on explicit intent, and only ever held in this panel. */
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
      commandId: CommandId.make(newAssistantCommandId()),
    });
  };

  const save = async (intent: AssistantRoutineMutationIntent) => {
    if (editing === null) return;
    const key = `routine:${editing.reviewed?.taskId ?? "new"}`;
    const result = await submit(key, editing.selected, intent, editing.reviewed ?? undefined);
    if (result === null || !mounted.current) return;
    setEditing(null);
    if (editing.webhook) void revealWebhook(result.taskId);
  };

  const editor =
    editing === null ? null : (
      <RoutineEditor
        context={context}
        editing={editing}
        current={
          editing.reviewed === null
            ? null
            : (routines.find((routine) => routine.taskId === editing.reviewed?.taskId) ?? null)
        }
        onChange={setEditing}
        onDiscard={() => {
          if (editing.reviewed === null) return open(null);
          const live = routines.find((routine) => routine.taskId === editing.reviewed?.taskId);
          if (live === undefined) setEditing(null);
          else open(live);
        }}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    );

  return (
    <WorkSection
      title="Routines"
      description="Routines send a message to this agent's chat on a schedule, using the server's clock, or when their webhook URL is called. The server keeps running them while every client is closed. New routines start paused."
      actions={
        <>
          {pages.hasPrevious || nextCursor !== null ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={!pages.hasPrevious}
                onClick={pages.previous}
              >
                Previous
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={nextCursor === null}
                onClick={() => pages.next(nextCursor)}
              >
                Next
              </Button>
            </>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={blocked !== null || editing !== null}
            onClick={() => open(null)}
          >
            <PlusIcon />
            New routine
          </Button>
        </>
      }
    >
      {handoff !== null || handoffFailed ? (
        <WebhookHandoffRow
          handoff={handoff}
          failed={handoffFailed}
          onDismiss={() => {
            setHandoff(null);
            setHandoffFailed(false);
          }}
        />
      ) : null}
      {editing !== null && editing.reviewed === null ? editor : null}
      {list === null ? (
        <WorkEmpty title={query.error ? "Routines aren't available" : "Loading routines…"} />
      ) : routines.length === 0 ? (
        <WorkEmpty title="No routines" detail="Add one to message this agent on a schedule." />
      ) : (
        routines.map((routine) =>
          editing?.reviewed?.taskId === routine.taskId ? (
            <div key={routine.taskId}>{editor}</div>
          ) : (
            <RoutineRow
              key={routine.taskId}
              context={context}
              routine={routine}
              blocked={blocked}
              editingOther={editing !== null}
              onEdit={() => open(routine)}
              onAction={(key, selected, intent) => submit(key, selected, intent, routine)}
              onRevealWebhook={() => void revealWebhook(routine.taskId)}
            />
          ),
        )
      )}
    </WorkSection>
  );
}

function WebhookHandoffRow({
  handoff,
  failed,
  onDismiss,
}: {
  readonly handoff: WebhookHandoff | null;
  readonly failed: boolean;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <WorkRow className="gap-2 bg-info/8">
      <p className="text-sm font-medium">Webhook URL</p>
      {failed ? (
        <WorkFormStatus message="The webhook URL couldn't be read. Revealing it needs permission to operate this environment." />
      ) : handoff?.url ? (
        <>
          <code className="break-all rounded-sm bg-muted px-2 py-1 text-xs">{handoff.url}</code>
          <WorkMeta>
            Anyone with this URL can start this routine. It isn't shown again; reveal it from the
            routine when you need it.
          </WorkMeta>
        </>
      ) : (
        <WorkMeta>
          This environment has no public URL yet. Turn on remote access (T3 Connect) for it, then
          reveal the URL from the routine.
        </WorkMeta>
      )}
      <div className="flex flex-wrap gap-2">
        {handoff?.url ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              void writeTextToClipboard(handoff.url!).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy URL"}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </WorkRow>
  );
}

function RoutineRow({
  context,
  routine,
  blocked,
  editingOther,
  onEdit,
  onAction,
  onRevealWebhook,
}: {
  readonly context: AgentContext;
  readonly routine: AssistantRoutineRecord;
  readonly blocked: string | null;
  readonly editingOther: boolean;
  readonly onEdit: () => void;
  readonly onAction: (
    key: string,
    selected: AssistantSelection,
    intent: AssistantRoutineMutationIntent,
  ) => Promise<unknown>;
  readonly onRevealWebhook: () => void;
}) {
  const { writer, detail, environmentId } = context;
  const target = { environmentId, assistantId: detail.summary.assistantId, taskId: routine.taskId };
  const key = `routine:${routine.taskId}`;
  const timing = routineTimingLabel(routine);
  const [showFires, setShowFires] = useState(false);
  // A retried Run now is the same run request; a new one gets a new ID after it settles.
  const [runCommandId, setRunCommandId] = useState(() => CommandId.make(newAssistantCommandId()));
  const disabled = blocked !== null || writer.pendingKey !== null || editingOther;
  const isWebhook = routine.schedule?.type === "webhook";

  /** The selection is taken at the click, so a change during the dialog is refused. */
  const act = async (
    intent: AssistantRoutineMutationIntent,
    confirm?: { readonly message: string; readonly destructive: boolean },
  ) => {
    const selected = context.selection;
    if (selected === null) return null;
    if (confirm) {
      const confirmed = await requestConfirmDialog(confirm.message, {
        variant: confirm.destructive ? "destructive" : "default",
      });
      if (confirmed !== true) return null;
    }
    return onAction(key, selected, intent);
  };

  return (
    <WorkRow>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{routine.title}</span>
        <Badge variant={routine.enabled ? "success" : "secondary"}>
          {routine.enabled ? "On" : "Paused"}
        </Badge>
      </div>
      <WorkMeta>{timing.schedule}</WorkMeta>
      <WorkMeta>
        {timing.next !== null ? (
          <>
            Next <WorkTime value={timing.next} />
          </>
        ) : (
          timing.nextNote
        )}
        {timing.next !== null || timing.nextNote !== null ? " · " : null}saved with configuration{" "}
        <WorkRevision>r{routine.configurationRevision}</WorkRevision>
      </WorkMeta>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || detail.summary.lifecycle !== "active"}
          onClick={async () => {
            const result = await act({ ...target, operation: "run-now", commandId: runCommandId });
            if (result !== null) setRunCommandId(CommandId.make(newAssistantCommandId()));
          }}
        >
          Run now
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void act({ ...target, operation: "set-enabled", enabled: !routine.enabled })
          }
        >
          {routine.enabled ? "Pause" : "Turn on"}
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={onEdit}>
          Edit
        </Button>
        {isWebhook ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || !writer.permissions.webhook}
              onClick={onRevealWebhook}
            >
              Show webhook URL
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={async () => {
                const result = await act(
                  { ...target, operation: "rotate-webhook-token" },
                  {
                    message:
                      "Rotate this routine's webhook URL? Senders using the old URL stop working. The new URL is shown once afterwards.",
                    destructive: false,
                  },
                );
                if (result !== null) onRevealWebhook();
              }}
            >
              Rotate webhook URL
            </Button>
          </>
        ) : null}
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={disabled}
          onClick={() =>
            void act(
              { ...target, operation: "delete" },
              {
                message: "Delete this routine? Runs it already started stay in the agent's chat.",
                destructive: true,
              },
            )
          }
        >
          Delete
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setShowFires((open) => !open)}>
          {showFires ? "Hide history" : "History"}
        </Button>
      </div>
      <WorkFormStatus
        message={writer.failureFor(key) ?? writer.failureFor(`webhook:${routine.taskId}`)}
      />
      {detail.summary.lifecycle !== "active" ? (
        <WorkMeta>This agent isn't active, so routines don't start runs.</WorkMeta>
      ) : null}
      {showFires ? <RoutineFires context={context} routine={routine} /> : null}
    </WorkRow>
  );
}

function RoutineFires({
  context,
  routine,
}: {
  readonly context: AgentContext;
  readonly routine: AssistantRoutineRecord;
}) {
  const { environmentId, detail } = context;
  const pages = useCursorPages();
  const query = useEnvironmentQuery(
    assistantsEnvironment.routines({
      environmentId,
      input: {
        environmentId,
        assistantId: detail.summary.assistantId,
        operation: "fires",
        taskId: routine.taskId,
        limit: ROUTINE_PAGE,
        ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
      },
    }),
  );
  const result = query.data?.operation === "fires" ? query.data : null;
  const fires = result?.fires ?? null;
  const nextCursor = result?.nextCursor ?? null;
  return (
    <div className="flex flex-col gap-2 border-l border-border/70 pl-3">
      {fires === null ? (
        <WorkMeta>{query.error ? "History isn't available." : "Loading history…"}</WorkMeta>
      ) : fires.length === 0 ? (
        <WorkMeta>This routine hasn't fired yet.</WorkMeta>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {fires.map((fire) => {
            const status = routineFireStatus(fire);
            return (
              <li key={fire.fireKey} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <AssistantToneBadge tone={status.tone}>{status.label}</AssistantToneBadge>
                  <WorkMeta>
                    {ROUTINE_TRIGGER_LABELS[fire.trigger]} · <WorkTime value={fire.startedAt} />
                  </WorkMeta>
                </span>
                <WorkMeta>
                  Configuration <WorkRevision>r{fire.configurationRevision}</WorkRevision>
                  {fire.admittedConfigurationRevision === null ? (
                    " · not admitted"
                  ) : (
                    <>
                      {" · admitted "}
                      <WorkRevision>r{fire.admittedConfigurationRevision}</WorkRevision>
                    </>
                  )}
                </WorkMeta>
              </li>
            );
          })}
        </ul>
      )}
      {pages.hasPrevious || nextCursor !== null ? (
        <div className="flex gap-2">
          <Button size="xs" variant="ghost" disabled={!pages.hasPrevious} onClick={pages.previous}>
            Newer fires
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={nextCursor === null}
            onClick={() => pages.next(nextCursor)}
          >
            Older fires
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RoutineEditor({
  context,
  editing,
  current,
  onChange,
  onDiscard,
  onCancel,
  onSave,
}: {
  readonly context: AgentContext;
  readonly editing: Editing;
  /** The live routine; null when creating. */
  readonly current: AssistantRoutineRecord | null;
  readonly onChange: (editing: Editing) => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
  readonly onSave: (intent: AssistantRoutineMutationIntent) => Promise<void>;
}) {
  const { draft, reviewed } = editing;
  const existingSchedule = reviewed?.schedule ?? null;
  const error = editing.webhook
    ? webhookDraftError(draft)
    : routineDraftError(draft, existingSchedule);
  const live = context.selection;
  const selectionChanged = live === null || !assistantSelectionIsCurrent(editing.selected, live);
  const routineChanged =
    reviewed !== null && (current === null || JSON.stringify(current) !== JSON.stringify(reviewed));
  const stale = selectionChanged || routineChanged;
  const pendingKey = `routine:${reviewed?.taskId ?? "new"}`;
  const pending = context.writer.pendingKey === pendingKey;
  const set = (patch: Partial<RoutineDraft>) =>
    onChange({ ...editing, draft: { ...draft, ...patch } });

  const save = () => {
    const schedule = editing.webhook
      ? { schedule: { type: "webhook" as const, signature: null } }
      : routineDraftSchedule(draft, existingSchedule);
    if ("error" in schedule) return;
    void onSave({
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
  };

  return (
    <WorkRow className="gap-3">
      <p className="text-sm font-medium">{reviewed === null ? "New routine" : "Edit routine"}</p>
      {stale ? (
        <div className="flex flex-col gap-2">
          <WorkFormStatus
            message={
              live === null
                ? "Offline. Your edits are kept; reconnect, then review the current version."
                : routineChanged
                  ? "This routine changed after you started editing. Your edits are kept; discard them to edit the current version."
                  : "The agent or the connection changed after you started editing. Your edits are kept; discard them to start again from the current version."
            }
          />
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={pending || live === null}
              onClick={onDiscard}
            >
              Discard edits
            </Button>
          </div>
        </div>
      ) : null}
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
        <WorkField label="Title">
          {(id) => (
            <Input
              id={id}
              maxLength={200}
              value={draft.title}
              onChange={(event) => set({ title: event.target.value })}
            />
          )}
        </WorkField>
        <WorkField
          label="Message"
          hint={
            editing.webhook || draft.mode === "keep"
              ? "Sent to the agent's chat each time the webhook is called. It may use {{body.path}} placeholders."
              : "Sent to the agent's chat each time the routine fires."
          }
        >
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={draft.prompt}
              onChange={(event) => set({ prompt: event.target.value })}
            />
          )}
        </WorkField>
        <ToggleGroup
          aria-label="Trigger"
          value={[editing.webhook ? "webhook" : draft.mode]}
          onValueChange={(next) => {
            const mode = next[0];
            if (mode === "webhook" && reviewed === null) onChange({ ...editing, webhook: true });
            else if (mode === "interval" || mode === "fixed" || mode === "keep")
              onChange({ ...editing, webhook: false, draft: { ...draft, mode } });
          }}
        >
          <Toggle value="fixed">At a time</Toggle>
          <Toggle value="interval">Every…</Toggle>
          {reviewed === null ? <Toggle value="webhook">Webhook</Toggle> : null}
          {existingSchedule?.type === "webhook" ? <Toggle value="keep">Webhook</Toggle> : null}
        </ToggleGroup>
        {editing.webhook ? (
          <WorkMeta>
            Runs when its private URL is called. The URL is shown once after saving and can be
            rotated later.
          </WorkMeta>
        ) : draft.mode === "interval" ? (
          <WorkField label="Every (minutes)">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                className="w-32"
                value={draft.intervalMinutes}
                onChange={(event) => set({ intervalMinutes: event.target.value })}
              />
            )}
          </WorkField>
        ) : draft.mode === "fixed" ? (
          <>
            <WorkField label="Time" hint={`Server time${current ? ` (${current.timeZone})` : ""}.`}>
              {(id) => (
                <Input
                  id={id}
                  type="time"
                  className="w-32"
                  value={draft.timeOfDay}
                  onChange={(event) => set({ timeOfDay: event.target.value })}
                />
              )}
            </WorkField>
            <ToggleGroup
              aria-label="Days"
              multiple
              value={draft.weekdays.map(String)}
              onValueChange={(next) =>
                set({ weekdays: next.map(Number).filter((day) => day >= 0 && day <= 6) })
              }
            >
              {WEEKDAYS.map(([day, label]) => (
                <Toggle key={day} value={String(day)}>
                  {label}
                </Toggle>
              ))}
            </ToggleGroup>
          </>
        ) : (
          <WorkMeta>Keeps the routine's webhook URL, signature and filters as they are.</WorkMeta>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) => set({ enabled: Boolean(checked) })}
          />
          Turn on after saving
        </label>
      </fieldset>
      <WorkFormStatus message={context.writer.failureFor(pendingKey) ?? error} />
      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={pending || error !== null || stale} onClick={save}>
          {pending ? "Saving…" : "Save routine"}
        </Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </WorkRow>
  );
}
