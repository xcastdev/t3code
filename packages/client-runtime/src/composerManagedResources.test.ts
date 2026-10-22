import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createComposerInsertionGuard } from "./composerManagedResources.ts";

function liveComposer() {
  const live = {
    ownerKey: "thread:a",
    target: { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("p") },
    providerInstanceId: "codex" as string | null,
    draft: "/rev src/a.ts",
    cursor: 4,
    selection: { start: 4, end: 4 },
  };
  const guard = createComposerInsertionGuard();
  const read = () => ({ ...live, selection: { ...live.selection } });
  return { live, guard, begin: () => guard.begin(read) };
}

describe("createComposerInsertionGuard", () => {
  it("lands when nothing moved during the fetch", () => {
    const { begin } = liveComposer();
    const pending = begin();
    expect(pending?.isCurrent()).toBe(true);
  });

  it("rejects after a selection extends from the unchanged caret", () => {
    const { live, guard, begin } = liveComposer();
    const pending = begin();
    // Shift+Right: the editor reports a new selection end and nothing else.
    live.selection = { start: 4, end: 5 };
    expect(pending?.isCurrent()).toBe(false);
    // Collapsing back does not revive it once the client cancelled on the change.
    guard.cancel();
    live.selection = { start: 4, end: 4 };
    expect(pending?.isCurrent()).toBe(false);
  });

  it("rejects after a provider switch, including switching back", () => {
    const { live, guard, begin } = liveComposer();
    const pending = begin();
    live.providerInstanceId = "claude";
    expect(pending?.isCurrent()).toBe(false);
    guard.cancel();
    live.providerInstanceId = "codex";
    expect(pending?.isCurrent()).toBe(false);
  });

  it("lets only the newest selection land", () => {
    const { begin } = liveComposer();
    const first = begin();
    const second = begin();
    expect(first?.isCurrent()).toBe(false);
    expect(second?.isCurrent()).toBe(true);
  });
});
