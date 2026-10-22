import type { ExternalNotificationDestination } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  describeTestResult,
  destinationDrafts,
  destinationDraftsChanged,
  destinationDraftsError,
  destinationTestBlocked,
  destinationsPatch,
  newDestinationDraft,
} from "./externalNotificationPresentation.ts";

// The server's redaction marker; the form must hand it back untouched, never display it.
const REDACTED = "••••••";
const saved: ReadonlyArray<ExternalNotificationDestination> = [
  { id: "home", name: "Home", kind: "home-assistant", enabled: true, webhookUrl: REDACTED },
  { id: "spare", name: "Spare", kind: "home-assistant", enabled: false, webhookUrl: "" },
];

it("keeps a stored URL as the redaction marker and never exposes it in the draft", () => {
  const drafts = destinationDrafts(saved);
  expect(drafts[0]!.url).toEqual({ kind: "stored" });
  expect(JSON.stringify(drafts)).not.toContain(REDACTED);
  expect(destinationsPatch(drafts, saved)).toEqual(saved);
  expect(destinationDraftsChanged(drafts, saved)).toBe(false);
});

it("replaces, clears, toggles off and removes destinations explicitly", () => {
  const [home, spare] = destinationDrafts(saved);
  const replaced = destinationsPatch(
    [{ ...home!, url: { kind: "replace", value: " https://ha.local/api/webhook/x " } }],
    saved,
  );
  expect(replaced).toEqual([{ ...saved[0], webhookUrl: "https://ha.local/api/webhook/x" }]);
  expect(destinationsPatch([{ ...home!, url: { kind: "clear" }, enabled: false }], saved)).toEqual([
    { ...saved[0], enabled: false, webhookUrl: "" },
  ]);
  // Removing a destination is the absence of its entry in the replacement array.
  expect(destinationsPatch([spare!], saved)).toEqual([saved[1]]);
});

it("adds new destinations switched off", () => {
  const draft = newDestinationDraft("new");
  expect(draft.enabled).toBe(false);
  expect(destinationsPatch([draft], saved)[0]).toMatchObject({ enabled: false, webhookUrl: "" });
});

it("rejects invalid URLs without echoing them", () => {
  const error = destinationDraftsError([
    { ...newDestinationDraft("x"), url: { kind: "replace", value: "ftp://user:token@host" } },
  ]);
  expect(error).toContain("http or https");
  expect(error).not.toContain("token");
  expect(destinationDraftsError([{ ...newDestinationDraft("x"), name: " " }])).toBe(
    "Give each destination a name.",
  );
});

it("tests only a saved, configured destination with no unsaved edits", () => {
  const [home, spare] = destinationDrafts(saved);
  expect(destinationTestBlocked({ draft: home!, saved, dirty: false })).toBeNull();
  expect(destinationTestBlocked({ draft: home!, saved, dirty: true })).toBe(
    "Save your changes before testing.",
  );
  expect(destinationTestBlocked({ draft: spare!, saved, dirty: false })).toContain(
    "Add a webhook URL",
  );
  expect(
    destinationTestBlocked({ draft: newDestinationDraft("new"), saved, dirty: false }),
  ).toContain("Save this destination");
});

it("reports test outcomes with fixed text", () => {
  expect(describeTestResult({ status: "delivered" })).toEqual({
    delivered: true,
    message: "Test notification delivered.",
  });
  expect(describeTestResult({ status: "failed", reason: "timeout" }).delivered).toBe(false);
  expect(describeTestResult({ status: "failed" }).message).toBe(
    "The test notification wasn't delivered.",
  );
});
