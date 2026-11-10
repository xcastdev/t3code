import {
  SecretRequestError,
  SecretRequestAnswerInput,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestAnswerInput,
} from "./secretRequest.ts";

const decodeAnswer = Schema.decodeUnknownSync(SecretRequestAnswerInput);

it("preserves a native prompt's exact value across the answer RPC", () => {
  const item = {
    id: TurnItemId.make("secret-card"),
    threadId: ThreadId.make("secret-thread"),
    nativeItemRef: {
      driver: ProviderDriverKind.make("omp"),
      nativeId: "prompt",
      strength: "strong" as const,
    },
  };
  const secret = "  private phrase  ";
  const answer = secretRequestAnswerInput(item, { type: "save", secret });
  expect(decodeAnswer(answer)).toMatchObject({
    answer: { type: "save", secret },
  });
});

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
