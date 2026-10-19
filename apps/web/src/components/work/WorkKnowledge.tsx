import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ProjectWorkKnowledgeId,
  ProjectWorkDecisionId,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkKnowledgeRead,
  type ProjectWorkDecisionRead,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { BookOpenIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { asProjectWorkBriefing, asProjectWorkPage } from "@t3tools/client-runtime/project-work";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { WorkCard, WorkDataNotice } from "./WorkDataNotice";
import { WorkCommandFailureNotice } from "./WorkCommandFailureNotice";
import { projectWorkCommandFailure, type ProjectWorkCommandFailure } from "./workCommandFailure";
import { workReadStatus } from "./workPresentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import {
  makeProjectWorkDecisionCommand,
  makeProjectWorkKnowledgePromoteCommand,
} from "./workMutations";

export function WorkKnowledge(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly canWrite?: boolean;
  readonly streamAvailable?: boolean;
}) {
  return (
    <WorkKnowledgeContent key={JSON.stringify([props.environmentId, props.projectId])} {...props} />
  );
}

function WorkKnowledgeContent({
  environmentId,
  projectId,
  connected,
  canWrite = false,
  streamAvailable = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly canWrite?: boolean;
  readonly streamAvailable?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([0]);
  const [hasMoreByOffset, setHasMoreByOffset] = useState<Readonly<Record<number, boolean>>>({});
  const [showPromote, setShowPromote] = useState(false);
  const [replacement, setReplacement] = useState<ProjectWorkKnowledgeRead | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const trimmedSearch = search.trim();
  const previousSearch = useRef(trimmedSearch);
  const briefingResult = useAtomValue(
    typeof projectWorkEnvironment.briefing === "function"
      ? projectWorkEnvironment.briefing({
          environmentId,
          projectId,
          ...(streamAvailable ? { poll: false } : {}),
        })
      : projectWorkEnvironment.page({
          environmentId,
          projectId,
          collection: "knowledge",
          offset: 0,
        }),
  );
  const projectRevision =
    asProjectWorkBriefing(Option.getOrNull(AsyncResult.value(briefingResult)))?.sourceRevision ??
    null;

  const reportPage = useCallback((offset: number, hasNext: boolean) => {
    setHasMoreByOffset((current) =>
      current[offset] === hasNext ? current : { ...current, [offset]: hasNext },
    );
  }, []);
  const lastOffset = offsets.at(-1) ?? 0;
  const canLoadMore = connected && hasMoreByOffset[lastOffset] === true;

  useEffect(() => {
    if (previousSearch.current === trimmedSearch) return;
    previousSearch.current = trimmedSearch;
    setOffsets([0]);
    setHasMoreByOffset({});
  }, [trimmedSearch]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Knowledge</h2>
          <p className="text-sm text-muted-foreground">
            Durable context promoted from work, threads, and attempts.
          </p>
        </div>
        <label className="relative w-full sm:w-64">
          <span className="sr-only">Search knowledge</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            type="search"
            size="sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this project"
          />
        </label>
        <Button
          size="sm"
          disabled={!canWrite || !connected || editorLocked}
          onClick={() => {
            setReplacement(null);
            setShowPromote((value) => !value);
          }}
        >
          <PlusIcon /> Promote knowledge
        </Button>
      </div>
      {showPromote ? (
        <PromoteKnowledge
          key={replacement?.knowledgeId ?? "new"}
          replacement={replacement}
          onLockedChange={setEditorLocked}
          environmentId={environmentId}
          projectId={projectId}
          projectRevision={projectRevision}
          canWrite={canWrite && connected}
          onDone={() => setShowPromote(false)}
        />
      ) : null}
      <div className="flex min-w-0 flex-col gap-3">
        {offsets.map((offset) => (
          <KnowledgePage
            key={`${environmentId}:${projectId}:knowledge:${offset}`}
            environmentId={environmentId}
            projectId={projectId}
            offset={offset}
            search={search}
            canWrite={canWrite && connected && projectRevision !== null && !editorLocked}
            onReplace={(entry) => {
              setReplacement(entry);
              setShowPromote(true);
            }}
            connected={connected}
            streamAvailable={streamAvailable}
            onPageState={reportPage}
          />
        ))}
      </div>
      {canLoadMore ? (
        <Button
          size="sm"
          variant="outline"
          className="self-center"
          onClick={() =>
            setOffsets((current) => [...current, lastOffset + projectWorkEnvironment.pageSize])
          }
        >
          Load more knowledge
        </Button>
      ) : null}
      <DecisionsPanel
        environmentId={environmentId}
        projectId={projectId}
        projectRevision={projectRevision}
        canWrite={canWrite}
        streamAvailable={streamAvailable}
      />
    </div>
  );
}

function DecisionsPanel({
  environmentId,
  projectId,
  projectRevision,
  canWrite,
  streamAvailable,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectRevision: number | null;
  canWrite: boolean;
  streamAvailable: boolean;
}) {
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });
  const refreshBriefing = useAtomQueryRunner(projectWorkEnvironment.briefing, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [retryCommand, setRetryCommand] = useState<ProjectWorkCommand | null>(null);
  const [offsets, setOffsets] = useState<ReadonlyArray<number>>([0]);
  const [hasMoreByOffset, setHasMoreByOffset] = useState<Readonly<Record<number, boolean>>>({});
  const lastOffset = offsets.at(-1) ?? 0;
  const submit = async (command: ProjectWorkCommand) => {
    setRetryCommand(command);
    setPending(true);
    const response = await write({ environmentId, input: command });
    setPending(false);
    if (response._tag === "Failure") {
      setFailure(projectWorkCommandFailure(squashAtomCommandFailure(response)));
      return;
    }
    setRetryCommand(null);
    setFailure(null);
  };
  const run = async (
    mode: "propose" | "accept" | "reject" | "supersede",
    decisionId?: ProjectWorkDecisionId,
  ) => {
    if (!canWrite || projectRevision === null || pending) return;
    const title =
      mode === "propose" || mode === "supersede"
        ? window.prompt("Decision title")?.trim()
        : undefined;
    const body =
      mode === "propose" || mode === "supersede"
        ? window.prompt("Decision details")?.trim()
        : undefined;
    const reason = mode === "reject" ? window.prompt("Rejection reason")?.trim() : undefined;
    if (
      ((mode === "propose" || mode === "supersede") && (!title || !body)) ||
      (mode === "reject" && !reason)
    )
      return;
    const recordedAt = new Date().toISOString();
    const command = makeProjectWorkDecisionCommand({
      mode,
      projectId,
      expectedRevision: projectRevision,
      commandId: CommandId.make(randomUUID()),
      decisionId: decisionId ?? ProjectWorkDecisionId.make(randomUUID()),
      ...(mode === "supersede"
        ? {
            replacementId: ProjectWorkDecisionId.make(randomUUID()),
            attribution: { actor: { kind: "human" }, source: { kind: "web" }, recordedAt },
          }
        : {}),
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(reason ? { reason } : {}),
      now: recordedAt,
    });
    await submit(command);
  };
  const retry = async () => {
    if (!retryCommand || !canWrite || pending) return;
    await submit(retryCommand);
  };
  const rebase = async () => {
    if (!retryCommand || !canWrite || pending) return;
    const command = retryCommand;
    setPending(true);
    const fresh = await refreshBriefing({
      environmentId,
      projectId,
      ...(streamAvailable ? { poll: false } : {}),
    });
    if (fresh._tag !== "Success") {
      setPending(false);
      return;
    }
    const briefing = asProjectWorkBriefing(fresh.value);
    if (!briefing) {
      setPending(false);
      return;
    }
    await submit({
      ...command,
      commandId: CommandId.make(randomUUID()),
      expectedRevision: briefing.sourceRevision,
    });
  };
  return (
    <section className="mt-4 border-t border-border pt-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Decisions</h2>
          <p className="text-sm text-muted-foreground">
            Accepted decisions are replaced through attributed supersession.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || projectRevision === null || pending}
          onClick={() => void run("propose")}
        >
          Propose decision
        </Button>
      </div>
      <div className="grid gap-3">
        {offsets.map((offset) => (
          <DecisionPage
            key={offset}
            environmentId={environmentId}
            projectId={projectId}
            offset={offset}
            streamAvailable={streamAvailable}
            canWrite={canWrite && projectRevision !== null && !pending}
            onAction={run}
            onPageState={(pageOffset, hasNext) =>
              setHasMoreByOffset((current) =>
                current[pageOffset] === hasNext ? current : { ...current, [pageOffset]: hasNext },
              )
            }
          />
        ))}
      </div>
      {hasMoreByOffset[lastOffset] === true ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() =>
            setOffsets((current) => [...current, lastOffset + projectWorkEnvironment.pageSize])
          }
        >
          Load more decisions
        </Button>
      ) : null}
      {failure ? (
        <WorkCommandFailureNotice
          failure={failure}
          onRetry={() => void retry()}
          onDiscard={() => {
            setRetryCommand(null);
            setFailure(null);
          }}
          onRebase={() => void rebase()}
        />
      ) : null}
    </section>
  );
}

function DecisionPage({
  environmentId,
  projectId,
  offset,
  streamAvailable,
  canWrite,
  onAction,
  onPageState,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  offset: number;
  streamAvailable: boolean;
  canWrite: boolean;
  onAction: (
    mode: "propose" | "accept" | "reject" | "supersede",
    decisionId?: ProjectWorkDecisionId,
  ) => Promise<void>;
  onPageState: (offset: number, hasNext: boolean) => void;
}) {
  const target = {
    environmentId,
    projectId,
    collection: "decisions" as const,
    offset,
    ...(streamAvailable ? { poll: false as const } : {}),
  };
  const result = useAtomValue(projectWorkEnvironment.page(target));
  const value = Option.getOrNull(AsyncResult.value(result));
  const page = value === null ? null : asProjectWorkPage<ProjectWorkDecisionRead>(value, offset);
  const refreshPage = useAtomQueryRunner(projectWorkEnvironment.page, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(
    () => onPageState(offset, page?.hasNext === true),
    [offset, onPageState, page?.hasNext],
  );
  if (page === null) {
    return (
      <WorkDataNotice
        stale={false}
        waiting={result._tag === "Initial" || result.waiting === true}
        error={
          result._tag === "Failure"
            ? projectWorkCommandFailure(squashAtomCommandFailure(result)).message
            : null
        }
        onRetry={() => void refreshPage(target)}
      />
    );
  }
  return page.records.map((decision) => (
    <div key={decision.decisionId}>
      <WorkCard>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium">{decision.title}</h3>
            <p className="mt-2 text-sm">{decision.body}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {decision.state} · revision {decision.revision}
            </p>
          </div>
          {decision.state === "proposed" ? (
            <div className="flex gap-2">
              <Button
                disabled={!canWrite}
                size="sm"
                onClick={() => void onAction("accept", decision.decisionId)}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canWrite}
                onClick={() => void onAction("reject", decision.decisionId)}
              >
                Reject
              </Button>
            </div>
          ) : decision.state === "accepted" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite}
              onClick={() => void onAction("supersede", decision.decisionId)}
            >
              Supersede
            </Button>
          ) : null}
        </div>
      </WorkCard>
    </div>
  ));
}

function KnowledgePage({
  environmentId,
  projectId,
  offset,
  search,
  connected,
  canWrite,
  onReplace,
  streamAvailable,
  onPageState,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly offset: number;
  readonly search: string;
  readonly connected: boolean;
  readonly canWrite: boolean;
  readonly onReplace: (entry: ProjectWorkKnowledgeRead) => void;
  readonly streamAvailable: boolean;
  readonly onPageState: (offset: number, hasNext: boolean) => void;
}) {
  const target = {
    environmentId,
    projectId,
    collection: "knowledge" as const,
    offset,
    ...(streamAvailable ? { poll: false } : {}),
  };
  const needle = search.trim();
  const result = useAtomValue(
    needle === ""
      ? projectWorkEnvironment.page(target)
      : projectWorkEnvironment.search({
          environmentId,
          projectId,
          query: needle,
          recordKinds: ["knowledge"],
          offset,
          ...(streamAvailable ? { poll: false } : {}),
        }),
  );
  const value = Option.getOrNull(AsyncResult.value(result));
  const page =
    needle === "" && value !== null
      ? asProjectWorkPage<ProjectWorkKnowledgeRead>(value, offset)
      : null;
  const searchPage = needle !== "" && value !== null ? asSearchPage(value, offset) : null;
  const status = workReadStatus({ connected, hasValue: page !== null || searchPage !== null });
  const error = result._tag === "Failure" ? String(squashAtomCommandFailure(result)) : null;
  const runPage = useAtomQueryRunner(projectWorkEnvironment.page, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const runSearch = useAtomQueryRunner(projectWorkEnvironment.search, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const retryPage = useCallback(
    () =>
      void (needle === ""
        ? runPage(target)
        : runSearch({
            environmentId,
            projectId,
            query: needle,
            recordKinds: ["knowledge"],
            offset,
            ...(streamAvailable ? { poll: false } : {}),
          })),
    [environmentId, needle, offset, projectId, runPage, runSearch, streamAvailable, target],
  );
  const filtered = page?.records ?? [];

  useEffect(() => {
    onPageState(offset, page?.hasNext === true || searchPage?.hasMore === true);
  }, [offset, onPageState, page?.hasNext, searchPage?.hasMore]);

  return (
    <>
      {offset === 0 || error !== null ? (
        <WorkDataNotice
          stale={status === "stale"}
          waiting={status === "waiting"}
          offline={!connected}
          error={error}
          onRetry={retryPage}
        />
      ) : null}
      {filtered.length > 0 ? (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {filtered.map((entry) => (
            <WorkCard key={entry.knowledgeId}>
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
                  <BookOpenIcon className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium">{entry.title}</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
                    {entry.body}
                  </p>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {entry.sourceKind} · updated {formatDate(entry.updatedAt)}
                    {entry.supersedesKnowledgeId
                      ? ` · Replaces ${entry.supersedesKnowledgeId}`
                      : ""}
                    {filtered.some((record) => record.supersedesKnowledgeId === entry.knowledgeId)
                      ? " · Superseded"
                      : ""}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    disabled={
                      !canWrite ||
                      entry.projectId !== projectId ||
                      filtered.some((record) => record.supersedesKnowledgeId === entry.knowledgeId)
                    }
                    onClick={() => onReplace(entry)}
                  >
                    Correct or replace
                  </Button>
                </div>
              </div>
            </WorkCard>
          ))}
        </div>
      ) : searchPage && searchPage.items.length > 0 ? (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {searchPage.items.map((entry) => (
            <WorkCard key={entry.recordId}>
              <h3 className="font-medium">{entry.title}</h3>
              <p className="mt-2 text-sm leading-6 text-foreground/80">{entry.snippet}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                {entry.recordKind} · revision {entry.revision}
              </p>
            </WorkCard>
          ))}
        </div>
      ) : page && offset === 0 && page.records.length === 0 ? (
        <WorkCard className="py-10 text-center">
          <p className="font-medium">No knowledge promoted yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Knowledge appears here after an explicit promotion from a task, thread, or attempt.
          </p>
        </WorkCard>
      ) : searchPage && offset === 0 ? (
        <WorkCard className="py-10 text-center text-sm text-muted-foreground">
          No knowledge matches “{search}”.
        </WorkCard>
      ) : null}
    </>
  );
}

type SearchHit = {
  recordId: string;
  recordKind: string;
  title: string;
  snippet: string;
  revision: number;
};
function asSearchPage(
  value: unknown,
  offset: number,
): { items: ReadonlyArray<SearchHit>; hasMore: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { items?: unknown; hasMore?: unknown };
  return Array.isArray(candidate.items)
    ? {
        items: candidate.items.slice(
          0,
          projectWorkEnvironment.pageSize,
        ) as ReadonlyArray<SearchHit>,
        hasMore:
          candidate.items.length > projectWorkEnvironment.pageSize || candidate.hasMore === true,
      }
    : {
        items: asProjectWorkPage<SearchHit>(value, offset).records,
        hasMore: asProjectWorkPage<SearchHit>(value, offset).hasNext,
      };
}

function PromoteKnowledge({
  replacement,
  onLockedChange,
  environmentId,
  projectId,
  projectRevision,
  canWrite,
  onDone,
}: {
  replacement: ProjectWorkKnowledgeRead | null;
  onLockedChange: (locked: boolean) => void;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectRevision: number | null;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(replacement?.title ?? "");
  const [body, setBody] = useState(replacement?.body ?? "");
  const [failure, setFailure] = useState<ProjectWorkCommandFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [retryCommand, setRetryCommand] = useState<ProjectWorkCommand | null>(null);
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    onLockedChange(pending || retryCommand !== null);
  }, [onLockedChange, pending, retryCommand]);
  useLayoutEffect(() => () => onLockedChange(false), [onLockedChange]);
  const [rebasedRevision, setRebasedRevision] = useState<number | null>(null);
  const [sourceKind, setSourceKind] = useState<
    "task" | "thread" | "session" | "worktree" | "attempt" | "manual"
  >("manual");
  const [sourceId, setSourceId] = useState("");
  const write = useAtomCommand(projectWorkEnvironment.write, { reportFailure: false });
  const refreshBriefing = useAtomQueryRunner(projectWorkEnvironment.briefing, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const refreshPage = useAtomQueryRunner(projectWorkEnvironment.page, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const authority = useRef({ canWrite, projectRevision, mounted: true, generation: 0 });
  useLayoutEffect(() => {
    if (authority.current.canWrite !== canWrite) authority.current.generation += 1;
    authority.current.canWrite = canWrite;
    authority.current.projectRevision = projectRevision;
  }, [canWrite, projectRevision]);
  useLayoutEffect(() => {
    authority.current.mounted = true;
    return () => {
      authority.current.mounted = false;
    };
  }, []);
  const allowed = (generation = authority.current.generation) =>
    authority.current.mounted &&
    authority.current.canWrite &&
    authority.current.generation === generation;
  const [validationError, setValidationError] = useState<string | null>(null);
  // A visible page cannot establish terminal status: successors may be on later pages.
  const validateReplacement = async (revision: number) => {
    if (!replacement) return true;
    const records: ProjectWorkKnowledgeRead[] = [];
    for (let offset = 0; offset < 256; offset += projectWorkEnvironment.pageSize) {
      const response = await refreshPage({
        environmentId,
        projectId,
        collection: "knowledge",
        offset,
      });
      if (!allowed()) return false;
      if (response._tag !== "Success") break;
      const page = asProjectWorkPage<ProjectWorkKnowledgeRead>(response.value, offset);
      if (page.revision !== revision || page.records.some((entry) => entry.projectId !== projectId))
        break;
      records.push(...page.records);
      if (records.length > 256) break;
      if (page.hasNext) continue;
      if (records.length === 256) {
        setValidationError(
          "No capacity for a replacement: retained history is at the 256-record limit.",
        );
        return false;
      }
      const byId = new Map(records.map((entry) => [entry.knowledgeId, entry]));
      const replaced = new Set<ProjectWorkKnowledgeId>();
      if (byId.size !== records.length) break;
      let valid = true;
      for (const entry of records) {
        if (!entry.supersedesKnowledgeId) continue;
        if (!byId.has(entry.supersedesKnowledgeId) || replaced.has(entry.supersedesKnowledgeId)) {
          valid = false;
          break;
        }
        replaced.add(entry.supersedesKnowledgeId);
        const seen = new Set<ProjectWorkKnowledgeId>([entry.knowledgeId]);
        let previous: ProjectWorkKnowledgeRead | undefined = byId.get(entry.supersedesKnowledgeId);
        while (previous) {
          if (seen.has(previous.knowledgeId)) {
            valid = false;
            break;
          }
          seen.add(previous.knowledgeId);
          previous = previous.supersedesKnowledgeId
            ? byId.get(previous.supersedesKnowledgeId)
            : undefined;
        }
      }
      const selected = byId.get(replacement.knowledgeId);
      if (!valid || !selected) break;
      if (replaced.has(selected.knowledgeId)) {
        setValidationError(
          "This retained knowledge is superseded. Select its current replacement.",
        );
        return false;
      }
      if (
        selected.revision !== replacement.revision ||
        selected.title !== replacement.title ||
        selected.body !== replacement.body
      )
        break;
      return true;
    }
    setValidationError(
      "Cannot confirm current knowledge at this revision. Refresh and select the record again.",
    );
    return false;
  };
  const submit = async () => {
    if (
      !canWrite ||
      inFlight.current ||
      failure?.staleRevision ||
      (!retryCommand && (rebasedRevision ?? projectRevision) === null) ||
      !title.trim() ||
      !body.trim() ||
      !sourceId.trim()
    )
      return;
    inFlight.current = true;
    setPending(true);
    setValidationError(null);
    const generation = authority.current.generation;
    const observedRevision = authority.current.projectRevision;
    const revision = rebasedRevision ?? projectRevision!;
    if ((!retryCommand || failure === null) && !(await validateReplacement(revision))) {
      inFlight.current = false;
      setPending(false);
      return;
    }
    if (
      !allowed(generation) ||
      ((!retryCommand || failure === null) &&
        authority.current.projectRevision !== observedRevision)
    ) {
      inFlight.current = false;
      setPending(false);
      return;
    }
    const recordedAt = new Date().toISOString();
    const command =
      retryCommand ??
      makeProjectWorkKnowledgePromoteCommand({
        projectId,
        expectedRevision: rebasedRevision ?? projectRevision!,
        commandId: CommandId.make(randomUUID()),
        knowledgeId: ProjectWorkKnowledgeId.make(randomUUID()),
        ...(replacement ? { supersedesKnowledgeId: replacement.knowledgeId } : {}),
        title: title.trim(),
        body: body.trim(),
        sourceKind,
        sourceId: sourceId.trim(),
        promotedAt: recordedAt,
      });
    setRetryCommand(command);
    const result = await write({
      environmentId,
      input: command,
    });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Failure")
      setFailure(projectWorkCommandFailure(squashAtomCommandFailure(result)));
    else {
      setRetryCommand(null);
      setRebasedRevision(null);
      onDone();
    }
  };
  const discard = () => {
    setRetryCommand(null);
    setRebasedRevision(null);
    setFailure(null);
    setValidationError(null);
  };
  const rebase = () => {
    if (
      !allowed() ||
      inFlight.current ||
      !retryCommand ||
      (failure !== null && !failure.staleRevision)
    )
      return;
    inFlight.current = true;
    setPending(true);
    const generation = authority.current.generation;
    const observedRevision = authority.current.projectRevision;
    void (async () => {
      const fresh = await refreshBriefing({ environmentId, projectId });
      if (!allowed(generation) || fresh._tag !== "Success") return;
      const briefing = asProjectWorkBriefing(fresh.value);
      if (
        !briefing ||
        !(await validateReplacement(briefing.sourceRevision)) ||
        !allowed(generation) ||
        (authority.current.projectRevision !== observedRevision &&
          authority.current.projectRevision !== briefing.sourceRevision)
      )
        return;
      if (retryCommand) {
        setRetryCommand({
          ...retryCommand,
          commandId: CommandId.make(randomUUID()),
          expectedRevision: briefing.sourceRevision,
        });
      }
      setRebasedRevision(briefing.sourceRevision);
      setFailure(null);
      setValidationError(null);
    })().finally(() => {
      inFlight.current = false;
      setPending(false);
    });
  };
  return (
    <WorkCard>
      <h3 className="font-medium">
        {replacement ? "Correct or replace knowledge" : "Promote manual knowledge"}
      </h3>
      {replacement ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Replacing “{replacement.title}” ({replacement.knowledgeId}). The predecessor remains in
          history. Current status is checked before saving.
        </p>
      ) : null}
      {validationError ? (
        <p role="alert" className="mt-2 text-sm">
          {validationError}
        </p>
      ) : null}
      <div className="mt-3 grid gap-3">
        <Input
          disabled={!canWrite || pending || retryCommand !== null}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title"
        />
        <textarea
          className="min-h-24 rounded-md border border-input bg-background p-2 text-sm"
          disabled={!canWrite || pending || retryCommand !== null}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Durable project context"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Source kind
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={sourceKind}
              onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}
              disabled={!canWrite || pending || retryCommand !== null}
            >
              {(["task", "thread", "session", "worktree", "attempt", "manual"] as const).map(
                (kind) => (
                  <option key={kind}>{kind}</option>
                ),
              )}
            </select>
          </label>
          <label className="text-sm font-medium">
            Source ID
            <Input
              className="mt-1"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
              placeholder="Source record ID"
              disabled={!canWrite || pending || retryCommand !== null}
            />
          </label>
        </div>
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={
            !canWrite ||
            pending ||
            failure !== null ||
            (rebasedRevision ?? projectRevision) === null ||
            !sourceId.trim()
          }
        >
          {replacement ? "Save replacement" : "Promote"}
        </Button>
        {retryCommand && failure === null && !pending ? (
          <fieldset disabled={!canWrite || pending}>
            <p className="text-sm text-muted-foreground">These changes have not been saved.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={rebase}>
                Rebase on latest
              </Button>
              <Button size="sm" variant="ghost" onClick={discard}>
                Discard
              </Button>
            </div>
          </fieldset>
        ) : null}
        {failure ? (
          <fieldset disabled={!canWrite || pending}>
            <WorkCommandFailureNotice
              failure={failure}
              onRetry={() => void submit()}
              onDiscard={discard}
              onRebase={rebase}
            />
          </fieldset>
        ) : null}
      </div>
    </WorkCard>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
