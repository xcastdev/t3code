import type {
  ChildThreadApproval,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type { RuntimeRequestId } from "@t3tools/contracts";

export type LiveRequest =
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly createdAt: string;
      readonly approval: ThreadPendingApproval;
    }
  | {
      readonly kind: "child-approval";
      readonly key: string;
      readonly createdAt: string;
      readonly entry: ChildThreadApproval;
    }
  | {
      readonly kind: "user-input";
      readonly key: string;
      readonly createdAt: string;
      readonly userInput: ThreadPendingUserInput;
    };

/** Every pending request the live bar can answer, oldest first. */
export function buildLiveRequestQueue(input: {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
  readonly childApprovals: ReadonlyArray<ChildThreadApproval>;
}): ReadonlyArray<LiveRequest> {
  const queue: LiveRequest[] = [
    ...input.approvals.map((approval): LiveRequest => ({
      kind: "approval",
      key: `approval:${approval.requestId}`,
      createdAt: approval.createdAt,
      approval,
    })),
    ...input.userInputs.map((userInput): LiveRequest => ({
      kind: "user-input",
      key: `input:${userInput.requestId}`,
      createdAt: userInput.createdAt,
      userInput,
    })),
    ...input.childApprovals.map((entry): LiveRequest => ({
      kind: "child-approval",
      key: `child:${entry.thread.environmentId}:${entry.thread.threadId}:${entry.approval.requestId}`,
      createdAt: entry.approval.createdAt,
      entry,
    })),
  ];
  const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  // Array sort is stable, so equal times keep own approvals, questions, then child approvals.
  return queue.sort((left, right) => {
    const delta = time(left.createdAt) - time(right.createdAt);
    return Number.isNaN(delta) ? 0 : delta;
  });
}

interface LiveRequestFocus {
  readonly key: string | null;
  /** Where the focused request sat, so resolving it lands on the one that follows. */
  readonly index: number;
}

export const INITIAL_REQUEST_FOCUS: LiveRequestFocus = { key: null, index: 0 };

export function resolveFocusedRequestIndex(
  queue: ReadonlyArray<Pick<LiveRequest, "key">>,
  focus: LiveRequestFocus,
): number {
  if (queue.length === 0) return -1;
  const byKey = focus.key === null ? -1 : queue.findIndex((request) => request.key === focus.key);
  if (byKey !== -1) return byKey;
  return Math.min(Math.max(0, focus.index), queue.length - 1);
}

/** Moves focus by `delta`, holding at the ends. */
export function stepRequestFocus(
  queue: ReadonlyArray<Pick<LiveRequest, "key">>,
  focus: LiveRequestFocus,
  delta: number,
): LiveRequestFocus {
  const current = resolveFocusedRequestIndex(queue, focus);
  if (current === -1) return INITIAL_REQUEST_FOCUS;
  const index = Math.min(Math.max(0, current + delta), queue.length - 1);
  return { key: queue[index]!.key, index };
}

export interface LiveRequestSummary {
  readonly label: string;
  readonly kind: string;
  readonly title: string;
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]!.trim();
}

export function summarizeLiveRequest(request: LiveRequest): LiveRequestSummary {
  if (request.kind === "user-input") {
    const [question] = request.userInput.questions;
    const count = request.userInput.questions.length;
    return {
      label: "Input needed",
      kind: count > 1 ? `${count} questions` : (question?.header ?? ""),
      title: question === undefined ? "Answer the agent" : firstLine(question.question),
    };
  }
  const approval = request.kind === "approval" ? request.approval : request.entry.approval;
  const detail = approval.detail === undefined ? "" : firstLine(approval.detail);
  return {
    label: "Approval needed",
    kind: request.kind === "approval" ? approval.requestKind : `from ${request.entry.title}`,
    title: approval.appName ?? (detail.length > 0 ? detail : approval.requestKind),
  };
}

type ComposerAnswerMode =
  | { readonly kind: "approval-feedback"; readonly approval: ThreadPendingApproval }
  | {
      readonly kind: "custom-answer";
      readonly requestId: RuntimeRequestId;
      readonly questionId: string;
    }
  | null;

/**
 * What the composer does while `request` is expanded: decline its approval with a note, or answer
 * its one single-select question. Several questions keep their own fields in the card.
 */
export function resolveComposerAnswerMode(request: LiveRequest | null): ComposerAnswerMode {
  if (request === null) return null;
  if (request.kind === "approval") {
    return request.approval.supportsFeedback === true &&
      request.approval.responseCapability === "live"
      ? { kind: "approval-feedback", approval: request.approval }
      : null;
  }
  if (request.kind !== "user-input") return null;
  const { questions, requestId, responseCapability } = request.userInput;
  const [question] = questions;
  if (
    questions.length !== 1 ||
    question === undefined ||
    question.multiSelect ||
    question.allowCustomAnswer === false ||
    // A suggested answer is prefilled in the card's own field, where the user can see it.
    question.initialAnswer !== undefined ||
    responseCapability === "not_resumable"
  ) {
    return null;
  }
  return { kind: "custom-answer", requestId, questionId: question.id };
}
