import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isProjectWorkHumanCommand,
  prepareProjectWorkDeliveryMutation,
  prepareProjectWorkHumanMutation,
  type ProjectWorkReviewedDeliveryOperation,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectIssueRequest,
  ProjectWorkDeliveryResult,
} from "@t3tools/contracts";
import { useContext, useRef, useState } from "react";

import { projectWorkEnvironment } from "../../state/projectWork";
import { describeWorkFailure } from "./workModel";

export const STALE_SELECTION_MESSAGE =
  "This changed after you reviewed it. Check the current revision, then try again.";
export const UNSUPPORTED_CHANGE_MESSAGE =
  "This client can't send that change yet. Nothing was sent.";

export interface WorkWriteFailure {
  readonly key: string;
  readonly message: string;
}

/**
 * One serialized writer per Work page. Every intent passes the shared
 * currentness guard against the revision the user reviewed before it is sent;
 * the server checks authority and revisions again.
 */
export function useWorkWriter(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(projectWorkEnvironment.write.permissionAtom(environmentId));
  const canIssue = useAtomValue(projectWorkEnvironment.issue.permissionAtom(environmentId));
  // Publishing and merging need both source-control and orchestration grants.
  const canDeliver = useAtomValue(projectWorkEnvironment.delivery.permissionAtom(environmentId));
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<WorkWriteFailure | null>(null);
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
  ): Promise<boolean> => {
    if (busy.current) return false;
    const prepared = prepareProjectWorkHumanMutation({ selected, current, intent });
    if (prepared === null) {
      setFailure({
        key,
        message: isProjectWorkHumanCommand(intent)
          ? STALE_SELECTION_MESSAGE
          : UNSUPPORTED_CHANGE_MESSAGE,
      });
      return false;
    }
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await projectWorkEnvironment.write.run(registry, {
      environmentId,
      input: prepared,
    });
    if (result._tag === "Success") {
      settle(key, null);
      return true;
    }
    settle(key, isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result));
    return false;
  };

  const runIssue = async (key: string, request: ProjectIssueRequest): Promise<unknown> => {
    if (busy.current) return null;
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await projectWorkEnvironment.issue.run(registry, {
      environmentId,
      input: request,
    });
    if (result._tag === "Success") {
      settle(key, null);
      return result.value;
    }
    settle(key, isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result));
    return null;
  };

  /** Delivery shares the page's one-at-a-time guard; a failure may still have been applied. */
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
      setFailure({ key, message: STALE_SELECTION_MESSAGE });
      return null;
    }
    busy.current = true;
    setPendingKey(key);
    setFailure(null);
    const result = await projectWorkEnvironment.delivery.run(registry, {
      environmentId,
      input: prepared,
    });
    if (result._tag === "Success") {
      settle(key, null);
      return result.value;
    }
    settle(key, isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result));
    return null;
  };

  return {
    canWrite,
    canIssue,
    canDeliver,
    runDelivery,
    pendingKey,
    failure,
    submit,
    runIssue,
    failureFor: (key: string) => (failure?.key === key ? failure.message : null),
    dismiss: () => setFailure(null),
  };
}

export type WorkWriter = ReturnType<typeof useWorkWriter>;
