import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { ProjectWorkClientRead } from "@t3tools/client-runtime/state/project-work";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { projectWorkEnvironment } from "../../state/projectWork";
import { useWorkRead } from "./useWork";
import {
  combineWorkPages,
  pageWindow,
  retainCompleteWorkSet,
  type WorkRecordSet,
} from "./workLogic";

const CHAIN_PAGE = 128;
/** 2048 records: past this a set is reported as truncated, never as complete. */
export const WORK_CHAIN_MAX_PAGES = 16;

type ChainInput = Pick<ProjectWorkClientRead, "projectId" | "operation" | "taskId" | "recordKind">;

const chainFamily = Atom.family((key: string) => {
  const [environmentId, input] = JSON.parse(key) as [EnvironmentId, ChainInput];
  // The refresh callback cannot read atoms, so it retries the pages the last read used.
  let used: Array<ReturnType<typeof projectWorkEnvironment.read>> = [];
  return Atom.readable(
    (get): WorkRecordSet => {
      used = [];
      const pages = [];
      let offset = 0;
      for (let index = 0; index < WORK_CHAIN_MAX_PAGES; index++) {
        const atom = projectWorkEnvironment.read({
          environmentId,
          input: { ...input, limit: CHAIN_PAGE, offset },
        });
        used.push(atom);
        const view = get(atom);
        pages.push({
          status: view.status,
          failed: view.result._tag === "Failure",
          page: view.page,
        });
        if (view.page === null || !view.page.hasMore || view.page.nextOffset === null) break;
        offset = view.page.nextOffset;
      }
      return retainCompleteWorkSet(
        Option.getOrNull(get.self<WorkRecordSet>()),
        combineWorkPages(pages, WORK_CHAIN_MAX_PAGES),
      );
    },
    (refresh) => {
      for (const atom of used) refresh(atom);
    },
  ).pipe(Atom.setIdleTTL(0));
});

/**
 * Every record of one filtered collection at a single revision, or an explicit
 * incomplete/truncated state. Membership and current approvals are only
 * derived from a complete set.
 */
export function useWorkRecords(environmentId: EnvironmentId, input: ChainInput) {
  const atom = chainFamily(
    JSON.stringify([
      environmentId,
      {
        projectId: input.projectId,
        operation: input.operation,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.recordKind === undefined ? {} : { recordKind: input.recordKind }),
      },
    ]),
  );
  const set = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  return { ...set, retry };
}
export type WorkRecordsView = ReturnType<typeof useWorkRecords>;

/** Why a record set can't back a decision yet, or null when it is complete and current. */
export function workRecordsBlockedReason(set: WorkRecordSet, subject: string): string | null {
  if (set.truncated)
    return `There are more ${subject} than Work can check at once, so changes that depend on them are off.`;
  if (set.status === "disconnected") return "Reconnect to make changes.";
  if (!set.complete) return set.failed ? `Couldn't load ${subject}.` : `Loading ${subject}…`;
  if (set.status !== "ready") return `Waiting for current ${subject} before changes.`;
  return null;
}

/** One bounded window of a collection with Next/Previous; the offset survives revisions. */
export function useWorkPage(
  environmentId: EnvironmentId,
  input: Omit<ProjectWorkClientRead, "limit" | "offset">,
  pageSize: number,
) {
  const [offset, setOffset] = useState(0);
  const view = useWorkRead(environmentId, { ...input, limit: pageSize, offset });
  const shown = view.page?.items.length ?? 0;
  const window = pageWindow(offset, shown, pageSize, view.page?.hasMore ?? false);
  return {
    view,
    offset,
    window,
    next: () => window.nextOffset !== null && setOffset(window.nextOffset),
    previous: () => window.previousOffset !== null && setOffset(window.previousOffset),
  };
}
export type WorkPageView = ReturnType<typeof useWorkPage>;
