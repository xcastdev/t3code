import {
  assistantMemoryRecipient,
  assistantMemorySourceKey,
  assistantMemorySourceSelector,
  assistantMemoryStatus,
  assistantSelectionIsCurrent,
  prepareAssistantMemoryMutation,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import type {
  AssistantMemoryReadResult,
  AssistantMemoryWriteInput,
  MemoryGrant,
  MemoryOwner,
  ProjectMemorySourceRead,
} from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { assistantsEnvironment } from "../../state/assistants";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  WorkEmpty,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
  WorkTime,
} from "../work/WorkLayout";
import { agentBlockedReason, type AgentContext } from "./AgentDetailPage";
import { AgentMemoryProcessing } from "./AgentMemoryProcessing";
import { useAssistantRoster, useCursorPages } from "./useAssistants";

const MEMORY_PAGE = 32;

type PageOperation = "list" | "status" | "grants" | "configuration" | "context" | "confirmations";
type ReadOf<O extends AssistantMemoryReadResult["operation"]> = Extract<
  AssistantMemoryReadResult,
  { operation: O }
>;
type SourceTuple = ReturnType<typeof assistantMemorySourceSelector>;

export function useAgentMemoryRead<O extends PageOperation>(
  context: AgentContext,
  operation: O,
  cursor?: string,
  enabled = true,
) {
  const { environmentId } = context;
  const query = useEnvironmentQuery(
    enabled
      ? assistantsEnvironment.memory({
          environmentId,
          input: {
            environmentId,
            assistantId: context.detail.summary.assistantId,
            operation,
            limit: MEMORY_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        })
      : null,
  );
  const data =
    query.data !== null && query.data.operation === operation ? (query.data as ReadOf<O>) : null;
  return { ...query, data };
}

/** A form opened on one connection, configuration and source stays bound to them. */
function sessionIsCurrent(
  context: AgentContext,
  selected: AssistantSelection,
  reviewed: SourceTuple | null,
  live: ProjectMemorySourceRead | null,
) {
  const current = context.selection;
  if (current === null || !assistantSelectionIsCurrent(selected, current)) return false;
  if (reviewed === null) return true;
  return (
    live !== null &&
    live.status === "current" &&
    assistantMemorySourceKey(selected, reviewed) ===
      assistantMemorySourceKey(selected, assistantMemorySourceSelector(live))
  );
}

function memorySender(context: AgentContext) {
  return (
    key: string,
    selected: AssistantSelection,
    intent: AssistantMemoryWriteInput,
    extra: Omit<
      Parameters<typeof prepareAssistantMemoryMutation>[0],
      "selected" | "current" | "intent"
    >,
  ) => {
    const current = context.latestSelection();
    return context.writer.run(
      key,
      assistantsEnvironment.memoryWrite,
      current === null
        ? null
        : prepareAssistantMemoryMutation({ selected, current, intent, ...extra }),
    );
  };
}

export function AgentMemory({ context }: { readonly context: AgentContext }) {
  const pages = useCursorPages();
  const list = useAgentMemoryRead(context, "list", pages.cursor);
  const status = useAgentMemoryRead(context, "status");
  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;
  // Revoking needs the shared source's exact tuple, which only the memory list carries.
  const [locating, setLocating] = useState<MemoryGrant | null>(null);
  const located =
    locating === null
      ? null
      : (items.find(
          (item) =>
            item.sourceId === locating.source.sourceId &&
            item.sourceRevision === locating.source.sourceRevision,
        ) ?? null);
  const locate =
    locating === null || list.data === null || located !== null
      ? null
      : nextCursor === null
        ? ({ kind: "missed", grantId: locating.id } as const)
        : ({ kind: "older", grantId: locating.id } as const);

  return (
    <>
      <MemoryStatusSection status={status.data} error={status.error} />
      <WorkSection
        title="Memories"
        description="Private to this agent unless you share one. Editing replaces the old version; forgetting stops it from being recalled or captured again."
        actions={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={!pages.hasPrevious}
              onClick={pages.previous}
            >
              Newer
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={nextCursor === null}
              onClick={() => pages.next(nextCursor)}
            >
              Older
            </Button>
          </>
        }
      >
        {list.data === null ? (
          <WorkEmpty title={list.error ? "Memory isn't available" : "Loading memory…"} />
        ) : items.length === 0 ? (
          <WorkEmpty
            title="Nothing remembered yet"
            detail="Useful facts from this agent's chat appear here when automatic memory is on."
          />
        ) : (
          items.map((source) => (
            <MemoryItem
              // Keyed by source, not revision: a draft survives another client's edit and shows as stale.
              key={
                source.status === "current"
                  ? source.sourceId
                  : assistantMemorySourceKey(
                      context.detail.summary,
                      assistantMemorySourceSelector(source),
                    )
              }
              context={context}
              source={source}
            />
          ))
        )}
      </WorkSection>
      <MemoryShares
        context={context}
        items={items}
        located={located}
        locating={locating}
        locate={locate}
        onLocate={setLocating}
        onLookOlder={() => pages.next(nextCursor)}
        onLocated={() => setLocating(null)}
      />
      <MemoryConfirmations context={context} />
      <AgentMemoryProcessing context={context} />
      <RecallPreview context={context} />
    </>
  );
}

function MemoryStatusSection({
  status,
  error,
}: {
  readonly status: ReadOf<"status"> | null;
  readonly error: string | null;
}) {
  if (status === null)
    return error ? (
      <WorkSection title="Memory status">
        <WorkEmpty title="Memory status isn't available" />
      </WorkSection>
    ) : null;
  const view = assistantMemoryStatus(status);
  const jobs = view.jobs.filter((job) => job.count > 0);
  return (
    <WorkSection title="Memory status">
      <WorkRow>
        <WorkMeta>
          {jobs.length > 0
            ? `Processing: ${jobs.map((job) => `${job.count} ${job.status}`).join(" · ")}`
            : "No memory processing is waiting."}
        </WorkMeta>
        {view.pendingCleanup > 0 ? (
          <WorkMeta>
            Cleanup pending for {view.pendingCleanup} forgotten{" "}
            {view.pendingCleanup === 1 ? "memory" : "memories"}. They are already excluded from
            recall; derived copies are still being removed.
          </WorkMeta>
        ) : null}
        {view.requiresUserConfirmation ? (
          <WorkFormStatus
            tone="muted"
            message="Some messages from after a forget are waiting for you to decide whether the agent should learn them. Review them under Waiting for your confirmation."
          />
        ) : null}
      </WorkRow>
    </WorkSection>
  );
}

interface EditSession {
  readonly text: string;
  readonly selected: AssistantSelection;
  readonly reviewed: SourceTuple;
}

/** Sharing grants the exact version that was showing when the picker opened, never a later one. */
interface ShareSession {
  readonly selected: AssistantSelection;
  readonly reviewed: SourceTuple;
}

function MemoryItem({
  context,
  source,
}: {
  readonly context: AgentContext;
  readonly source: ProjectMemorySourceRead;
}) {
  const { writer, detail } = context;
  const send = memorySender(context);
  const [editing, setEditing] = useState<EditSession | null>(null);
  const [sharing, setSharing] = useState<ShareSession | null>(null);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const current = source.status === "current";
  const key = `memory:${source.sourceId}`;
  const pending = writer.pendingKey === key;
  const scope = {
    environmentId: detail.summary.environmentId,
    assistantId: detail.summary.assistantId,
  };
  const editCurrent =
    editing !== null && sessionIsCurrent(context, editing.selected, editing.reviewed, source);

  const forget = async () => {
    const selected = context.selection;
    if (selected === null) return;
    const reviewed = assistantMemorySourceSelector(source);
    const confirmed = await requestConfirmDialog(
      "Forget this memory? The agent stops recalling it, and the same fact won't be captured again from old chat. Messages already in the chat stay.",
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await send(
      key,
      selected,
      { ...scope, operation: "forget", source: reviewed },
      {
        currentSource: source,
      },
    );
  };

  return (
    <WorkRow>
      {editing === null ? (
        <p className="text-sm whitespace-pre-wrap">{source.content}</p>
      ) : (
        <Textarea
          aria-label="Memory text"
          rows={3}
          value={editing.text}
          // Locked while saving, so a successful save never discards later typing.
          disabled={pending}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
        />
      )}
      <WorkMeta>
        {source.sourceKind} · <WorkTime value={source.updatedAt} /> · revision{" "}
        <WorkRevision>{source.sourceRevision}</WorkRevision>
        {current ? null : ` · ${source.status}`}
      </WorkMeta>
      {editing !== null && !editCurrent ? (
        <WorkFormStatus message="This memory or the connection changed after you started editing. Your text is kept; discard it to edit the current version." />
      ) : null}
      {current || editing !== null ? (
        <div className="flex flex-wrap gap-2">
          {editing === null ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={() => {
                  if (context.selection === null) return;
                  setEditing({
                    text: source.content,
                    selected: context.selection,
                    reviewed: assistantMemorySourceSelector(source),
                  });
                }}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={() => {
                  const selected = context.selection;
                  setSharing((open) =>
                    open !== null || selected === null
                      ? null
                      : { selected, reviewed: assistantMemorySourceSelector(source) },
                  );
                }}
              >
                Share…
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={() => void forget()}
              >
                Forget
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                disabled={
                  blocked !== null ||
                  pending ||
                  !editCurrent ||
                  editing.text.trim().length === 0 ||
                  editing.text.trim() === source.content.trim()
                }
                onClick={async () => {
                  const submitted = editing;
                  const result = await send(
                    key,
                    submitted.selected,
                    {
                      ...scope,
                      operation: "edit",
                      source: submitted.reviewed,
                      content: submitted.text.trim(),
                    },
                    { currentSource: source },
                  );
                  if (result !== null) setEditing(null);
                }}
              >
                {pending ? "Saving…" : "Save correction"}
              </Button>
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => setEditing(null)}>
                {editCurrent ? "Cancel" : "Discard edits"}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {sharing !== null ? (
        <ShareMemory
          context={context}
          session={sharing}
          source={source}
          pending={pending}
          onClose={() => setSharing(null)}
          onShare={async (recipient) => {
            const submitted = sharing;
            const result = await send(
              key,
              submitted.selected,
              {
                ...scope,
                operation: "grant",
                source: submitted.reviewed,
                recipient: recipient.owner,
                recipientRevision: recipient.revision,
              },
              { currentSource: source, recipient },
            );
            if (result !== null) setSharing(null);
          }}
        />
      ) : null}
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

type Recipient = ReturnType<typeof assistantMemoryRecipient>;

function ownerKey(owner: MemoryOwner) {
  return owner.kind === "assistant"
    ? `assistant:${owner.assistantId}`
    : `project:${owner.projectId}`;
}

/**
 * Sharing names another agent or a project on the same environment. Its
 * current memory revision comes from an exact recipient read, made when chosen.
 */
function ShareMemory({
  context,
  session,
  source,
  pending,
  onClose,
  onShare,
}: {
  readonly context: AgentContext;
  readonly session: ShareSession;
  readonly source: ProjectMemorySourceRead;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onShare: (recipient: Recipient) => void;
}) {
  const { environmentId, detail } = context;
  const pages = useCursorPages();
  const roster = useAssistantRoster(environmentId, false, pages.cursor);
  const projects = useProjects();
  const options: ReadonlyArray<{ readonly owner: MemoryOwner; readonly label: string }> = [
    ...(roster.data?.assistants ?? [])
      .filter((assistant) => assistant.assistantId !== detail.summary.assistantId)
      .map((assistant) => ({
        owner: { kind: "assistant" as const, assistantId: assistant.assistantId },
        label: `Agent · ${assistant.name}`,
      })),
    ...projects
      .filter(
        (project) =>
          project.environmentId === environmentId &&
          project.id !== detail.summary.binding.backingProjectId &&
          project.isScratch !== true,
      )
      .map((project) => ({
        owner: { kind: "project" as const, projectId: project.id },
        label: `Project · ${project.title}`,
      })),
  ];
  const [chosen, setChosen] = useState<MemoryOwner | null>(null);
  const metadata = useEnvironmentQuery(
    chosen === null
      ? null
      : assistantsEnvironment.memory({
          environmentId,
          input: {
            environmentId,
            assistantId: detail.summary.assistantId,
            operation: "recipient",
            recipient: chosen,
          },
        }),
  );
  const recipient =
    metadata.data?.operation === "recipient" ? assistantMemoryRecipient(metadata.data) : null;
  const stale = !sessionIsCurrent(context, session.selected, session.reviewed, source);
  const nextCursor = roster.data?.nextCursor ?? null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/70 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={chosen === null ? "" : ownerKey(chosen)}
          onValueChange={(value) =>
            setChosen(options.find((option) => ownerKey(option.owner) === value)?.owner ?? null)
          }
        >
          <SelectTrigger size="sm" className="w-64" aria-label="Share with">
            <SelectValue>
              {chosen === null
                ? "Choose an agent or project"
                : (options.find((option) => ownerKey(option.owner) === ownerKey(chosen))?.label ??
                  "Chosen recipient")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {options.map((option) => (
              <SelectItem key={ownerKey(option.owner)} value={ownerKey(option.owner)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {pages.hasPrevious || nextCursor !== null ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={!pages.hasPrevious}
              onClick={pages.previous}
            >
              Previous agents
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={nextCursor === null}
              onClick={() => pages.next(nextCursor)}
            >
              More agents
            </Button>
          </>
        ) : null}
        <Button
          size="xs"
          disabled={recipient === null || stale || pending || context.writer.pendingKey !== null}
          onClick={() => {
            if (recipient !== null) onShare(recipient);
          }}
        >
          Share
        </Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={onClose}>
          Close
        </Button>
      </div>
      <WorkMeta>
        {stale
          ? "This memory or the connection changed. Close sharing and open it again."
          : chosen !== null && metadata.error !== null
            ? "That recipient can't receive shared memory right now."
            : recipient !== null
              ? `${metadata.data?.operation === "recipient" ? metadata.data.title : "It"} can recall this memory until you stop sharing it.`
              : "The recipient can recall this memory until you stop sharing it."}
      </WorkMeta>
    </div>
  );
}

function useRecipientLabel(context: AgentContext) {
  const roster = useAssistantRoster(context.environmentId, true);
  const projects = useProjects();
  return (owner: MemoryOwner) => {
    if (owner.kind === "assistant") {
      const assistant = roster.data?.assistants.find(
        (candidate) => candidate.assistantId === owner.assistantId,
      );
      return assistant ? `agent ${assistant.name}` : `agent ${owner.assistantId}`;
    }
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === context.environmentId && candidate.id === owner.projectId,
    );
    return project ? `project ${project.title}` : `project ${owner.projectId}`;
  };
}

/**
 * Every active share, paged on its own so none is unreachable. Stopping one
 * needs its memory's exact tuple; a share outside the loaded memory page is
 * found by stepping the memory pages, one bounded page at a time.
 */
function MemoryShares({
  context,
  items,
  located,
  locating,
  locate,
  onLocate,
  onLookOlder,
  onLocated,
}: {
  readonly context: AgentContext;
  readonly items: ReadonlyArray<ProjectMemorySourceRead>;
  readonly located: ProjectMemorySourceRead | null;
  readonly locating: MemoryGrant | null;
  readonly locate: { readonly kind: "missed" | "older"; readonly grantId: string } | null;
  readonly onLocate: (grant: MemoryGrant) => void;
  readonly onLookOlder: () => void;
  readonly onLocated: () => void;
}) {
  const { writer, detail } = context;
  const pages = useCursorPages();
  const grants = useAgentMemoryRead(context, "grants", pages.cursor);
  const send = memorySender(context);
  const label = useRecipientLabel(context);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const active = (grants.data?.grants ?? []).filter((grant) => grant.revokedAt === null);
  const nextCursor = grants.data?.nextCursor ?? null;
  if (grants.data !== null && active.length === 0 && !pages.hasPrevious && nextCursor === null)
    return null;

  const revoke = async (grant: MemoryGrant, source: ProjectMemorySourceRead) => {
    const selected = context.selection;
    if (selected === null) return;
    const confirmed = await requestConfirmDialog(
      `Stop sharing this memory with ${label(grant.recipient)}? It stops being recalled there.`,
    );
    if (confirmed !== true) return;
    const result = await send(
      `revoke:${grant.id}`,
      selected,
      {
        environmentId: detail.summary.environmentId,
        assistantId: detail.summary.assistantId,
        operation: "revoke",
        source: assistantMemorySourceSelector(source),
        recipient: grant.recipient,
        recipientRevision: grant.recipientRevision,
        grantId: grant.id,
      },
      {
        currentSource: source,
        currentGrant: grant,
        recipient: {
          environmentId: grant.environmentId,
          owner: grant.recipient,
          revision: grant.recipientRevision,
        },
      },
    );
    if (result !== null) onLocated();
  };

  return (
    <WorkSection
      title="Shared memories"
      description="Each share lets another agent or project recall one memory until you stop it."
      actions={
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
      }
    >
      {grants.data === null ? (
        <WorkEmpty title={grants.error ? "Shares aren't available" : "Loading shares…"} />
      ) : active.length === 0 ? (
        <WorkEmpty title="No active shares on this page" />
      ) : (
        active.map((grant) => {
          const onPage =
            items.find(
              (item) =>
                item.sourceId === grant.source.sourceId &&
                item.sourceRevision === grant.source.sourceRevision,
            ) ?? (locating?.id === grant.id ? located : null);
          const key = `revoke:${grant.id}`;
          return (
            <WorkRow key={grant.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="info">Shared with {label(grant.recipient)}</Badge>
                <WorkMeta>
                  since <WorkTime value={grant.createdAt} />
                </WorkMeta>
              </div>
              <WorkMeta className="line-clamp-2">
                {onPage?.content ??
                  `Memory ${grant.source.sourceId}, revision ${grant.source.sourceRevision}`}
              </WorkMeta>
              <div className="flex flex-wrap gap-2">
                {onPage !== null && onPage !== undefined ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={blocked !== null || writer.pendingKey !== null}
                    onClick={() => void revoke(grant, onPage)}
                  >
                    Stop sharing
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={blocked !== null || locating?.id === grant.id}
                    onClick={() => onLocate(grant)}
                  >
                    Find its memory to stop sharing
                  </Button>
                )}
                {locate?.kind === "older" && locate.grantId === grant.id ? (
                  <Button size="xs" variant="ghost" onClick={onLookOlder}>
                    Not on this memory page. Look in older memories
                  </Button>
                ) : null}
              </div>
              {locate?.kind === "missed" && locate.grantId === grant.id ? (
                <WorkFormStatus message="Its memory isn't on any later page. Go back to newer memories, or it may no longer be current, in which case it is no longer recalled." />
              ) : null}
              <WorkFormStatus message={writer.failureFor(key)} />
            </WorkRow>
          );
        })
      )}
    </WorkSection>
  );
}

/**
 * Messages written after a forget are not learned until a person says so. Each
 * one is taught individually, with its exact current source; there is no bulk
 * confirm and nothing forgotten is restored.
 */
function MemoryConfirmations({ context }: { readonly context: AgentContext }) {
  const { writer, detail } = context;
  const pages = useCursorPages();
  const read = useAgentMemoryRead(context, "confirmations", pages.cursor);
  const send = memorySender(context);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const items = read.data?.items ?? [];
  const nextCursor = read.data?.nextCursor ?? null;
  if (read.data !== null && items.length === 0 && !pages.hasPrevious) return null;
  if (read.data === null && read.error === null) return null;

  const teach = async (source: ProjectMemorySourceRead) => {
    const selected = context.selection;
    if (selected === null) return;
    const reviewed = assistantMemorySourceSelector(source);
    const confirmed = await requestConfirmDialog(
      "Let the agent learn from this message? Only this message is taught. Memories you forgot stay forgotten.",
    );
    if (confirmed !== true) return;
    await send(
      `confirm:${source.sourceId}`,
      selected,
      {
        environmentId: detail.summary.environmentId,
        assistantId: detail.summary.assistantId,
        operation: "confirm",
        source: reviewed,
      },
      { currentSource: source },
    );
  };

  return (
    <WorkSection
      title="Waiting for your confirmation"
      description="Messages from after you forgot something. The agent learns one only when you confirm it."
      actions={
        pages.hasPrevious || nextCursor !== null ? (
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
        ) : undefined
      }
    >
      {read.data === null ? (
        <WorkEmpty title="Confirmations aren't available" />
      ) : (
        items.map((source) => (
          <WorkRow key={source.sourceId}>
            <p className="text-sm whitespace-pre-wrap">{source.content}</p>
            <WorkMeta>
              <WorkTime value={source.updatedAt} /> · revision{" "}
              <WorkRevision>{source.sourceRevision}</WorkRevision>
            </WorkMeta>
            <div>
              <Button
                size="xs"
                variant="outline"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={() => void teach(source)}
              >
                Teach this
              </Button>
            </div>
            <WorkFormStatus message={writer.failureFor(`confirm:${source.sourceId}`)} />
          </WorkRow>
        ))
      )}
    </WorkSection>
  );
}

function RecallPreview({ context }: { readonly context: AgentContext }) {
  const [open, setOpen] = useState(false);
  const preview = useAgentMemoryRead(context, "context", undefined, open);
  return (
    <WorkSection
      title="What it recalls"
      description="The memory context the agent's next turn receives."
      actions={
        <Button size="xs" variant="outline" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open ? (
        <WorkRow>
          {preview.data === null ? (
            <WorkMeta>{preview.error ? "Recall isn't available." : "Loading…"}</WorkMeta>
          ) : preview.data.text.length === 0 ? (
            <WorkMeta>Nothing is recalled right now.</WorkMeta>
          ) : (
            <pre className="max-h-80 overflow-auto text-xs whitespace-pre-wrap">
              {preview.data.text}
            </pre>
          )}
        </WorkRow>
      ) : (
        <WorkRow>
          <WorkMeta>Hidden.</WorkMeta>
        </WorkRow>
      )}
    </WorkSection>
  );
}
