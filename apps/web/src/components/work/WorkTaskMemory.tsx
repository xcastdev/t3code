import {
  projectWorkSelectionIsCurrent,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import type {
  CommandId,
  ProjectId,
  ProjectMemorySourceRead,
  ProjectTeamMemorySourceSelector,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorkEmpty, WorkFormStatus, WorkMeta, WorkRow, WorkSection, WorkTime } from "./WorkLayout";
import { WorkNotice, WorkReviewChanged } from "./WorkNotice";
import { useWorkRead } from "./useWorkRead";
import { workStateLabel } from "./workModel";
import {
  makeMemoryPromoteIntent,
  makeMemoryRetractIntent,
  makeMemorySharesIntent,
  MEMORY_SOURCE_STATUS,
  MEMORY_STATUS,
  memorySelector,
  memoryShareRecipients,
  sameMemorySelector,
  scannedPageState,
  sharedSourceSelection,
} from "./workPresentation";
import { newCommandId, teamFields, useWorkReview, type WorkTaskSurface } from "./workTaskSurface";

const MEMORY_PAGE = 16;
const SHARED_PAGE = 8;

/**
 * Team memory for this task: what is remembered, where it came from, and the
 * controls to forget or share it. Stored text stays usable when indexing is down.
 */
export function WorkTaskMemory({ surface }: { surface: WorkTaskSurface }) {
  const { scope, context } = surface;
  const taskId = context.task.taskId;
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState<{
    text: string;
    shared?: ProjectTeamMemorySourceSelector;
  } | null>(null);
  const cursor = cursors.at(-1);
  const [sharedCursors, setSharedCursors] = useState<ReadonlyArray<string>>([]);
  const sharedCursor = sharedCursors.at(-1);
  const sharedView = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-shared-sources",
    taskId,
    limit: SHARED_PAGE,
    ...(sharedCursor === undefined ? {} : { cursor: sharedCursor }),
  });
  const sharedPage =
    sharedView.special?.operation === "memory-shared-sources" ? sharedView.special.value : null;
  // A grant that changed since it was chosen is not searched with the old selector.
  const sharedState = sharedSourceSelection(query?.shared, sharedPage?.items ?? []);
  const sharedList =
    sharedPage === null ? "hidden" : scannedPageState(sharedPage, sharedCursors.length > 0);
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    taskId,
    limit: MEMORY_PAGE,
    ...(query === null || sharedState === "changed"
      ? { operation: "memory-current" as const }
      : {
          operation: "memory-recall" as const,
          query: query.text,
          ...(query.shared === undefined ? {} : { sharedSource: query.shared }),
        }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const page =
    view.special?.operation === "memory-current" || view.special?.operation === "memory-recall"
      ? view.special.value
      : null;
  const notice = page === null ? undefined : MEMORY_STATUS[page.status];
  const search = (next: typeof query) => {
    setCursors([]);
    setQuery(next);
  };

  return (
    <WorkSection
      title="Memory"
      description="What the team remembers from this project. Forgetting hides it from all future recall."
      actions={<MemoryConfiguration surface={surface} />}
    >
      <WorkRow className="gap-2">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            search(draft.trim() === "" ? null : { text: draft.trim() });
          }}
        >
          <Input
            size="sm"
            aria-label="Search memory"
            placeholder="Search memory"
            maxLength={8192}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button size="sm" variant="outline" type="submit">
            Search
          </Button>
          {query !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft("");
                search(null);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
        {sharedState === "current" ? (
          <WorkMeta>Searching memory shared from another project.</WorkMeta>
        ) : null}
        {sharedState === "changed" ? (
          <WorkMeta className="text-warning-foreground">
            That shared source changed since you chose it. Choose it again below to search it.
          </WorkMeta>
        ) : null}
        {notice ? (
          <WorkMeta>
            <span className="font-medium">{notice.label}.</span> {notice.detail}
          </WorkMeta>
        ) : null}
      </WorkRow>
      {page === null ? (
        <WorkRow>
          <WorkNotice view={view} subject="memory" />
          {view.status === "ready" ? (
            <WorkMeta>Memory isn't available on this environment.</WorkMeta>
          ) : null}
        </WorkRow>
      ) : page.items.length === 0 ? (
        <WorkEmpty title={query === null ? "Nothing remembered yet" : "No matches"} />
      ) : (
        page.items.map((source) => (
          <MemoryRow key={source.recordId} surface={surface} source={source} />
        ))
      )}
      {page !== null && (cursors.length > 0 || page.nextCursor !== undefined) ? (
        <WorkRow className="flex-row justify-end gap-1.5 py-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={cursors.length === 0}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={page.nextCursor === undefined}
            onClick={() =>
              page.nextCursor !== undefined && setCursors([...cursors, page.nextCursor])
            }
          >
            Next
          </Button>
        </WorkRow>
      ) : null}
      <MemorySources surface={surface} />
      <MemoryObservations surface={surface} />
      {sharedPage !== null && sharedList !== "hidden" ? (
        <SharedSources
          items={sharedPage.items}
          emptyScanned={sharedList === "empty-scanned"}
          chosen={query?.shared}
          canSearch={draft.trim() !== ""}
          onSearch={(shared) => search({ text: draft.trim(), shared })}
          hasPrevious={sharedCursors.length > 0}
          onPrevious={() => setSharedCursors(sharedCursors.slice(0, -1))}
          {...(sharedPage.nextCursor === undefined
            ? {}
            : { onNext: () => setSharedCursors([...sharedCursors, sharedPage.nextCursor!]) })}
        />
      ) : (
        <WorkNotice view={sharedView} subject="shared memory" />
      )}
    </WorkSection>
  );
}

interface MemoryConfirmation {
  readonly mode: "forget" | "share";
  /** The project revision and exact source the user opened this confirmation on. */
  readonly selected: ProjectWorkSelection;
  readonly source: ProjectMemorySourceRead;
}

function MemoryRow({
  surface,
  source,
}: {
  surface: WorkTaskSurface;
  source: ProjectMemorySourceRead;
}) {
  const { writer } = surface;
  const [opened, setOpened] = useState<MemoryConfirmation | null>(null);
  const [recipients, setRecipients] = useState("");
  const key = `memory:${source.recordId}`;
  const blocked = surface.blocked;
  const open = (mode: MemoryConfirmation["mode"]) =>
    setOpened({ mode, selected: surface.current, source });
  // Sends only what was reviewed; a moved project or source needs another look first.
  const moved =
    opened !== null &&
    (!projectWorkSelectionIsCurrent(opened.selected, surface.current) ||
      !sameMemorySelector(memorySelector(opened.source), memorySelector(source)));
  const finalBlocked = blocked ?? (moved ? "Review the current version first." : null);
  const send = async (
    build: (
      base: { commandId: CommandId; projectId: ProjectId; expectedRevision: number },
      reviewed: ProjectMemorySourceRead,
    ) => unknown,
  ) => {
    if (opened === null || finalBlocked !== null) return;
    const base = {
      commandId: newCommandId(),
      projectId: surface.scope.projectId,
      expectedRevision: opened.selected.revision,
    };
    const sent = await writer.submit(
      key,
      opened.selected,
      surface.current,
      build(base, opened.source),
    );
    if (sent) setOpened(null);
  };
  const shareList = memoryShareRecipients(recipients, surface.scope.projectId);
  const busy = writer.pendingKey !== null;
  return (
    <WorkRow className="gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{workStateLabel(source.sourceKind)}</Badge>
        {source.status !== "current" ? (
          <Badge variant="warning">{workStateLabel(source.status)}</Badge>
        ) : null}
        <WorkMeta>
          <WorkTime value={source.updatedAt} />
        </WorkMeta>
        <span className="min-w-0 flex-1" />
        {opened === null ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={blocked !== null || busy}
              title={blocked ?? undefined}
              onClick={() => open("share")}
            >
              Share…
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={blocked !== null || busy}
              title={blocked ?? undefined}
              onClick={() => open("forget")}
            >
              Forget…
            </Button>
          </>
        ) : null}
      </div>
      <p className="line-clamp-4 text-sm whitespace-pre-wrap break-words">{source.content}</p>
      {opened !== null && moved ? (
        <WorkReviewChanged
          onReview={() => setOpened({ ...opened, selected: surface.current, source })}
        />
      ) : null}
      {opened?.mode === "forget" ? (
        <div className="flex flex-wrap items-center gap-2">
          <WorkMeta className="flex-1">
            Forgetting hides this from recall now and removes derived copies. It can't be undone;
            add it again as new evidence if needed.
          </WorkMeta>
          <Button
            size="xs"
            variant="destructive"
            disabled={finalBlocked !== null || busy}
            title={finalBlocked ?? undefined}
            onClick={() => void send((base, reviewed) => makeMemoryRetractIntent(base, reviewed))}
          >
            {writer.pendingKey === key ? "Forgetting…" : "Forget"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setOpened(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {opened?.mode === "share" ? (
        <div className="flex flex-col gap-2">
          <Input
            size="sm"
            aria-label="Project IDs to share with"
            placeholder="Project IDs, separated by commas"
            value={recipients}
            onChange={(event) => setRecipients(event.target.value)}
          />
          <WorkMeta>Sharing replaces the full list. Share with nobody to stop sharing.</WorkMeta>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              disabled={shareList.length === 0 || finalBlocked !== null || busy}
              title={finalBlocked ?? undefined}
              onClick={() =>
                void send((base, reviewed) => makeMemorySharesIntent(base, reviewed, shareList))
              }
            >
              Share with {shareList.length} {shareList.length === 1 ? "project" : "projects"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={finalBlocked !== null || busy}
              title={finalBlocked ?? undefined}
              onClick={() =>
                void send((base, reviewed) => makeMemorySharesIntent(base, reviewed, []))
              }
            >
              Stop sharing
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setOpened(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <WorkFormStatus message={writer.failureFor(key)} />
    </WorkRow>
  );
}

/** Task records that can become memory, and whether each was processed. Processing is explicit. */
function MemorySources({ surface }: { surface: WorkTaskSurface }) {
  const { scope, context, writer } = surface;
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <WorkRow>
        <div>
          <Button size="xs" variant="ghost" aria-expanded={false} onClick={() => setOpen(true)}>
            What can be remembered
          </Button>
        </div>
      </WorkRow>
    );
  return (
    <MemorySourceList
      surface={surface}
      onClose={() => setOpen(false)}
      key={`${scope.projectId}:${context.task.taskId}`}
      writerBusy={writer.pendingKey !== null}
    />
  );
}

function MemorySourceList({
  surface,
  onClose,
  writerBusy,
}: {
  surface: WorkTaskSurface;
  onClose: () => void;
  writerBusy: boolean;
}) {
  const { scope, context, writer } = surface;
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const cursor = cursors.at(-1);
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-sources",
    taskId: context.task.taskId,
    limit: MEMORY_PAGE,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const page = view.special?.operation === "memory-sources" ? view.special.value : null;
  const blocked = surface.blocked;
  return (
    <WorkRow className="gap-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium">What can be remembered</p>
        <Button size="xs" variant="ghost" aria-expanded onClick={onClose}>
          Hide
        </Button>
      </div>
      <WorkNotice view={view} subject="memory sources" />
      {page !== null && page.status !== "available" ? (
        <WorkMeta>{MEMORY_STATUS[page.status]?.detail}</WorkMeta>
      ) : null}
      {page?.items.length === 0 ? (
        <WorkMeta>No comments, evidence or decisions to remember yet.</WorkMeta>
      ) : null}
      {page?.items.map((item) => {
        const status = MEMORY_SOURCE_STATUS[item.status] ?? {
          label: item.status,
          tone: "secondary" as const,
        };
        const key = `memory:process:${item.selection.retainedId}`;
        const canProcess = item.status === "waiting" || item.status === "uncertain";
        return (
          <div
            key={`${item.selection.kind}:${item.selection.retainedId}`}
            className="flex flex-wrap items-center gap-2"
          >
            <Badge variant="outline">{workStateLabel(item.selection.kind)}</Badge>
            <Badge variant={status.tone}>{status.label}</Badge>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {item.reason ?? ""}
            </span>
            {canProcess ? (
              <Button
                size="xs"
                variant="outline"
                disabled={page.status === "disabled" || blocked !== null || writerBusy}
                title={blocked ?? undefined}
                onClick={() =>
                  void writer.submit(key, surface.current, surface.current, {
                    ...teamFields(surface, surface.current),
                    type: "project-team.memory.process",
                    selection: item.selection,
                  })
                }
              >
                {writer.pendingKey === key
                  ? "Queuing…"
                  : item.status === "uncertain"
                    ? "Check again"
                    : "Remember"}
              </Button>
            ) : null}
            <WorkFormStatus message={writer.failureFor(key)} />
          </div>
        );
      })}
      {page !== null && (cursors.length > 0 || page.nextCursor !== undefined) ? (
        <div className="flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={cursors.length === 0}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={page.nextCursor === undefined}
            onClick={() =>
              page.nextCursor !== undefined && setCursors([...cursors, page.nextCursor])
            }
          >
            Next
          </Button>
        </div>
      ) : null}
    </WorkRow>
  );
}

/** Grants other projects made to this one; only an exact chosen grant is ever searched. */
function SharedSources(props: {
  items: ReadonlyArray<{
    readonly owner: ProjectTeamMemorySourceSelector["owner"];
    readonly selection: ProjectTeamMemorySourceSelector;
  }>;
  chosen: ProjectTeamMemorySourceSelector | undefined;
  canSearch: boolean;
  onSearch: (shared: ProjectTeamMemorySourceSelector) => void;
  /** This page's grants were all filtered out, but later grants remain to check. */
  emptyScanned: boolean;
  hasPrevious: boolean;
  onPrevious: () => void;
  onNext?: () => void;
}) {
  return (
    <WorkRow className="gap-1.5">
      <p className="text-sm font-medium">Shared with this project</p>
      {props.items.length === 0 ? (
        <WorkMeta>
          {props.emptyScanned
            ? "None of the shared sources checked on this page are current. Next checks more."
            : "No more shared sources."}
        </WorkMeta>
      ) : null}
      {props.items.map((item) => {
        const searching =
          props.chosen !== undefined && sameMemorySelector(props.chosen, item.selection);
        return (
          <div key={item.selection.sourceRecordId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              From{" "}
              {item.owner.kind === "project" ? `project ${item.owner.projectId}` : "an assistant"}
            </span>
            {searching ? <Badge variant="info">Searching</Badge> : null}
            <Button
              size="xs"
              variant="ghost"
              disabled={!props.canSearch}
              title={props.canSearch ? undefined : "Type a search above first"}
              onClick={() => props.onSearch(item.selection)}
            >
              Search it
            </Button>
          </div>
        );
      })}
      {props.hasPrevious || props.onNext !== undefined ? (
        <div className="flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.hasPrevious}
            onClick={props.onPrevious}
          >
            Previous
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={props.onNext === undefined}
            onClick={props.onNext}
          >
            Next
          </Button>
        </div>
      ) : null}
    </WorkRow>
  );
}

/** Facts extracted from this task's sources. Saving one as knowledge is an explicit step. */
function MemoryObservations({ surface }: { surface: WorkTaskSurface }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <WorkRow>
        <div>
          <Button size="xs" variant="ghost" aria-expanded={false} onClick={() => setOpen(true)}>
            Remembered facts
          </Button>
        </div>
      </WorkRow>
    );
  return <ObservationList surface={surface} onClose={() => setOpen(false)} />;
}

function ObservationList({ surface, onClose }: { surface: WorkTaskSurface; onClose: () => void }) {
  const { scope, context } = surface;
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const cursor = cursors.at(-1);
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-observations",
    taskId: context.task.taskId,
    limit: MEMORY_PAGE,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const page = view.special?.operation === "memory-observations" ? view.special.value : null;
  return (
    <WorkRow className="gap-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium">Remembered facts</p>
        <Button size="xs" variant="ghost" aria-expanded onClick={onClose}>
          Hide
        </Button>
      </div>
      <WorkNotice view={view} subject="remembered facts" />
      {page?.items.length === 0 ? <WorkMeta>No facts extracted on this page.</WorkMeta> : null}
      {page?.items.map((observation) => (
        <ObservationRow
          key={observation.observationId}
          surface={surface}
          observation={observation}
        />
      ))}
      {page !== null && (cursors.length > 0 || page.nextCursor !== undefined) ? (
        <div className="flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={cursors.length === 0}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={page.nextCursor === undefined}
            onClick={() =>
              page.nextCursor !== undefined && setCursors([...cursors, page.nextCursor])
            }
          >
            Next
          </Button>
        </div>
      ) : null}
    </WorkRow>
  );
}

type Observation = {
  readonly observationId: string;
  readonly revision: number;
  readonly sourceRevision: number;
  readonly body: string;
  readonly quote: string;
};

function ObservationRow({
  surface,
  observation,
}: {
  surface: WorkTaskSurface;
  observation: Observation;
}) {
  const { writer } = surface;
  const review = useWorkReview(surface.current);
  const [reviewed, setReviewed] = useState<Observation | null>(null);
  const [title, setTitle] = useState("");
  const key = `memory:promote:${observation.observationId}`;
  const moved =
    reviewed !== null &&
    (reviewed.revision !== observation.revision ||
      reviewed.sourceRevision !== observation.sourceRevision);
  const blocked = surface.model.blockedReason ?? surface.blocked;
  const finalBlocked =
    blocked ?? (review.changed || moved ? "Review the current version first." : null);
  const send = async () => {
    if (review.selected === null || reviewed === null || finalBlocked !== null) return;
    const sent = await writer.submit(
      key,
      review.selected,
      surface.current,
      makeMemoryPromoteIntent(teamFields(surface, review.selected), reviewed, {
        knowledgeId: randomUUID(),
        title,
      }),
    );
    if (sent) {
      review.close();
      setReviewed(null);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2 first:border-t-0 first:pt-0">
      <p className="text-sm whitespace-pre-wrap break-words">{observation.body}</p>
      {observation.quote !== "" ? (
        <WorkMeta className="line-clamp-2">“{observation.quote}”</WorkMeta>
      ) : null}
      {review.selected === null ? (
        <div>
          <Button
            size="xs"
            variant="ghost"
            disabled={blocked !== null || writer.pendingKey !== null}
            title={blocked ?? undefined}
            onClick={() => {
              setReviewed(observation);
              review.open();
            }}
          >
            Save as knowledge…
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {review.changed || moved ? (
            <WorkReviewChanged
              onReview={() => {
                setReviewed(observation);
                review.rebase();
              }}
            />
          ) : null}
          <Input
            size="sm"
            aria-label="Knowledge title"
            placeholder="Title"
            maxLength={4000}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <WorkMeta>
            Saved knowledge keeps a link to this fact and the source it came from.
          </WorkMeta>
          <div className="flex gap-2">
            <Button
              size="xs"
              disabled={title.trim() === "" || finalBlocked !== null || writer.pendingKey !== null}
              title={finalBlocked ?? undefined}
              onClick={() => void send()}
            >
              {writer.pendingKey === key ? "Saving…" : "Save as knowledge"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                review.close();
                setReviewed(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <WorkFormStatus message={writer.failureFor(key)} />
    </div>
  );
}

/** Built-in extraction is the default; external routes only run when configured here. */
function MemoryConfiguration({ surface }: { surface: WorkTaskSurface }) {
  const { scope, writer } = surface;
  const view = useWorkRead(scope.environmentId, {
    projectId: scope.projectId,
    operation: "memory-configuration",
  });
  const config = view.special?.operation === "memory-configuration" ? view.special.value : null;
  if (config === null) return null;
  const external =
    config.configuration.extractionRoute !== undefined ||
    config.configuration.destination !== undefined;
  const key = "memory:configure";
  return (
    <div className="flex items-center gap-1.5">
      <Badge variant="outline">{external ? "External processing" : "Built-in processing"}</Badge>
      {external ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={surface.blocked !== null || writer.pendingKey !== null}
          title={
            writer.failureFor(key) ?? surface.blocked ?? "Stop sending memory to external services"
          }
          onClick={() =>
            void writer.submit(key, surface.current, surface.current, {
              type: "project-team.memory.configure",
              commandId: newCommandId(),
              projectId: scope.projectId,
              expectedRevision: surface.current.revision,
              owner: { kind: "project", projectId: scope.projectId },
              ownerRevision: 0,
              expectedConfigurationRevision: config.revision,
              configuration: {},
            })
          }
        >
          Use built-in only
        </Button>
      ) : null}
    </div>
  );
}
