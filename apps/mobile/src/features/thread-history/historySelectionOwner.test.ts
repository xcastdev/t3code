import { captureHistorySelection } from "@t3tools/client-runtime/state/thread-history";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createHistorySelectionOwner } from "./historySelectionOwner";

const select = (archiveId: string) =>
  captureHistorySelection({
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    archiveId,
    connectionEpoch: "1",
  });

/** A recovery from `started` resolves later; the sheet may close or replace only if this is non-null. */
async function settleLateRecovery(
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
  it("keeps the archive still on screen current", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(settleLateRecovery(owner, archiveA, () => {})).resolves.toMatchObject({
      archiveId: "archive-a",
    });
  });

  it("drops a late fork after All archives and another archive were opened", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(
      settleLateRecovery(owner, archiveA, () => {
        owner.release();
        owner.activate(select("archive-b"));
      }),
    ).resolves.toBeNull();
  });

  it("drops a late result after the sheet was dismissed and the same archive reopened", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(
      settleLateRecovery(owner, archiveA, () => {
        owner.release();
        owner.activate(select("archive-a"));
      }),
    ).resolves.toBeNull();
  });

  it("refuses Compare workspace and confirmed actions after the connection was replaced", async () => {
    const owner = createHistorySelectionOwner();
    const archiveA = select("archive-a");
    owner.activate(archiveA);
    await expect(settleLateRecovery(owner, archiveA, () => {}, "2")).resolves.toBeNull();
  });
});
