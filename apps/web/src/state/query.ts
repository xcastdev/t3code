import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isEnvironmentSubscriptionSnapshotCurrent,
  type EnvironmentSubscriptionSnapshot,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);
const EMPTY_SUBSCRIPTION_SNAPSHOT_ATOM = Atom.make<EnvironmentSubscriptionSnapshot<never>>({
  generation: 0,
  snapshotGeneration: null,
  value: null,
}).pipe(Atom.withLabel("web-environment-query:empty-subscription-snapshot"));

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  subscriptionSnapshotAtom: Atom.Atom<EnvironmentSubscriptionSnapshot<A>> | null = null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const snapshot = useAtomValue(subscriptionSnapshotAtom ?? EMPTY_SUBSCRIPTION_SNAPSHOT_ATOM);
  const refresh = useAtomRefresh(selectedAtom);
  const currentSnapshot =
    subscriptionSnapshotAtom !== null && isEnvironmentSubscriptionSnapshotCurrent(snapshot);
  const error = result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
  return {
    data:
      subscriptionSnapshotAtom === null
        ? Option.getOrNull(AsyncResult.value(result))
        : snapshot.value,
    error,
    isPending:
      atom !== null &&
      (subscriptionSnapshotAtom === null ? result.waiting : !currentSnapshot && error === null),
    isSuccess: subscriptionSnapshotAtom === null ? result._tag === "Success" : currentSnapshot,
    refresh,
  };
}
