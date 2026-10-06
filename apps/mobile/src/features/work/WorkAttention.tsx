import { useIsFocused, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  ProjectWorkAttentionRead,
  ProjectWorkAttentionReason,
  ProjectWorkBoundedReadEnvelope,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkAttentionSeenCommand,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { publicWorkRejection } from "./workActions";
import { mobileWorkEnvironment } from "./workEnvironment";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";

const isEnvelope = Schema.is(ProjectWorkBoundedReadEnvelope);
const isAttention = Schema.is(ProjectWorkAttentionRead);
const knownReason = Schema.is(ProjectWorkAttentionReason);
type Owner = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
function attentionPage(value: unknown, target: Owner, offset: number) {
  if (
    !isEnvelope(value) ||
    value.projectId !== target.projectId ||
    value.offset !== offset ||
    value.limit !== 51 ||
    value.items.length > 51 ||
    !Number.isSafeInteger(value.revision) ||
    !Number.isSafeInteger(value.offset) ||
    offset > 1_000_000
  )
    return null;
  const ids = new Set<string>();
  const rows: ProjectWorkAttentionRead[] = [];
  for (const item of value.items) {
    if (
      !isAttention(item) ||
      ids.has(item.taskId) ||
      item.taskId.trim() !== item.taskId ||
      item.taskId.length > 256 ||
      item.reason.trim().length === 0 ||
      item.reason.length > 4000 ||
      !Number.isSafeInteger(item.revision) ||
      item.revision > value.revision ||
      ("projectId" in item && item.projectId !== target.projectId) ||
      ("environmentId" in item && item.environmentId !== target.environmentId)
    )
      return null;
    ids.add(item.taskId);
    rows.push(item);
  }
  return {
    revision: value.revision,
    rows: rows.slice(0, 50),
    next: offset < 1_000_000 && (value.hasMore || rows.length > 50) ? offset + 50 : null,
  };
}
function occurrence(row: ProjectWorkAttentionRead) {
  return JSON.stringify([
    row.taskId,
    row.revision,
    row.reason,
    row.detail,
    row.seenAt,
    row.resolvedAt,
  ]);
}
type Review = {
  readonly row: ProjectWorkAttentionRead;
  readonly revision: number;
  readonly occurrence: string;
};

/** Acknowledgment keeps the task attention unresolved and never starts task work. */
export function WorkAttention(props: {
  readonly target: Owner;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly writesSupported: boolean;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const [offset, setOffset] = useState(0);
  const [showResolved, setShowResolved] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<typeof ProjectWorkAttentionSeenCommand.Type | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  const latest = useRef({ props, focused, offset, review, pending, uncertain, busy });
  useLayoutEffect(() => {
    latest.current = { props, focused, offset, review, pending, uncertain, busy };
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const atom = props.supported
    ? mobileWorkEnvironment.page({
        ...props.target,
        collection: "attention",
        offset,
        poll: props.connected && focused,
      })
    : null;
  const query = useEnvironmentQuery(atom);
  const page = attentionPage(query.data, props.target, offset);
  const [cached, setCached] = useState<{
    readonly value: unknown;
    readonly offset: number;
    readonly at: string;
  } | null>(null);
  if (page !== null && cached?.value !== query.data) {
    const result = atom === null ? null : appAtomRegistry.get(atom);
    setCached({
      value: query.data,
      offset,
      at:
        result?._tag === "Success" ? new Date(result.timestamp).toISOString() : "Unknown read age",
    });
  }
  const retained =
    query.data === null && cached?.offset === offset
      ? attentionPage(cached.value, props.target, offset)
      : page;
  const current = props.supported ? retained : null;
  const visible = useRef(current);
  useLayoutEffect(() => {
    visible.current = current;
  });
  const write = useAtomCommand(mobileWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  const access = (writing: boolean) => {
    const now = latest.current;
    if (!alive.current || !now.props.supported || !now.focused || !navigation.isFocused())
      return false;
    const presentation = appAtomRegistry.get(
      environmentPresentations.presentationAtom(props.target.environmentId),
    );
    const project = appAtomRegistry.get(environmentProjects.projectAtom(props.target));
    return (
      project?.id === props.target.projectId &&
      project.environmentId === props.target.environmentId &&
      presentation?.entry.enabled === true &&
      presentation.serverConfig?.settings.projectWorkEnabled === true &&
      presentation.serverConfig.environment.capabilities.projectTeamFoundationReads === true &&
      (!writing ||
        (now.props.connected &&
          now.props.writesSupported &&
          presentation.connection.phase === "connected" &&
          presentation.serverConfig.environment.capabilities.projectTeamGuidedWrites === true))
    );
  };
  const retainedOccurrence = (row: ProjectWorkAttentionRead) => {
    if (atom === null) return false;
    const value = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(atom)));
    const snapshot =
      value === null ? visible.current : attentionPage(value, props.target, latest.current.offset);
    return snapshot?.rows.some((item) => occurrence(item) === occurrence(row)) === true;
  };
  const fresh = () => {
    if (atom === null || !access(true)) return null;
    const result = appAtomRegistry.get(atom);
    return result._tag === "Success" && !result.waiting
      ? attentionPage(result.value, props.target, latest.current.offset)
      : null;
  };
  const submit = async () => {
    const now = latest.current;
    if (now.busy || !access(true)) return;
    let input = now.pending;
    if (input === null) {
      const snapshot = fresh();
      const selected = now.review;
      const row = snapshot?.rows.find((item) => item.taskId === selected?.row.taskId);
      if (
        selected === null ||
        snapshot === null ||
        row === undefined ||
        snapshot.revision !== selected.revision ||
        occurrence(row) !== selected.occurrence ||
        row.seenAt ||
        row.resolvedAt ||
        !knownReason(row.reason)
      ) {
        setMessage("Task attention changed. Review the current occurrence before marking it seen.");
        setReview(null);
        return;
      }
      input = Object.freeze({
        type: "project-work.attention.seen",
        projectId: props.target.projectId,
        taskId: row.taskId,
        expectedRevision: selected.revision,
        commandId: CommandId.make(uuidv4()),
        seenAt: new Date().toISOString(),
      });
      setPending(input);
    }
    // Claim synchronously so a held callback cannot send twice before React commits.
    latest.current = { ...now, busy: true, pending: input };
    setBusy(true);
    try {
      const result = await write({ environmentId: props.target.environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!alive.current) return;
      setPending(null);
      setUncertain(false);
      setReview(null);
      setMessage("Task attention marked seen. Resolution is unchanged; no task work was started.");
      if (access(true)) query.refresh();
    } catch (error) {
      if (!alive.current) return;
      const rejection = publicWorkRejection(error);
      if (now.uncertain || rejection === null) {
        setUncertain(true);
        setMessage(
          "Acknowledgment outcome is unknown. Retry keeps the original command and occurrence.",
        );
      } else {
        setPending(null);
        setReview(null);
        setMessage(
          rejection.status === "stale"
            ? "Task attention changed. Refresh and review before marking it seen."
            : rejection.notice,
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const writable = props.connected && props.supported && props.writesSupported && focused;
  return (
    <WorkCard title="Task attention">
      <Notice>
        Mark seen acknowledges this occurrence only. It does not resolve the task or a question, or
        start task work.
      </Notice>
      {!props.supported ? (
        <Notice>Task attention reads are unavailable for this project or server.</Notice>
      ) : null}
      {!props.connected && props.supported ? (
        <Notice>Disconnected · cached task attention; acknowledgment is unavailable.</Notice>
      ) : null}
      {props.supported && cached?.offset === offset ? (
        <Notice>
          Last recorded attention read: {cached.at}
          {!props.connected || query.error || query.isPending || query.data === null
            ? " · cached"
            : ""}
        </Notice>
      ) : null}
      {query.error ? <Notice>{query.error}</Notice> : null}
      {query.isPending ? <Notice>Refreshing task attention…</Notice> : null}
      {props.supported && query.data !== null && page === null ? (
        <Notice>This server returned an unsupported or ambiguous attention page.</Notice>
      ) : null}
      {current?.rows
        .filter((row) => showResolved || !row.resolvedAt)
        .map((row) => (
          <View key={row.taskId} className="gap-2 border-t border-border pt-3">
            <Text className="font-t3-medium text-foreground">
              {row.taskId} · {row.reason}
            </Text>
            {row.detail ? (
              <Text selectable className="text-sm text-foreground">
                {row.detail}
              </Text>
            ) : null}
            <Notice>
              {row.resolvedAt
                ? `Resolved ${row.resolvedAt}`
                : row.seenAt
                  ? `Seen ${row.seenAt} · unresolved`
                  : "Unseen · unresolved"}
              {knownReason(row.reason) ? "" : " · unsupported attention reason"}
            </Notice>
            <WorkButton
              onPress={() => {
                if (access(false) && retainedOccurrence(row))
                  navigation.navigate("WorkTask", {
                    environmentId: String(props.target.environmentId),
                    projectId: String(props.target.projectId),
                    taskId: String(row.taskId),
                  });
              }}
            >
              Open attention task {row.taskId}
            </WorkButton>
            {!row.seenAt && !row.resolvedAt && knownReason(row.reason) ? (
              <WorkButton
                disabled={!writable || query.isPending || busy || pending !== null}
                onPress={() => {
                  if (!access(true) || latest.current.busy || latest.current.pending !== null)
                    return;
                  const snapshot = fresh();
                  const value = snapshot?.rows.find((item) => item.taskId === row.taskId);
                  if (!value || !snapshot || occurrence(value) !== occurrence(row)) {
                    setMessage(
                      "Task attention changed. Refresh and review the current occurrence.",
                    );
                    return;
                  }
                  setReview({
                    row: value,
                    revision: snapshot.revision,
                    occurrence: occurrence(value),
                  });
                  setMessage(null);
                }}
              >
                Review task attention {row.taskId}
              </WorkButton>
            ) : null}
          </View>
        ))}
      {current?.rows.filter((row) => showResolved || !row.resolvedAt).length === 0 ? (
        <Notice>No unresolved task attention on this page.</Notice>
      ) : null}
      {props.supported ? (
        <View className="flex-row flex-wrap gap-2">
          <WorkButton onPress={() => setShowResolved((value) => !value)}>
            {showResolved ? "Hide resolved attention" : "Show resolved attention"}
          </WorkButton>
          <WorkButton
            disabled={offset === 0 || busy || pending !== null || query.isPending}
            onPress={() => {
              if (access(false)) {
                setReview(null);
                setOffset(Math.max(0, offset - 50));
              }
            }}
          >
            Previous attention
          </WorkButton>
          <WorkButton
            disabled={current?.next == null || busy || pending !== null || query.isPending}
            onPress={() => {
              if (access(false) && current?.next != null) {
                setReview(null);
                setOffset(current.next);
              }
            }}
          >
            Next attention
          </WorkButton>
          <WorkButton
            disabled={!writable || busy}
            onPress={() => {
              if (access(true)) query.refresh();
            }}
          >
            Refresh task attention
          </WorkButton>
        </View>
      ) : null}
      <Notice>Attention page {Math.floor(offset / 50) + 1}</Notice>
      {review ? (
        <Notice>
          Review {review.row.taskId} · occurrence revision {review.row.revision} · project revision{" "}
          {review.revision}
        </Notice>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      {review || pending ? (
        <WorkButton
          disabled={!writable || busy}
          onPress={() => {
            void submit();
          }}
        >
          {uncertain ? "Retry task attention acknowledgment" : "Mark task attention seen"}
        </WorkButton>
      ) : null}
      {review && pending === null ? (
        <WorkButton
          onPress={() => {
            setReview(null);
            setMessage(null);
          }}
        >
          Cancel task attention review
        </WorkButton>
      ) : null}
    </WorkCard>
  );
}
