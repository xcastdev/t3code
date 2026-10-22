import { captureHistorySelection } from "@t3tools/client-runtime/state/thread-history";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createHistorySelectionOwner } from "./historySelectionOwner";

const select = (archiveId: string, threadId = "thread-1", connectionEpoch = "1") =>
  captureHistorySelection({
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make(threadId),
    archiveId,
    connectionEpoch,
  });

/** A fork from `started` resolves later; the caller may close or navigate only if this is non-null. */
async function settleLateFork(
  owner: ReturnType<typeof createHistorySelectionOwner>,
  started: ReturnType<typeof select>,
  meanwhile: () => void,
  liveEpoch = "1",
) {
  let resolve = () => {};
  const pending = new Promise<void>((settle) => {
    resolve = settle;
  }).then(() => owner.currentFor(started, liveEpoch));
  meanwhile();
  resolve();
  return pending;
}

describe("createHistorySelectionOwner", () => {
  it("lets a result from the selection still on screen close and navigate", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(settleLateFork(owner, archiveA, () => {})).resolves.toMatchObject({
      archiveId: "archive-a",
      connectionEpoch: "1",
    });
  });

  it("drops a late fork result after the user picked another archive", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(
      settleLateFork(owner, archiveA, () => owner.activate(select("archive-b"))),
    ).resolves.toBeNull();
  });

  it("drops a late result after History closed and reopened on the same archive", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(
      settleLateFork(owner, archiveA, () => {
        owner.release();
        owner.activate(select("archive-a"));
      }),
    ).resolves.toBeNull();
  });

  it("refuses a confirmed dispatch once the connection was replaced", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(settleLateFork(owner, archiveA, () => {}, "2")).resolves.toBeNull();
    expect(owner.currentFor(archiveA, null)).toBeNull();
  });
});
