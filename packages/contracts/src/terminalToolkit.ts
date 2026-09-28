import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TerminalResizeInput, TerminalWriteInput } from "./terminal.ts";

const TerminalToolkitId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const TerminalTitle = Schema.String.check(Schema.isMaxLength(128));
const TerminalCommand = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(8_192))
  .check(
    Schema.makeFilter((value) =>
      value.includes("\u0000") ? "Command contains a NUL byte." : undefined,
    ),
  );
const TerminalArgument = Schema.String.check(Schema.isMaxLength(8_192)).check(
  Schema.makeFilter((value) =>
    value.includes("\u0000") ? "Argument contains a NUL byte." : undefined,
  ),
);
const TerminalArguments = Schema.Array(TerminalArgument).check(Schema.isMaxLength(128));
const TerminalEnvKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(
  Schema.isMaxLength(128),
);
const TerminalEnvValue = Schema.String.check(Schema.isMaxLength(8_192)).check(
  Schema.makeFilter((value) =>
    value.includes("\u0000") ? "Environment value contains a NUL byte." : undefined,
  ),
);
const TerminalLaunchEnvironment = Schema.Record(TerminalEnvKey, TerminalEnvValue).check(
  Schema.isMaxProperties(128),
);
const TerminalCols = TerminalResizeInput.fields.cols;
const TerminalRows = TerminalResizeInput.fields.rows;
const TerminalData = TerminalWriteInput.fields.data;
const TerminalReadCursor = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(4_096),
);
const TerminalReadMaxBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 }));
const TerminalReadWaitMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }));
const TerminalReadTailLines = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));
const TerminalReadSearchText = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(256),
);

export const ProjectTerminalHandle = Schema.Struct({
  projectId: ProjectId,
  terminalId: TerminalToolkitId,
});
export type ProjectTerminalHandle = typeof ProjectTerminalHandle.Type;

export const ProjectTerminalStatus = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "killed",
  "exited",
  "error",
]);
export type ProjectTerminalStatus = typeof ProjectTerminalStatus.Type;

export const ProjectTerminalSummary = Schema.Struct({
  projectId: ProjectId,
  terminalId: TerminalToolkitId,
  title: Schema.NullOr(TerminalTitle),
  command: Schema.NullOr(TerminalCommand),
  args: TerminalArguments,
  cwd: TrimmedNonEmptyString,
  creatingThreadId: ThreadId,
  label: Schema.String.check(Schema.isMaxLength(128)),
  status: ProjectTerminalStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});
export type ProjectTerminalSummary = typeof ProjectTerminalSummary.Type;

export const ProjectTerminalCreateInput = Schema.Struct({
  ...ProjectTerminalHandle.fields,
  creatingThreadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  cols: Schema.optional(TerminalCols),
  rows: Schema.optional(TerminalRows),
  title: Schema.optional(TerminalTitle),
  command: Schema.optional(TerminalCommand),
  args: Schema.optional(TerminalArguments),
  env: Schema.optional(TerminalLaunchEnvironment),
  providerInstanceId: Schema.optional(ProviderInstanceId),
}).check(
  Schema.makeFilter((input) => {
    if (input.args !== undefined && input.command === undefined) {
      return "Arguments require an explicit command.";
    }
    const commandBytes =
      input.command === undefined ? 0 : new TextEncoder().encode(input.command).length;
    const argumentBytes =
      input.args?.reduce(
        (total, argument) => total + new TextEncoder().encode(argument).length,
        0,
      ) ?? 0;
    return commandBytes + argumentBytes > 65_536
      ? "Command and arguments exceed the 64 KiB launch limit."
      : undefined;
  }),
);
export type ProjectTerminalCreateInput = typeof ProjectTerminalCreateInput.Type;

export const ProjectTerminalListInput = Schema.Struct({
  projectId: ProjectId,
  after: Schema.optional(TerminalToolkitId),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type ProjectTerminalListInput = typeof ProjectTerminalListInput.Type;

export const ProjectTerminalListResult = Schema.Struct({
  terminals: Schema.Array(ProjectTerminalSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(TerminalToolkitId),
});
export type ProjectTerminalListResult = typeof ProjectTerminalListResult.Type;

export const ProjectTerminalWriteInput = Schema.Struct({
  ...ProjectTerminalHandle.fields,
  data: TerminalData,
});
export type ProjectTerminalWriteInput = typeof ProjectTerminalWriteInput.Type;

export const ProjectTerminalResizeInput = Schema.Struct({
  ...ProjectTerminalHandle.fields,
  cols: TerminalCols,
  rows: TerminalRows,
});
export type ProjectTerminalResizeInput = typeof ProjectTerminalResizeInput.Type;

export const ProjectTerminalKillInput = Schema.Struct({
  ...ProjectTerminalHandle.fields,
  cleanup: Schema.optional(Schema.Boolean),
});
export type ProjectTerminalKillInput = typeof ProjectTerminalKillInput.Type;

export const TerminalReadSearch = Schema.Struct({
  text: TerminalReadSearchText,
  ignoreCase: Schema.optional(Schema.Boolean),
});
export type TerminalReadSearch = typeof TerminalReadSearch.Type;

export const TerminalReadInput = Schema.Struct({
  ...ProjectTerminalHandle.fields,
  cursor: Schema.optional(TerminalReadCursor),
  maxBytes: Schema.optional(TerminalReadMaxBytes),
  waitMs: Schema.optional(TerminalReadWaitMs),
  tailLines: Schema.optional(TerminalReadTailLines),
  search: Schema.optional(TerminalReadSearch),
}).check(
  Schema.makeFilter((input) => {
    if (
      input.tailLines !== undefined &&
      (input.cursor !== undefined || input.search !== undefined || input.waitMs !== undefined)
    ) {
      return "Tail reads cannot include a cursor, search, or wait duration.";
    }
    if (input.search !== undefined && input.waitMs !== undefined) {
      return "Search reads cannot wait for output.";
    }
    return undefined;
  }),
);
export type TerminalReadInput = typeof TerminalReadInput.Type;

const TerminalReadPosition = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const TerminalReadOutput = Schema.String.check(Schema.isMaxLength(65_536));

export const TerminalReadStreamResult = Schema.Struct({
  kind: Schema.Literal("stream"),
  terminal: ProjectTerminalSummary,
  output: TerminalReadOutput,
  nextCursor: TerminalReadCursor,
  hasMore: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type TerminalReadStreamResult = typeof TerminalReadStreamResult.Type;

export const TerminalReadMatch = Schema.Struct({
  start: TerminalReadPosition,
  end: TerminalReadPosition,
  excerpt: TerminalReadOutput,
}).check(
  Schema.makeFilter((match) =>
    match.start < match.end ? undefined : "A terminal match must have a nonempty source range.",
  ),
);
export type TerminalReadMatch = typeof TerminalReadMatch.Type;

export const TerminalReadSearchResult = Schema.Struct({
  kind: Schema.Literal("search"),
  terminal: ProjectTerminalSummary,
  matches: Schema.Array(TerminalReadMatch).check(Schema.isMaxLength(256)),
  nextCursor: TerminalReadCursor,
  hasMore: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type TerminalReadSearchResult = typeof TerminalReadSearchResult.Type;

export const TerminalReadResult = Schema.Union([
  TerminalReadStreamResult,
  TerminalReadSearchResult,
]);
export type TerminalReadResult = typeof TerminalReadResult.Type;

export class TerminalToolError extends Schema.TaggedError<TerminalToolError>()(
  "TerminalToolError",
  {
    operation: Schema.Literals(["spawn", "list", "read", "write", "resize", "kill", "close"]),
    reason: Schema.Literals([
      "unavailable",
      "invalid-cwd",
      "launch-failed",
      "not-running",
      "write-failed",
      "resize-failed",
      "kill-failed",
      "cleanup-failed",
      "invalid-cursor",
      "invalid-search-cursor",
      "invalid-budget",
    ]),
    projectId: ProjectId,
    terminalId: Schema.optional(TerminalToolkitId),
  },
) {
  override get message(): string {
    return `Project terminal ${this.operation} failed (${this.reason}).`;
  }
}

export const TerminalToolErrors = Schema.Union([TerminalToolError]);
export type TerminalToolErrors = typeof TerminalToolErrors.Type;
