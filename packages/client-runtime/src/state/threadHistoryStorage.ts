import {
  EnvironmentId,
  ThreadHistoryArchiveIdentity,
  ThreadHistoryRecoverInput,
  ThreadHistoryRestoreFilesInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface HistoryOperationTarget extends ThreadHistoryArchiveIdentity {
  readonly environmentId: EnvironmentId;
}

const StoredFile = Schema.Struct({
  input: ThreadHistoryRestoreFilesInput,
  connectionEpoch: Schema.String,
});
const StoredRecovery = Schema.Struct({
  input: ThreadHistoryRecoverInput,
  connectionEpoch: Schema.String,
});
export const HistoryOperationRecord = Schema.Struct({
  file: Schema.NullOr(StoredFile),
  recovery: Schema.NullOr(StoredRecovery),
});
export type HistoryOperationRecord = typeof HistoryOperationRecord.Type;
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  clientSessionId: Schema.String,
  environmentId: EnvironmentId,
  ...ThreadHistoryArchiveIdentity.fields,
  operations: HistoryOperationRecord,
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope));
const encode = Schema.encodeSync(Schema.fromJsonString(Envelope));

export interface HistoryOperationPersistence {
  readonly load: (target: HistoryOperationTarget) => Promise<HistoryOperationRecord>;
  readonly save: (target: HistoryOperationTarget, record: HistoryOperationRecord) => Promise<void>;
}

/** The host supplies localStorage or AsyncStorage; no credentials or archive payloads are stored. */
export function makeHistoryOperationPersistence(options: {
  readonly clientSessionId: string;
  readonly storage: {
    readonly getItem: (key: string) => string | null | Promise<string | null>;
    readonly setItem: (key: string, value: string) => void | Promise<void>;
    readonly removeItem: (key: string) => void | Promise<void>;
  };
}): HistoryOperationPersistence {
  if (options.clientSessionId.length === 0)
    throw new Error("History persistence requires a client session namespace.");
  const key = (target: HistoryOperationTarget) =>
    `t3:history-operations:v1:${JSON.stringify([options.clientSessionId, target.environmentId, target.threadId, target.archiveId])}`;
  const matches = (target: HistoryOperationTarget, input: ThreadHistoryArchiveIdentity) =>
    target.threadId === input.threadId && target.archiveId === input.archiveId;
  return {
    load: async (target) => {
      const raw = await options.storage.getItem(key(target));
      if (raw === null) return { file: null, recovery: null };
      const stored = decode(raw);
      if (
        stored.clientSessionId !== options.clientSessionId ||
        stored.environmentId !== target.environmentId ||
        !matches(target, stored) ||
        (stored.operations.file !== null && !matches(target, stored.operations.file.input)) ||
        (stored.operations.recovery !== null && !matches(target, stored.operations.recovery.input))
      ) {
        throw new Error("Stored history operation belongs to another selection.");
      }
      return stored.operations;
    },
    save: async (target, operations) => {
      if (
        (operations.file !== null && !matches(target, operations.file.input)) ||
        (operations.recovery !== null && !matches(target, operations.recovery.input))
      ) {
        throw new Error("History operation does not match its storage selection.");
      }
      if (operations.file === null && operations.recovery === null) {
        await options.storage.removeItem(key(target));
        return;
      }
      await options.storage.setItem(
        key(target),
        encode({
          version: 1,
          clientSessionId: options.clientSessionId,
          ...target,
          operations,
        }),
      );
    },
  };
}
