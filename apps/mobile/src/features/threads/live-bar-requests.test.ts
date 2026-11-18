import type {
  ChildThreadApproval,
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildLiveRequestQueue,
  INITIAL_REQUEST_FOCUS,
  resolveComposerAnswerMode,
  resolveFocusedRequestIndex,
  stepRequestFocus,
  summarizeLiveRequest,
} from "./live-bar-requests";

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

function approval(id: string, second: number, extra: Partial<ThreadPendingApproval> = {}) {
  return {
    requestId: id as RuntimeRequestId,
    requestKind: "command",
    createdAt: at(second),
    responseCapability: "live",
    ...extra,
  } satisfies ThreadPendingApproval;
}

function question(extra: Partial<ThreadUserInputQuestion> = {}): ThreadUserInputQuestion {
  return {
    id: "q1",
    header: "Runner",
    question: "Which test runner should cover clamp?\nMore detail",
    options: [{ label: "Vitest", description: "Already set up" }],
    multiSelect: false,
    ...extra,
  };
}

function userInput(
  id: string,
  second: number,
  questions: ReadonlyArray<ThreadUserInputQuestion> = [question()],
): ThreadPendingUserInput {
  return {
    requestId: id as RuntimeRequestId,
    createdAt: at(second),
    questions,
    responseCapability: "live",
    dismissible: false,
  };
}

function childApproval(id: string, second: number): ChildThreadApproval {
  return {
    thread: { environmentId: "env" as EnvironmentId, threadId: "side" as ThreadId },
    title: "Side chat",
    approval: approval(id, second),
  };
}

describe("buildLiveRequestQueue", () => {
  it("orders own, child and input requests by when they were asked", () => {
    const queue = buildLiveRequestQueue({
      approvals: [approval("a2", 3), approval("a1", 1)],
      userInputs: [userInput("i1", 2)],
      childApprovals: [childApproval("c1", 0)],
    });
    expect(queue.map((request) => request.key)).toEqual([
      "child:env:side:c1",
      "approval:a1",
      "input:i1",
      "approval:a2",
    ]);
  });
});

describe("request focus", () => {
  const queue = [{ key: "a" }, { key: "b" }, { key: "c" }];

  it("steps between requests and holds at the ends", () => {
    const second = stepRequestFocus(queue, INITIAL_REQUEST_FOCUS, 1);
    expect(second).toEqual({ key: "b", index: 1 });
    expect(stepRequestFocus(queue, second, -5)).toEqual({ key: "a", index: 0 });
    expect(stepRequestFocus(queue, { key: "c", index: 2 }, 1)).toEqual({ key: "c", index: 2 });
  });

  it("advances to the next request when the focused one resolves", () => {
    const focus = { key: "b", index: 1 };
    expect(resolveFocusedRequestIndex([{ key: "a" }, { key: "c" }], focus)).toBe(1);
    expect(resolveFocusedRequestIndex([{ key: "a" }], { key: "c", index: 2 })).toBe(0);
    expect(resolveFocusedRequestIndex([], focus)).toBe(-1);
  });

  it("follows a request that moved when an earlier one resolved", () => {
    expect(resolveFocusedRequestIndex([{ key: "b" }, { key: "c" }], { key: "c", index: 2 })).toBe(
      1,
    );
  });
});

describe("summarizeLiveRequest", () => {
  it("names approvals by app or detail, and questions by their first line", () => {
    const [own, input, child] = buildLiveRequestQueue({
      approvals: [approval("a", 0, { detail: "vp test run\nsrc/math.test.ts" })],
      userInputs: [userInput("i", 1)],
      childApprovals: [childApproval("c", 2)],
    });
    expect(summarizeLiveRequest(own!)).toEqual({
      label: "Approval needed",
      kind: "command",
      title: "vp test run",
    });
    expect(summarizeLiveRequest(input!)).toEqual({
      label: "Input needed",
      kind: "Runner",
      title: "Which test runner should cover clamp?",
    });
    expect(summarizeLiveRequest(child!)).toMatchObject({ kind: "from Side chat" });
  });
});

describe("resolveComposerAnswerMode", () => {
  const only = (request: Parameters<typeof buildLiveRequestQueue>[0]) =>
    buildLiveRequestQueue(request)[0] ?? null;
  const none = { approvals: [], userInputs: [], childApprovals: [] };

  it("declines with a note only for a live approval that takes feedback", () => {
    expect(
      resolveComposerAnswerMode(
        only({ ...none, approvals: [approval("a", 0, { supportsFeedback: true })] }),
      ),
    ).toMatchObject({ kind: "approval-feedback" });
    expect(resolveComposerAnswerMode(only({ ...none, approvals: [approval("a", 0)] }))).toBe(null);
    expect(
      resolveComposerAnswerMode(
        only({
          ...none,
          approvals: [
            approval("a", 0, { supportsFeedback: true, responseCapability: "not_resumable" }),
          ],
        }),
      ),
    ).toBe(null);
    expect(
      resolveComposerAnswerMode(only({ ...none, childApprovals: [childApproval("c", 0)] })),
    ).toBe(null);
  });

  it("answers one single-select question that allows free text", () => {
    expect(resolveComposerAnswerMode(only({ ...none, userInputs: [userInput("i", 0)] }))).toEqual({
      kind: "custom-answer",
      requestId: "i",
      questionId: "q1",
    });
    for (const questions of [
      [question({ multiSelect: true })],
      [question({ allowCustomAnswer: false })],
      [question({ initialAnswer: "Vitest" })],
      [question(), question({ id: "q2" })],
    ]) {
      expect(
        resolveComposerAnswerMode(only({ ...none, userInputs: [userInput("i", 0, questions)] })),
      ).toBe(null);
    }
  });
});
