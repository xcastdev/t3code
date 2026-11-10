import { describe, expect, it } from "vite-plus/test";

import {
  DRAFT_MISSING_DETAIL,
  EXPORT_DETAILS,
  incompleteBodyDetail,
  invalidHostPatternDetail,
  isInvalidHostPatternDetail,
  isNoDefaultProxyDetail,
  MISSING_DETAILS,
  mustBeDetail,
  noDefaultProxyDetail,
  NSS_DETAILS,
  PROXY_DETAILS,
  RECORDING_DETAILS,
  REPLAY_DETAILS,
  REPLAY_INPUT_DETAILS,
  replayRefusalOutcome,
  STORAGE_FULL_DETAIL,
} from "./refusals.ts";

describe("replayRefusalOutcome", () => {
  it.each<readonly [string, ReturnType<typeof replayRefusalOutcome>]>([
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
    // Proxy, recording, export, and certificate refusals never come from replay_request.
    ...[
      ...Object.values(PROXY_DETAILS),
      ...Object.values(RECORDING_DETAILS),
      ...Object.values(EXPORT_DETAILS),
      ...Object.values(NSS_DETAILS),
      MISSING_DETAILS.proxy,
      MISSING_DETAILS.recording,
      MISSING_DETAILS.export,
      MISSING_DETAILS.target,
      noDefaultProxyDetail([]),
      invalidHostPatternDetail("a b", "spaces are not allowed"),
    ].map((detail) => [detail, "unconfirmed"] as const),
  ])("%s -> %s", (detail, outcome) => {
    expect(replayRefusalOutcome(detail)).toBe(outcome);
  });
});

describe("proxy refusal details", () => {
  it.each([
    [[], "No proxy is linked to this thread or its project. No proxies exist. Call create_proxy."],
    [
      [
        { proxyId: "4", name: "Parent", link: "parentThread" },
        { proxyId: "2", name: "Root", link: "rootThread" },
        { proxyId: "1", name: "Default", link: null },
      ],
      "No proxy is linked to this thread or its project. Pass proxyId. Candidates: 4 (Parent, linked to the parent thread), 2 (Root, linked to the root thread), 1 (Default).",
    ],
  ] as const)("noDefaultProxyDetail(%j)", (candidates, detail) => {
    expect(noDefaultProxyDetail(candidates)).toBe(detail);
    expect(isNoDefaultProxyDetail(detail)).toBe(true);
  });

  it("lists at most 20 candidates and stays under the 1024-character detail cap", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      proxyId: String(index + 1),
      name: "n".repeat(64),
      link: null,
    }));
    const detail = noDefaultProxyDetail(candidates);
    expect(detail.length).toBeLessThanOrEqual(1024);
    expect(detail).toMatch(/, …\.$/);
  });

  it("an invalid host pattern detail names the pattern and is recognisable", () => {
    const detail = invalidHostPatternDetail("a b", "spaces are not allowed");
    expect(detail).toBe('Invalid host pattern "a b": spaces are not allowed');
    expect(isInvalidHostPatternDetail(detail)).toBe(true);
    expect(isInvalidHostPatternDetail(PROXY_DETAILS.limit)).toBe(false);
  });
});
