import { expect, it } from "@effect/vitest";
import { CheckpointId, CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { makeHistoryOperationPersistence } from "./threadHistoryStorage.ts";

it("qualifies retained requests by client session, environment, thread and archive across adapter recreation", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const target = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    archiveId: "archive",
  };
  const input = {
    threadId: target.threadId,
    archiveId: target.archiveId,
    checkpointId: CheckpointId.make("checkpoint"),
    commandId: CommandId.make("exact-command"),
  };
  const original = {
    file: { input, connectionEpoch: "old-connection" },
    recovery: null,
  };
  await makeHistoryOperationPersistence({
    clientSessionId: "client",
    storage,
  }).save(target, original);
  const reopened = makeHistoryOperationPersistence({
    clientSessionId: "client",
    storage,
  });
  expect(await reopened.load(target)).toEqual(original);
  for (const foreign of [
    { ...target, environmentId: EnvironmentId.make("foreign") },
    { ...target, threadId: ThreadId.make("foreign") },
    { ...target, archiveId: "foreign" },
  ])
    expect(await reopened.load(foreign)).toEqual({
      file: null,
      recovery: null,
    });
  expect(
    await makeHistoryOperationPersistence({
      clientSessionId: "other-client",
      storage,
    }).load(target),
  ).toEqual({ file: null, recovery: null });
  const key = [...values.keys()][0]!;
  values.set(
    key,
    JSON.stringify({
      version: 1,
      clientSessionId: "client",
      ...target,
      operations: {
        ...original,
        file: { ...original.file, input: { ...input, archiveId: "tampered" } },
      },
    }),
  );
  await expect(reopened.load(target)).rejects.toThrow("another selection");
  expect(values.has(key)).toBe(true);
});
