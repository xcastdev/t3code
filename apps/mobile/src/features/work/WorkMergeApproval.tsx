import { readProjectWorkPublicationHistory } from "@t3tools/shared/projectWorkPublicationHistory";
import {
  PullRequestDetail,
  ProjectTeamRecord,
  ProjectWorkPublicationRequest,
  canonicalProjectWorkPayload,
  type PullRequestActionInput,
  type PullRequestRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAtomCommand } from "../../state/use-atom-command";
import { mobileWorkEnvironment } from "./workEnvironment";
import {
  reviewMobileWork,
  reviewMobileTaskControl,
  type MobileWorkCurrent,
  type MobileWorkScope,
} from "./workActions";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";

type Publication = NonNullable<ReturnType<typeof readProjectWorkPublicationHistory>>;
type Method = "merge" | "squash" | "rebase";
type Review = {
  readonly publication: Publication;
  readonly detail: ReturnType<typeof mergeDetail>;
  readonly fingerprint: string;
};
export type MobileMergeRequest = {
  readonly owner: MobileWorkScope;
  readonly input: PullRequestActionInput;
  readonly review: Review;
  readonly status: "sending" | "uncertain" | "accepted";
};
export interface MobileMergeStore {
  readonly snapshot: ReadonlyArray<MobileMergeRequest>;
  readonly read: () => ReadonlyArray<MobileMergeRequest>;
  readonly write: (entries: ReadonlyArray<MobileMergeRequest>) => void;
}
const knownRecord = Schema.is(ProjectTeamRecord);
const knownDetail = Schema.is(PullRequestDetail);
const decodePublicationRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectWorkPublicationRequest),
);
const own = (a: MobileWorkScope, b: MobileWorkScope) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.taskId === b.taskId;
function publications(current: MobileWorkCurrent) {
  const review = reviewMobileWork(current);
  if (
    review.reason !== null ||
    new Set(current.foundation.records.map((record) => record.recordId)).size !==
      current.foundation.records.length
  )
    return [];
  return current.foundation.records.filter(knownRecord).flatMap((record) => {
    if (record.kind !== "effect" || record.taskId !== current.taskId) return [];
    const publication = readProjectWorkPublicationHistory(record);
    if (!publication || publication.pullRequest.state !== "OPEN" || !record.payload.summary)
      return [];
    try {
      const request = decodePublicationRequest(record.payload.summary);
      return request.target.specRevision === current.context?.task.specRevision &&
        request.target.planRevision === review.plan?.planRevision
        ? [publication]
        : [];
    } catch {
      return [];
    }
  });
}
function fingerprint(current: MobileWorkCurrent, owner: MobileWorkScope, publication: Publication) {
  if (
    !own(current, owner) ||
    !publications(current).some(
      (entry) => canonicalProjectWorkPayload(entry) === canonicalProjectWorkPayload(publication),
    )
  )
    return null;
  return canonicalProjectWorkPayload({
    revision: current.context?.revision,
    task: current.context?.task,
    publication,
    plan: reviewMobileWork(current).plan,
    membership: reviewMobileWork(current).membership,
  });
}
function mergeDetail(detail: PullRequestDetail) {
  return {
    projectId: detail.projectId,
    repository: detail.repository,
    number: detail.number,
    url: detail.url,
    state: detail.state,
    isDraft: detail.isDraft,
    headRevision: detail.headRevision,
    baseRevision: detail.baseRevision,
    baseBranch: detail.baseBranch,
    headBranch: detail.headBranch,
    capabilities: {
      actions: [...detail.capabilities.actions],
      mergeMethods: [...detail.capabilities.mergeMethods],
    },
    viewerPermissions: { actions: [...detail.viewerPermissions.actions] },
    mergeCapabilities: { ...detail.mergeCapabilities },
  };
}
function samePullRequest(
  detail: ReturnType<typeof mergeDetail>,
  owner: MobileWorkScope,
  publication: Publication,
) {
  const pr = publication.pullRequest;
  return (
    detail.projectId === owner.projectId &&
    detail.repository === publication.repository.nameWithOwner &&
    detail.number === pr.number &&
    detail.url === pr.url &&
    detail.headRevision === pr.headSha &&
    detail.baseRevision === pr.baseSha &&
    detail.baseBranch === pr.baseRef &&
    detail.headBranch === pr.headRef
  );
}
function matches(
  detail: ReturnType<typeof mergeDetail>,
  owner: MobileWorkScope,
  publication: Publication,
) {
  return (
    samePullRequest(detail, owner, publication) &&
    detail.state === "open" &&
    !detail.isDraft &&
    detail.capabilities.actions.includes("merge") &&
    detail.viewerPermissions.actions.includes("merge")
  );
}

/** Replay retains the approved publication, while its own gate/evidence may advance revisions. */
function replayCurrent(current: MobileWorkCurrent, request: MobileMergeRequest) {
  if (!own(current, request.owner) || reviewMobileTaskControl(current).reason !== null)
    return false;
  const original = request.review.publication;
  const candidates = current.foundation.records.filter(knownRecord).flatMap((record) => {
    if (record.kind !== "effect") return [];
    const publication = readProjectWorkPublicationHistory(record);
    return publication &&
      publication.repository.host === original.repository.host &&
      publication.repository.nameWithOwner === original.repository.nameWithOwner &&
      publication.pullRequest.number === original.pullRequest.number
      ? [{ record, publication }]
      : [];
  });
  const retained = candidates[0];
  if (
    candidates.length !== 1 ||
    !retained ||
    retained.record.taskId !== request.owner.taskId ||
    canonicalProjectWorkPayload(retained.publication) !== canonicalProjectWorkPayload(original) ||
    !retained.record.payload.summary
  )
    return false;
  try {
    const target = decodePublicationRequest(retained.record.payload.summary).target;
    return (
      current.context?.task.specRevision === target.specRevision &&
      reviewMobileTaskControl(current).plan?.planRevision === target.planRevision
    );
  } catch {
    return false;
  }
}

export function WorkMergeApprovalSource(
  props: Omit<Parameters<typeof WorkMergeApproval>[0], "readPullRequest" | "send">,
) {
  const read = useAtomQueryRunner(mobileWorkEnvironment.mergePullRequestDetail, {
    refresh: true,
    reportFailure: false,
    reportDefect: false,
  });
  const send = useAtomCommand(mobileWorkEnvironment.mergePullRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  return (
    <WorkMergeApproval
      {...props}
      readPullRequest={async (input) => {
        const result = await read({
          environmentId: props.current.environmentId,
          input: { ...input, allowStale: false },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }}
      send={async (input) => {
        const result = await send({ environmentId: props.current.environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }}
    />
  );
}

/** A human reviews a confirmed publication and current host detail before requesting its merge. */
export function WorkMergeApproval(props: {
  readonly current: MobileWorkCurrent;
  readonly readCurrent: () => MobileWorkCurrent;
  readonly store: MobileMergeStore;
  readonly readPullRequest: (input: PullRequestRef) => Promise<unknown>;
  readonly send: (input: PullRequestActionInput) => Promise<void>;
  readonly onRefresh: () => void;
}) {
  const owner = {
    environmentId: props.current.environmentId,
    projectId: props.current.projectId,
    taskId: props.current.taskId,
  };
  const request = props.store.snapshot.find((entry) => own(entry.owner, owner));
  const [review, setReview] = useState<Review | null>(null);
  const reviewed = useRef<Review | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(false);
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const available = publications(props.current);
  const lastPage = Math.max(0, Math.ceil(available.length / 8) - 1);
  const visiblePage = Math.min(page, lastPage);
  const inputFor = (publication: Publication, method: Method): PullRequestActionInput => ({
    projectId: owner.projectId,
    host: publication.repository.host,
    repository: publication.repository.nameWithOwner,
    number: publication.pullRequest.number,
    action: "merge",
    mergeMethod: method,
  });
  async function inspect(publication: Publication) {
    if (lock.current || !mounted.current || request) return;
    const before = fingerprint(live.current.readCurrent(), owner, publication);
    if (!before) return;
    lock.current = true;
    setLoading(true);
    reviewed.current = null;
    setReview(null);
    try {
      const {
        action: _action,
        mergeMethod: _method,
        ...reference
      } = inputFor(publication, "merge");
      const raw = await live.current.readPullRequest(reference);
      if (!knownDetail(raw)) throw Error("The pull request detail is unsupported.");
      const detail = mergeDetail(raw);
      if (
        !mounted.current ||
        !matches(detail, owner, publication) ||
        fingerprint(live.current.readCurrent(), owner, publication) !== before
      )
        throw Error("The publication or pull request changed. Refresh and review it again.");
      const next = { publication, detail, fingerprint: before };
      reviewed.current = next;
      setReview(next);
      setNotice(null);
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof Error ? error.message : "Current pull request detail is unavailable.",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  async function submit(method: Method, prior?: MobileMergeRequest) {
    const selected = prior?.review ?? reviewed.current;
    if (
      !mounted.current ||
      lock.current ||
      !selected ||
      (!prior && live.current.store.read().some((entry) => own(entry.owner, owner))) ||
      (prior && (prior.status !== "uncertain" || !live.current.store.read().includes(prior)))
    )
      return;
    if (
      prior
        ? !replayCurrent(live.current.readCurrent(), prior)
        : fingerprint(live.current.readCurrent(), owner, selected.publication) !==
            selected.fingerprint ||
          !matches(selected.detail, owner, selected.publication) ||
          !selected.detail.mergeCapabilities[method] ||
          !selected.detail.capabilities.mergeMethods.includes(method)
    ) {
      setNotice("Work changed. Refresh and review before approving a merge.");
      return;
    }
    const captured: MobileMergeRequest = prior ?? {
      owner,
      review: selected,
      input: inputFor(selected.publication, method),
      status: "sending",
    };
    const save = (status: MobileMergeRequest["status"]) =>
      live.current.store.write([
        ...live.current.store.read().filter((entry) => !own(entry.owner, owner)),
        { ...captured, status },
      ]);
    if (!prior && live.current.store.read().length >= 16) {
      setNotice("Local merge recovery is full. Inspect an earlier request first.");
      return;
    }
    lock.current = true;
    save("sending");
    try {
      if (prior) {
        const { action: _action, mergeMethod: _method, ...reference } = captured.input;
        const raw = await live.current.readPullRequest(reference);
        if (
          !mounted.current ||
          !knownDetail(raw) ||
          !samePullRequest(mergeDetail(raw), owner, selected.publication) ||
          (raw.state !== "open" && raw.state !== "merged") ||
          !replayCurrent(live.current.readCurrent(), captured)
        )
          throw Error("The recorded merge target changed. Inspect its result before retrying.");
      }
      await live.current.send(captured.input);
      save("accepted");
      if (mounted.current) {
        setNotice(
          "Merge request recorded. Refresh evidence and the pull request to inspect its outcome.",
        );
        live.current.onRefresh();
      }
    } catch {
      save("uncertain");
      if (mounted.current)
        setNotice(
          "The response was lost or the request was refused. Inspect the result before retrying the exact merge request.",
        );
    } finally {
      lock.current = false;
    }
  }
  const selected = request?.review ?? review;
  const usable =
    selected && fingerprint(props.current, owner, selected.publication) === selected.fingerprint;
  return (
    <WorkCard title="Human merge approval">
      <Notice>
        Review the published pull request and choose a merge method. Approval requests a merge now;
        the server rechecks human authority, exact head, review and evidence. No automatic merge is
        enabled.
      </Notice>
      {notice ? <Notice>{notice}</Notice> : null}
      {available.length === 0 ? (
        <Notice>No current confirmed publication is available for merge review.</Notice>
      ) : null}
      {available.slice(visiblePage * 8, visiblePage * 8 + 8).map((publication) => (
        <WorkButton
          key={publication.operationId}
          disabled={loading || request !== undefined}
          onPress={() => void inspect(publication)}
        >
          Review merge of {publication.repository.nameWithOwner} #{publication.pullRequest.number}
        </WorkButton>
      ))}
      {lastPage > 0 ? (
        <View className="gap-2">
          <WorkButton
            disabled={visiblePage === 0 || loading}
            onPress={() => setPage(visiblePage - 1)}
          >
            Previous publications
          </WorkButton>
          <WorkButton
            disabled={visiblePage === lastPage || loading}
            onPress={() => setPage(visiblePage + 1)}
          >
            Next publications
          </WorkButton>
        </View>
      ) : null}
      {selected ? (
        <View className="gap-2">
          <Notice>
            {selected.publication.repository.host}/{selected.publication.repository.nameWithOwner} #
            {selected.publication.pullRequest.number}
          </Notice>
          <WorkButton
            onPress={() => {
              void tryOpenExternalUrl(selected.publication.pullRequest.url, "pull-request").then(
                (opened) => {
                  if (mounted.current && !opened)
                    setNotice("Could not open the pull request. Try again.");
                },
              );
            }}
          >
            Open published pull request
          </WorkButton>
          <Notice>
            Base {selected.publication.pullRequest.baseRef} ·{" "}
            {selected.publication.pullRequest.baseSha}
          </Notice>
          <Notice>
            Head {selected.publication.pullRequest.headRef} ·{" "}
            {selected.publication.pullRequest.headSha}
          </Notice>
          <Notice>
            Task revision {props.current.context?.task.revision} · specification{" "}
            {props.current.context?.task.specRevision} · project revision{" "}
            {props.current.context?.revision}
          </Notice>
          {!usable && !request ? (
            <Notice>The reviewed work changed. Refresh and review the target again.</Notice>
          ) : null}
          {(["merge", "squash", "rebase"] as const).map((method) => (
            <WorkButton
              key={method}
              disabled={
                !usable ||
                !!request ||
                !selected.detail.mergeCapabilities[method] ||
                !selected.detail.capabilities.mergeMethods.includes(method)
              }
              onPress={() => void submit(method)}
            >
              {method === "merge" ? "Approve merge now" : `Approve ${method} merge now`}
            </WorkButton>
          ))}
          {!request ? (
            <WorkButton
              onPress={() => {
                reviewed.current = null;
                setReview(null);
              }}
            >
              Cancel merge review
            </WorkButton>
          ) : null}
        </View>
      ) : null}
      {request ? (
        <Notice>
          Merge request: {request.status}. Recorded publication history alone does not confirm a
          merge.
        </Notice>
      ) : null}
      {request?.status === "uncertain" ? (
        <WorkButton
          disabled={!replayCurrent(props.current, request)}
          onPress={() => void submit(request.input.mergeMethod ?? "merge", request)}
        >
          Retry exact merge request
        </WorkButton>
      ) : null}
      {request && request.status !== "sending" ? (
        <WorkButton
          onPress={() => {
            if (
              !mounted.current ||
              !live.current.store.read().includes(request) ||
              request.status === "sending"
            )
              return;
            live.current.store.write(
              live.current.store.read().filter((entry) => !own(entry.owner, owner)),
            );
            reviewed.current = null;
            setReview(null);
            setNotice(
              "Local request discarded. Refresh and inspect the recorded result before approving again.",
            );
            live.current.onRefresh();
          }}
        >
          Discard local merge request
        </WorkButton>
      ) : null}
    </WorkCard>
  );
}
