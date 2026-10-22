import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isProjectWorkHumanCommand,
  prepareProjectWorkDeliveryMutation,
  prepareProjectWorkHumanMutation,
  projectWorkSelectionIsCurrent,
  type ProjectWorkReviewedDeliveryOperation,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import type { ProjectWorkClientRead } from "@t3tools/client-runtime/state/project-work";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ProjectIssueRequest,
  type ProjectWorkDeliveryResult,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectWorkEnvironment } from "../../state/projectWork";
import { describeWorkFailure } from "./workModel";

export const WORK_PAGE_SIZE = 64;
export const newCommandId = () => CommandId.make(uuidv4());

function describeReadFailure(error: unknown): string {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "ProjectWorkRpcError" && "reason" in error && error.reason === "forbidden")
      return "This connection can't read Work for this project.";
    if (error._tag === "EnvironmentAuthorizationError")
      return "This connection lacks permission to read Work on this environment.";
  }
  return "Work isn't available on this environment. It may need a newer T3 Code server.";
}

export function useWorkRead(environmentId: EnvironmentId, input: ProjectWorkClientRead) {
  const atom = projectWorkEnvironment.read({ environmentId, input });
  const view = useAtomValue(atom);
  // Refreshing the read wrapper re-runs its underlying query, including after a failure.
  const retry = useAtomRefresh(atom);
  const error =
    view.result._tag === "Failure"
      ? describeReadFailure(squashAtomCommandFailure(view.result))
      : null;
  return { ...view, error, retry };
}
export type WorkReadView = ReturnType<typeof useWorkRead>;

/** One line that tells the truth about a read: loading, disconnected, failed or stale. */
export function workReadMessage(view: WorkReadView, subject: string): string | null {
  const hasValue = view.value !== null;
  if (view.status === "loading" && !hasValue) return `Loading ${subject}…`;
  if (view.status === "disconnected")
    return hasValue
      ? `Disconnected. Showing the last loaded ${subject}; changes are off.`
      : `Reconnect this environment to load ${subject}.`;
  if (view.error !== null && !hasValue) return view.error;
  if (view.status === "stale") return `${view.label ?? "Work may be stale"}.`;
  return null;
}

// The server replaces this with the authenticated session's attribution.
export const humanAttribution = (now: string) => ({
  actor: { kind: "human" as const },
  source: { kind: "mobile" as const },
  recordedAt: now,
});

export function workWriteBlockedReason(view: WorkReadView, canWrite: boolean): string | null {
  if (view.status === "disconnected") return "Reconnect to make changes.";
  if (!canWrite) return "This connection is not allowed to change Work here.";
  if (view.status !== "ready") return "Waiting for the current revision before changes.";
  return null;
}

/** Same guard as web: every intent is checked against the revision the user reviewed. */
export function useWorkWriter(environmentId: EnvironmentId) {
  const canWrite = useAtomValue(projectWorkEnvironment.write.permissionAtom(environmentId));
  const canIssue = useAtomValue(projectWorkEnvironment.issue.permissionAtom(environmentId));
  // Publishing and merging need both source-control and orchestration grants.
  const canDeliver = useAtomValue(projectWorkEnvironment.delivery.permissionAtom(environmentId));
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const busy = useRef(false);
  const settle = (key: string, error: unknown | null) => {
    busy.current = false;
    setPendingKey(null);
    setFailure(error === null ? null : { key, message: describeWorkFailure(error) });
  };
  const submit = async (
    key: string,
    selected: ProjectWorkSelection,
    current: ProjectWorkSelection,
    intent: unknown,
  ) => {
    if (busy.current) return false;
    const prepared = prepareProjectWorkHumanMutation({ selected, current, intent });
    if (prepared === null) {
      setFailure({
        key,
        message: isProjectWorkHumanCommand(intent)
          ? "This changed after you reviewed it. Check the current revision, then try again."
          : "This client can't send that change yet. Nothing was sent.",
      });
      return false;
    }
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await projectWorkEnvironment.write.run(appAtomRegistry, {
      environmentId,
      input: prepared,
    });
    settle(
      key,
      result._tag === "Success" || isAtomCommandInterrupted(result)
        ? null
        : squashAtomCommandFailure(result),
    );
    return result._tag === "Success";
  };
  const runIssue = async (key: string, request: ProjectIssueRequest): Promise<unknown> => {
    if (busy.current) return null;
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await projectWorkEnvironment.issue.run(appAtomRegistry, {
      environmentId,
      input: request,
    });
    settle(
      key,
      result._tag === "Success" || isAtomCommandInterrupted(result)
        ? null
        : squashAtomCommandFailure(result),
    );
    return result._tag === "Success" ? result.value : null;
  };
  /** Shares the one-at-a-time guard; a failed delivery may still have been applied. */
  const runDelivery = async (
    key: string,
    selected: ProjectWorkSelection,
    current: ProjectWorkSelection,
    request: unknown,
    reviewedOperation?: ProjectWorkReviewedDeliveryOperation,
  ): Promise<ProjectWorkDeliveryResult | null> => {
    if (busy.current) return null;
    const prepared = prepareProjectWorkDeliveryMutation({
      selected,
      current,
      request,
      ...(reviewedOperation === undefined ? {} : { reviewedOperation }),
    });
    if (prepared === null) {
      setFailure({
        key,
        message: "This changed after you reviewed it. Check the current revision, then try again.",
      });
      return null;
    }
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await projectWorkEnvironment.delivery.run(appAtomRegistry, {
      environmentId,
      input: prepared,
    });
    settle(
      key,
      result._tag === "Success" || isAtomCommandInterrupted(result)
        ? null
        : squashAtomCommandFailure(result),
    );
    return result._tag === "Success" ? result.value : null;
  };
  return {
    canWrite,
    canIssue,
    canDeliver,
    pendingKey,
    submit,
    runIssue,
    runDelivery,
    failureFor: (key: string) => (failure?.key === key ? failure.message : null),
  };
}
export type WorkWriter = ReturnType<typeof useWorkWriter>;

/** The revision a form was opened against; a newer revision needs another review. */
export function useWorkReview(current: ProjectWorkSelection, openInitially = false) {
  const [selected, setSelected] = useState<ProjectWorkSelection | null>(
    openInitially ? current : null,
  );
  return {
    selected,
    open: () => setSelected(current),
    close: () => setSelected(null),
    rebase: () => setSelected(current),
    changed: selected !== null && !projectWorkSelectionIsCurrent(selected, current),
  };
}
