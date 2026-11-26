import {
  DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
  type ExternalNotificationDestination,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  describeTestResult,
  destinationDrafts,
  destinationDraftsChanged,
  destinationDraftsError,
  destinationTestBlocked,
  destinationsPatch,
  newDestinationDraft,
  updateDestinationEditorDraft,
} from "./externalNotificationPresentation.ts";

// The server's redaction marker; the form must hand it back untouched, never display it.
const REDACTED = "••••••";
const saved: ReadonlyArray<ExternalNotificationDestination> = [
  {
    id: "home",
    name: "Home",
    kind: "generic-webhook",
    enabled: true,
    events: ["completion"],
    webhookUrl: REDACTED,
    signingKey: REDACTED,
  },
  {
    id: "spare",
    name: "Spare",
    kind: "generic-webhook",
    enabled: false,
    events: [],
    webhookUrl: "",
  },
];

it("preserves stored credentials and independent filters for destinations of the same kind", () => {
  const drafts = destinationDrafts(saved);
  expect(drafts[0]!.url).toEqual({ kind: "stored" });
  expect(drafts[0]!.signingKey).toEqual({ kind: "stored" });
  expect(drafts.map(({ events }) => events)).toEqual([["completion"], []]);
  expect(JSON.stringify(drafts)).not.toContain(REDACTED);
  expect(destinationsPatch(drafts, saved, true)).toEqual(
    saved.map(({ signingKey: _, ...unchanged }) => ({ ...unchanged, webhookUrl: REDACTED })),
  );
  expect(destinationDraftsChanged(drafts, saved)).toBe(false);
});

it("changes adapter, filters, and signing credentials while preserving the destination ID", () => {
  const [home] = destinationDrafts(saved);
  expect(
    destinationsPatch(
      [
        {
          ...home!,
          name: "Renamed",
          events: [],
          signingKey: { kind: "replace", value: "new key" },
        },
      ],
      saved,
      true,
    ),
  ).toEqual([{ ...saved[0], name: "Renamed", events: [], signingKey: "new key" }]);
  expect(destinationsPatch([{ ...home!, signingKey: { kind: "clear" } }], saved, true)).toEqual([
    { ...saved[0], signingKey: "" },
  ]);
  expect(
    destinationsPatch([{ ...home!, kind: "home-assistant" }], saved, true)[0],
  ).not.toHaveProperty("signingKey");
});

it("replaces, clears, toggles off and removes destinations explicitly", () => {
  const [home, spare] = destinationDrafts(saved);
  const replaced = destinationsPatch(
    [{ ...home!, url: { kind: "replace", value: " https://ha.local/api/webhook/x " } }],
    saved,
    true,
  );
  expect(replaced[0]).toMatchObject({ webhookUrl: "https://ha.local/api/webhook/x" });
  expect(replaced[0]).not.toHaveProperty("signingKey");
  expect(
    destinationsPatch([{ ...home!, url: { kind: "clear" }, enabled: false }], saved, true)[0],
  ).toMatchObject({ enabled: false, webhookUrl: "" });
  // Removing a destination is the absence of its entry in the replacement array.
  expect(destinationsPatch([spare!], saved, true)).toEqual([{ ...saved[1], webhookUrl: REDACTED }]);
  expect(destinationsPatch([spare!], saved, false)).toEqual([saved[1]]);
});

it("adds new destinations switched off", () => {
  const draft = newDestinationDraft("new", "New destination");
  expect(draft.enabled).toBe(false);
  expect(destinationsPatch([draft], saved, true)[0]).toMatchObject({
    enabled: false,
    webhookUrl: "",
  });
});

it("keeps the original revision while editing and drops it when all edits are undone", () => {
  const original = { destinations: saved, revision: "original" };
  const latest = { destinations: [...saved, { ...saved[0]!, id: "new" }], revision: "latest" };
  const [home, spare] = destinationDrafts(saved);
  const edited = updateDestinationEditorDraft(null, original, [
    { ...home!, name: "Edited" },
    spare!,
  ]);
  const editedAgain = updateDestinationEditorDraft(edited, latest, [spare!]);
  expect(editedAgain?.original).toBe(original);
  expect(updateDestinationEditorDraft(editedAgain, latest, [home!, spare!])).toBeNull();
});

it("preserves legacy filters on edits and recognizes an explicit default event list", () => {
  const { events: _, ...base } = saved[1]!;
  const legacy = { ...base, kind: "home-assistant" as const };
  const [draft] = destinationDrafts([legacy]);
  expect(destinationsPatch([{ ...draft!, name: "Renamed" }], [legacy], true)[0]).not.toHaveProperty(
    "events",
  );
  const explicit = { ...draft!, events: DEFAULT_EXTERNAL_NOTIFICATION_EVENTS };
  expect(destinationDraftsChanged([explicit], [legacy])).toBe(true);
  expect(destinationsPatch([explicit], [legacy], true)[0]?.events).toEqual(
    DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
  );
});

it("rejects invalid URLs without echoing them", () => {
  const error = destinationDraftsError([
    {
      ...newDestinationDraft("x", "New destination"),
      url: { kind: "replace", value: "ftp://user:token@host" },
    },
  ]);
  expect(error).toBe("invalid-url");
  expect(
    destinationDraftsError([{ ...newDestinationDraft("x", "New destination"), name: " " }]),
  ).toBe("empty-name");
});

it("tests saved, configured destinations even when disabled and filtered to no events", () => {
  const [home, spare] = destinationDrafts(saved);
  expect(destinationTestBlocked({ draft: home!, saved, dirty: false })).toBeNull();
  expect(destinationTestBlocked({ draft: home!, saved, dirty: true })).toBe("dirty");
  expect(destinationTestBlocked({ draft: spare!, saved, dirty: false })).toBe("missing-url");
  expect(
    destinationTestBlocked({
      draft: spare!,
      saved: [saved[0]!, { ...saved[1]!, webhookUrl: REDACTED }],
      dirty: false,
    }),
  ).toBeNull();
  expect(
    destinationTestBlocked({
      draft: newDestinationDraft("new", "New destination"),
      saved,
      dirty: false,
    }),
  ).toBe("new");
});

it("reports test outcome codes", () => {
  expect(describeTestResult({ status: "delivered" })).toEqual({
    delivered: true,
    message: "delivered",
  });
  expect(describeTestResult({ status: "failed", reason: "timeout" }).delivered).toBe(false);
  expect(describeTestResult({ status: "failed" }).message).toBe("failed");
});
