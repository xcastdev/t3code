import { describe, expect, it } from "vite-plus/test";

import {
  DRAFT_MISSING_DETAIL,
  incompleteBodyDetail,
  mustBeDetail,
  REPLAY_DETAILS,
  REPLAY_INPUT_DETAILS,
  replayRefusalOutcome,
  STORAGE_FULL_DETAIL,
} from "./refusals.ts";

describe("replayRefusalOutcome", () => {
  it.each([
    [REPLAY_DETAILS.expired, "maybe-sent"],
    [REPLAY_DETAILS.notIssued, "maybe-sent"],
    [REPLAY_DETAILS.conflict, "maybe-sent"],
    [REPLAY_DETAILS.pendingCap, "not-sent"],
    [REPLAY_DETAILS.sourceMissing, "not-sent"],
    [REPLAY_DETAILS.httpOnly, "not-sent"],
    [STORAGE_FULL_DETAIL, "not-sent"],
    [DRAFT_MISSING_DETAIL, "not-sent"],
    [REPLAY_INPUT_DETAILS.url, "not-sent"],
    [incompleteBodyDetail(10, 20), "not-sent"],
    [mustBeDetail("idempotencyKey", "a string"), "not-sent"],
    ["database is locked", "unconfirmed"],
  ])("%s -> %s", (detail, outcome) => {
    expect(replayRefusalOutcome(detail)).toBe(outcome);
  });
});
