import {
  assistantMemoryRecipient,
  assistantMemorySourceKey,
  assistantMemorySourceSelector,
  assistantMemoryStatus,
  assistantSelectionIsCurrent,
  prepareAssistantMemoryMutation,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import {
  EMPTY_PROCESSING_ROUTE,
  PROCESSING_PROVIDERS,
  processingDraftConfiguration,
  processingDraftFrom,
  type ExtractionProvider,
  type ProcessingDraft,
  type ProcessingRouteDraft,
} from "@t3tools/client-runtime/assistant-presentation";
import type {
  AssistantMemoryReadResult,
  AssistantMemoryWriteInput,
  MemoryGrant,
  MemoryOwner,
  MemoryProcessingConfiguration,
  ProjectMemorySourceRead,
} from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { assistantsEnvironment } from "../../state/assistants";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { WorkBlock, WorkFormActions, WorkText } from "../work/WorkParts";
import { AgentInput } from "./AssistantParts";
import { agentBlockedReason, type MobileAgentContext } from "./AssistantScreens";
import { useAssistantRoster, useCursorPages } from "./useAssistants";

const PAGE = 32;

type PageOperation = "list" | "status" | "grants" | "configuration" | "context" | "confirmations";
type ReadOf<O extends AssistantMemoryReadResult["operation"]> = Extract<
  AssistantMemoryReadResult,
  { operation: O }
>;
type SourceTuple = ReturnType<typeof assistantMemorySourceSelector>;

function useMemoryRead<O extends PageOperation>(
  context: MobileAgentContext,
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
            limit: PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        })
      : null,
  );
  return {
    ...query,
    data:
      query.data !== null && query.data.operation === operation ? (query.data as ReadOf<O>) : null,
  };
}

/** A form opened on one connection, configuration and source stays bound to them. */
function sessionIsCurrent(
  context: MobileAgentContext,
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

function memorySender(context: MobileAgentContext) {
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

function confirm(title: string, message: string, destructive: boolean, run: () => void) {
  Dialog.confirm({ title, message, confirmText: title, destructive, onConfirm: run });
}

export function AgentMemorySection({ context }: { readonly context: MobileAgentContext }) {
  const pages = useCursorPages();
  const list = useMemoryRead(context, "list", pages.cursor);
  const status = useMemoryRead(context, "status");
  const items = list.data?.items ?? [];
  const next = list.data?.nextCursor ?? null;
  const view = status.data === null ? null : assistantMemoryStatus(status.data);
  const jobs = view?.jobs.filter((job) => job.count > 0) ?? [];
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
  return (
    <>
      <ListSection title="Memory status">
        <WorkBlock>
          <WorkText muted>
            {view === null
              ? status.error
                ? "Memory status isn't available."
                : "Loading memory status…"
              : jobs.length > 0
                ? `Processing: ${jobs.map((job) => `${job.count} ${job.status}`).join(" · ")}`
                : "No memory processing is waiting."}
          </WorkText>
          {view !== null && view.pendingCleanup > 0 ? (
            <WorkText muted>
              {`Cleanup pending for ${view.pendingCleanup} forgotten ${view.pendingCleanup === 1 ? "memory" : "memories"}. They are already excluded from recall.`}
            </WorkText>
          ) : null}
          {view?.requiresUserConfirmation ? (
            <WorkText muted>
              Some messages from after a forget are waiting for you to decide whether the agent
              should learn them. Review them below.
            </WorkText>
          ) : null}
        </WorkBlock>
      </ListSection>
      <ListSection
        title="Memories"
        footer="Private to this agent unless shared. Editing replaces the old version; forgetting stops recall and re-capture. Chat history stays."
      >
        {list.data === null ? (
          <WorkBlock>
            <WorkText muted>{list.error ? "Memory isn't available." : "Loading memory…"}</WorkText>
          </WorkBlock>
        ) : items.length === 0 ? (
          <WorkBlock>
            <WorkText muted>Nothing remembered yet.</WorkText>
          </WorkBlock>
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
        {pages.hasPrevious ? <ListActionRow label="Newer" onPress={pages.previous} /> : null}
        {next !== null ? <ListActionRow label="Older" onPress={() => pages.next(next)} /> : null}
      </ListSection>
      <MemoryShares
        context={context}
        items={items}
        locating={locating}
        located={located}
        nextMemoryPage={list.data === null ? undefined : next}
        onLocate={setLocating}
        onLookOlder={() => pages.next(next)}
        onDone={() => setLocating(null)}
      />
      <MemoryConfirmations context={context} />
      <MemoryProcessing context={context} />
      <RecallPreview context={context} />
    </>
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

function MemoryItem(props: {
  readonly context: MobileAgentContext;
  readonly source: ProjectMemorySourceRead;
}) {
  const { context, source } = props;
  const { writer, detail } = context;
  const send = memorySender(context);
  const key = `memory:${source.sourceId}`;
  const [editing, setEditing] = useState<EditSession | null>(null);
  const [sharing, setSharing] = useState<ShareSession | null>(null);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const current = source.status === "current";
  const pending = writer.pendingKey === key;
  const busy = writer.pendingKey !== null;
  const scope = {
    environmentId: detail.summary.environmentId,
    assistantId: detail.summary.assistantId,
  };
  const editCurrent =
    editing !== null && sessionIsCurrent(context, editing.selected, editing.reviewed, source);

  return (
    <>
      <WorkBlock>
        {editing === null ? (
          <WorkText>{source.content}</WorkText>
        ) : (
          <AgentInput
            label="Correction"
            multiline
            maxLength={32000}
            value={editing.text}
            disabled={pending}
            onChange={(text) => setEditing({ ...editing, text })}
          />
        )}
        <WorkText muted>
          {`${source.sourceKind} · revision ${source.sourceRevision}${current ? "" : ` · ${source.status}`}`}
        </WorkText>
        {editing !== null && !editCurrent ? (
          <Notice
            icon="info.circle"
            message="This memory or the connection changed after you started editing. Your text is kept; discard it to edit the current version."
          />
        ) : null}
        {writer.failureFor(key) ? <Notice tone="danger" message={writer.failureFor(key)!} /> : null}
        {editing !== null ? (
          <WorkFormActions
            submitLabel="Save correction"
            pending={pending}
            disabled={
              blocked !== null ||
              !editCurrent ||
              editing.text.trim().length === 0 ||
              editing.text.trim() === source.content.trim()
            }
            failure={null}
            onCancel={() => setEditing(null)}
            onSubmit={async () => {
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
          />
        ) : null}
      </WorkBlock>
      {current && editing === null ? (
        <>
          <ListActionRow
            icon="pencil"
            label="Edit"
            disabled={blocked !== null || busy}
            onPress={() => {
              if (context.selection === null) return;
              setEditing({
                text: source.content,
                selected: context.selection,
                reviewed: assistantMemorySourceSelector(source),
              });
            }}
          />
          <ListActionRow
            label={sharing ? "Cancel sharing" : "Share with an agent or project"}
            disabled={blocked !== null || busy}
            onPress={() => {
              const selected = context.selection;
              setSharing(
                sharing !== null || selected === null
                  ? null
                  : { selected, reviewed: assistantMemorySourceSelector(source) },
              );
            }}
          />
          <ListActionRow
            icon="trash"
            label="Forget"
            tone="danger"
            disabled={blocked !== null || busy}
            onPress={() => {
              const selected = context.selection;
              if (selected === null) return;
              const reviewed = assistantMemorySourceSelector(source);
              confirm(
                "Forget",
                "The agent stops recalling this, and the same fact won't be captured again from old chat. Messages already in the chat stay.",
                true,
                () =>
                  void send(
                    key,
                    selected,
                    { ...scope, operation: "forget", source: reviewed },
                    {
                      currentSource: source,
                    },
                  ),
              );
            }}
          />
        </>
      ) : null}
      {sharing !== null && editing === null ? (
        <ShareChoices
          context={context}
          session={sharing}
          source={source}
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
    </>
  );
}

type Recipient = ReturnType<typeof assistantMemoryRecipient>;

function ownerKey(owner: MemoryOwner) {
  return owner.kind === "assistant"
    ? `assistant:${owner.assistantId}`
    : `project:${owner.projectId}`;
}

/** The recipient's current memory revision comes from an exact recipient read, made when chosen. */
function ShareChoices(props: {
  readonly context: MobileAgentContext;
  readonly session: ShareSession;
  readonly source: ProjectMemorySourceRead;
  readonly onClose: () => void;
  readonly onShare: (recipient: Recipient) => void;
}) {
  const { context } = props;
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
  const stale = !sessionIsCurrent(
    context,
    props.session.selected,
    props.session.reviewed,
    props.source,
  );
  const next = roster.data?.nextCursor ?? null;
  return (
    <>
      {options.map((option) => (
        <ListChoiceRow
          key={ownerKey(option.owner)}
          label={option.label}
          selected={chosen !== null && ownerKey(chosen) === ownerKey(option.owner)}
          onPress={() => setChosen(option.owner)}
        />
      ))}
      {pages.hasPrevious ? (
        <ListActionRow label="Previous agents" onPress={pages.previous} />
      ) : null}
      {next !== null ? (
        <ListActionRow label="More agents" onPress={() => pages.next(next)} />
      ) : null}
      <WorkBlock>
        <WorkText muted>
          {options.length === 0
            ? "There are no other agents or projects on this environment."
            : stale
              ? "This memory or the connection changed. Close sharing and open it again."
              : chosen !== null && metadata.error !== null
                ? "That recipient can't receive shared memory right now."
                : "The recipient can recall this memory until you stop sharing it."}
        </WorkText>
      </WorkBlock>
      <ListActionRow
        label="Share"
        disabled={recipient === null || stale || context.writer.pendingKey !== null}
        onPress={() => {
          if (recipient !== null) props.onShare(recipient);
        }}
      />
      {stale ? <ListActionRow label="Close sharing" onPress={props.onClose} /> : null}
    </>
  );
}

/**
 * Every active share, paged on its own so none is unreachable. A share whose
 * memory isn't on the loaded page is found by stepping the memory pages.
 */
function MemoryShares(props: {
  readonly context: MobileAgentContext;
  readonly items: ReadonlyArray<ProjectMemorySourceRead>;
  readonly locating: MemoryGrant | null;
  readonly located: ProjectMemorySourceRead | null;
  /** The loaded memory page's next cursor; undefined while it loads. */
  readonly nextMemoryPage: string | null | undefined;
  readonly onLocate: (grant: MemoryGrant) => void;
  readonly onLookOlder: () => void;
  readonly onDone: () => void;
}) {
  const { context, items } = props;
  const { writer, detail, environmentId } = context;
  const pages = useCursorPages();
  const grants = useMemoryRead(context, "grants", pages.cursor);
  const send = memorySender(context);
  const roster = useAssistantRoster(environmentId, true);
  const projects = useProjects();
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const active = (grants.data?.grants ?? []).filter((grant) => grant.revokedAt === null);
  const next = grants.data?.nextCursor ?? null;
  if (grants.data !== null && active.length === 0 && !pages.hasPrevious && next === null)
    return null;
  const label = (owner: MemoryOwner) =>
    owner.kind === "assistant"
      ? `agent ${roster.data?.assistants.find((a) => a.assistantId === owner.assistantId)?.name ?? owner.assistantId}`
      : `project ${projects.find((p) => p.environmentId === environmentId && p.id === owner.projectId)?.title ?? owner.projectId}`;

  return (
    <ListSection
      title="Shared memories"
      footer="Each share lets another agent or project recall one memory until you stop it."
    >
      {grants.data === null ? (
        <WorkBlock>
          <WorkText muted>{grants.error ? "Shares aren't available." : "Loading shares…"}</WorkText>
        </WorkBlock>
      ) : active.length === 0 ? (
        <WorkBlock>
          <WorkText muted>No active shares on this page.</WorkText>
        </WorkBlock>
      ) : (
        active.map((grant) => {
          const source =
            items.find(
              (item) =>
                item.sourceId === grant.source.sourceId &&
                item.sourceRevision === grant.source.sourceRevision,
            ) ?? (props.locating?.id === grant.id ? props.located : null);
          const key = `revoke:${grant.id}`;
          const searching = props.locating?.id === grant.id && source === null;
          return (
            <WorkBlock key={grant.id}>
              <WorkText>{`Shared with ${label(grant.recipient)}`}</WorkText>
              <WorkText muted>
                {source?.content ??
                  `Memory ${grant.source.sourceId}, revision ${grant.source.sourceRevision}`}
              </WorkText>
              {source !== null && source !== undefined ? (
                <ListActionRow
                  label="Stop sharing"
                  tone="danger"
                  disabled={blocked !== null || writer.pendingKey !== null}
                  onPress={() => {
                    const selected = context.selection;
                    if (selected === null) return;
                    confirm(
                      "Stop sharing",
                      `It stops being recalled by ${label(grant.recipient)}.`,
                      true,
                      () =>
                        void send(
                          key,
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
                        ).then((result) => {
                          if (result !== null) props.onDone();
                        }),
                    );
                  }}
                />
              ) : searching && props.nextMemoryPage !== undefined ? (
                props.nextMemoryPage === null ? (
                  <WorkText muted>
                    Its memory isn't on any later page. Go back to newer memories, or it may no
                    longer be current, in which case it is no longer recalled.
                  </WorkText>
                ) : (
                  <ListActionRow
                    label="Not on this memory page. Look in older memories"
                    onPress={props.onLookOlder}
                  />
                )
              ) : (
                <ListActionRow
                  label="Find its memory to stop sharing"
                  disabled={blocked !== null}
                  onPress={() => props.onLocate(grant)}
                />
              )}
              {writer.failureFor(key) ? (
                <Notice tone="danger" message={writer.failureFor(key)!} />
              ) : null}
            </WorkBlock>
          );
        })
      )}
      {pages.hasPrevious ? (
        <ListActionRow label="Previous shares" onPress={pages.previous} />
      ) : null}
      {next !== null ? (
        <ListActionRow label="More shares" onPress={() => pages.next(next)} />
      ) : null}
    </ListSection>
  );
}

/** Each post-forget message is taught individually and explicitly; nothing forgotten comes back. */
function MemoryConfirmations({ context }: { readonly context: MobileAgentContext }) {
  const { writer, detail } = context;
  const pages = useCursorPages();
  const read = useMemoryRead(context, "confirmations", pages.cursor);
  const send = memorySender(context);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const items = read.data?.items ?? [];
  const next = read.data?.nextCursor ?? null;
  if (read.data === null || (items.length === 0 && !pages.hasPrevious)) return null;
  return (
    <ListSection
      title="Waiting for your confirmation"
      footer="Messages from after you forgot something. The agent learns one only when you confirm it."
    >
      {items.map((source) => {
        const key = `confirm:${source.sourceId}`;
        return (
          <WorkBlock key={source.sourceId}>
            <WorkText>{source.content}</WorkText>
            <ListActionRow
              label="Teach this"
              disabled={blocked !== null || writer.pendingKey !== null}
              onPress={() => {
                const selected = context.selection;
                if (selected === null) return;
                const reviewed = assistantMemorySourceSelector(source);
                confirm(
                  "Teach",
                  "Only this message is taught. Memories you forgot stay forgotten.",
                  false,
                  () =>
                    void send(
                      key,
                      selected,
                      {
                        environmentId: detail.summary.environmentId,
                        assistantId: detail.summary.assistantId,
                        operation: "confirm",
                        source: reviewed,
                      },
                      { currentSource: source },
                    ),
                );
              }}
            />
            {writer.failureFor(key) ? (
              <Notice tone="danger" message={writer.failureFor(key)!} />
            ) : null}
          </WorkBlock>
        );
      })}
      {pages.hasPrevious ? <ListActionRow label="Previous" onPress={pages.previous} /> : null}
      {next !== null ? <ListActionRow label="Next" onPress={() => pages.next(next)} /> : null}
    </ListSection>
  );
}

interface ProcessingSession {
  readonly selected: AssistantSelection;
  readonly revision: number;
  readonly draft: ProcessingDraft;
}

const PROCESSING_KEY = "memory:configure";

/** Built-in by default. Edits stay bound to the connection and settings revision they opened on. */
function MemoryProcessing({ context }: { readonly context: MobileAgentContext }) {
  const { writer, detail } = context;
  const read = useMemoryRead(context, "configuration");
  const [session, setSession] = useState<ProcessingSession | null>(null);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const pending = writer.pendingKey === PROCESSING_KEY;
  const saved = read.data;
  if (saved === null) return null;

  const configure = (
    selected: AssistantSelection,
    expectedRevision: number,
    configuration: MemoryProcessingConfiguration,
  ) => {
    const current = context.latestSelection();
    return writer.run(
      PROCESSING_KEY,
      assistantsEnvironment.memoryWrite,
      current === null
        ? null
        : prepareAssistantMemoryMutation({
            selected,
            current,
            intent: {
              environmentId: detail.summary.environmentId,
              assistantId: detail.summary.assistantId,
              operation: "configure",
              expectedRevision,
              configuration,
            },
            configurationRevision: saved.revision,
          }),
    );
  };

  const extraction = saved.configuration.extractionRoute;
  const index = saved.configuration.destination;
  const live = context.selection;
  const stale =
    session !== null &&
    (live === null ||
      !assistantSelectionIsCurrent(session.selected, live) ||
      session.revision !== saved.revision);
  const built =
    session === null ? null : processingDraftConfiguration(session.draft, session.selected);
  const draft = session?.draft;
  const set = (next: ProcessingDraft) => {
    if (session !== null) setSession({ ...session, draft: next });
  };
  // Locked while saving, so a successful save never discards later edits.
  const disabled = pending;

  return (
    <ListSection
      title="Memory processing"
      footer={`Built-in by default. External routes send this agent's memory to the services named here, using a key stored on this environment. Settings revision ${saved.revision}.`}
    >
      <WorkBlock>
        <WorkText muted>
          {extraction
            ? `Extraction: ${PROCESSING_PROVIDERS[extraction.provider]} · ${extraction.model}`
            : "Extraction: built-in"}
        </WorkText>
        <WorkText muted>
          {index ? `External index: ${index.embeddingRoute.model}` : "External index: off"}
        </WorkText>
        {session === null && writer.failureFor(PROCESSING_KEY) ? (
          <Notice tone="danger" message={writer.failureFor(PROCESSING_KEY)!} />
        ) : null}
        {stale ? (
          <Notice
            icon="info.circle"
            message="These settings or the connection changed after you started editing. Your edits are kept; cancel to discard them and edit the current version."
          />
        ) : null}
      </WorkBlock>
      {session === null || draft === undefined ? (
        <>
          <ListActionRow
            icon="pencil"
            label="Edit"
            disabled={blocked !== null || writer.pendingKey !== null}
            onPress={() => {
              if (context.selection === null) return;
              setSession({
                selected: context.selection,
                revision: saved.revision,
                draft: processingDraftFrom(saved.configuration),
              });
            }}
          />
          {extraction || index ? (
            <ListActionRow
              label="Use built-in only"
              tone="danger"
              disabled={blocked !== null || writer.pendingKey !== null}
              onPress={() => {
                const selected = context.selection;
                if (selected === null) return;
                const revision = saved.revision;
                confirm(
                  "Use built-in only",
                  "Stop sending this agent's memory to external services. Built-in processing continues.",
                  true,
                  () => void configure(selected, revision, {}),
                );
              }}
            />
          ) : null}
        </>
      ) : (
        <>
          <ListToggleRow
            label="External extraction"
            description="Off uses the agent's own model. On sends chat excerpts to this endpoint."
            value={draft.extraction !== null}
            disabled={disabled}
            onValueChange={(on) =>
              set({
                ...draft,
                extraction: on ? { ...EMPTY_PROCESSING_ROUTE, provider: "command-code" } : null,
              })
            }
          />
          {draft.extraction !== null
            ? (Object.keys(PROCESSING_PROVIDERS) as ExtractionProvider[]).map((provider) => (
                <ListChoiceRow
                  key={provider}
                  label={PROCESSING_PROVIDERS[provider]}
                  selected={draft.extraction?.provider === provider}
                  disabled={disabled}
                  onPress={() =>
                    draft.extraction &&
                    set({ ...draft, extraction: { ...draft.extraction, provider } })
                  }
                />
              ))
            : null}
          {draft.extraction !== null ? (
            <WorkBlock>
              <RouteFields
                route={draft.extraction}
                disabled={disabled}
                onChange={(route) =>
                  draft.extraction &&
                  set({ ...draft, extraction: { ...draft.extraction, ...route } })
                }
              />
            </WorkBlock>
          ) : null}
          <ListToggleRow
            label="External memory index"
            description="Off keeps recall on this environment. On sends memory to this embedding endpoint for indexing."
            value={draft.index !== null}
            disabled={disabled}
            onValueChange={(on) =>
              set({ ...draft, index: on ? { ...EMPTY_PROCESSING_ROUTE, dimensions: "" } : null })
            }
          />
          {draft.index !== null ? (
            <WorkBlock>
              <RouteFields
                route={draft.index}
                disabled={disabled}
                onChange={(route) =>
                  draft.index && set({ ...draft, index: { ...draft.index, ...route } })
                }
              />
              <AgentInput
                label="Dimensions"
                numeric
                maxLength={6}
                value={draft.index.dimensions}
                disabled={disabled}
                onChange={(dimensions) =>
                  draft.index && set({ ...draft, index: { ...draft.index, dimensions } })
                }
              />
            </WorkBlock>
          ) : null}
          <WorkBlock>
            <WorkFormActions
              submitLabel="Save"
              pending={pending}
              disabled={stale || blocked !== null || built === null || "error" in built}
              failure={
                writer.failureFor(PROCESSING_KEY) ??
                (built !== null && "error" in built ? built.error : null)
              }
              onCancel={() => setSession(null)}
              onSubmit={async () => {
                const submitted = session;
                const result = processingDraftConfiguration(submitted.draft, submitted.selected);
                if ("error" in result) return;
                const written = await configure(
                  submitted.selected,
                  submitted.revision,
                  result.configuration,
                );
                if (written !== null) setSession(null);
              }}
            />
          </WorkBlock>
        </>
      )}
    </ListSection>
  );
}

function RouteFields(props: {
  readonly route: ProcessingRouteDraft;
  readonly disabled: boolean;
  readonly onChange: (route: Partial<ProcessingRouteDraft>) => void;
}) {
  return (
    <>
      <AgentInput
        label="Endpoint"
        placeholder="https://…"
        maxLength={2048}
        value={props.route.endpoint}
        disabled={props.disabled}
        onChange={(endpoint) => props.onChange({ endpoint })}
      />
      <AgentInput
        label="Model"
        maxLength={256}
        value={props.route.model}
        disabled={props.disabled}
        onChange={(model) => props.onChange({ model })}
      />
      <AgentInput
        label="Stored secret name"
        maxLength={256}
        value={props.route.secretName}
        disabled={props.disabled}
        onChange={(secretName) => props.onChange({ secretName })}
      />
    </>
  );
}

function RecallPreview({ context }: { readonly context: MobileAgentContext }) {
  const [open, setOpen] = useState(false);
  const preview = useMemoryRead(context, "context", undefined, open);
  return (
    <ListSection title="What it recalls">
      <ListActionRow label={open ? "Hide" : "Show"} onPress={() => setOpen(!open)} />
      {open ? (
        <WorkBlock>
          <WorkText muted>
            {preview.data === null
              ? preview.error
                ? "Recall isn't available."
                : "Loading…"
              : preview.data.text.length === 0
                ? "Nothing is recalled right now."
                : preview.data.text}
          </WorkText>
        </WorkBlock>
      ) : null}
    </ListSection>
  );
}
