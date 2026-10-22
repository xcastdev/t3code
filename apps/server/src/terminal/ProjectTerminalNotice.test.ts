import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  TurnItemId,
  OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { projectTerminalNoticeItem } from "./ProjectTerminalNotice.ts";

const isPublicCommand = Schema.is(OrchestrationV2Command);
const command = {
  type: "thread.notice.append" as const,
  commandId: CommandId.make("terminal-notice"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  turnItemId: TurnItemId.make("terminal-completion"),
  notification: {
    source: { kind: "background_task" as const },
    outcome: "completed" as const,
    summary: "Terminal exited",
  },
};
it("appends one native notice with no run or provider attribution", () => {
  const input = {
    command,
    thread: { id: command.threadId, projectId: command.projectId, deletedAt: null },
    existingItemIds: new Set<string>(),
    ordinal: 4,
    now: DateTime.makeUnsafe(0),
  };
  const item = projectTerminalNoticeItem(input);
  assert.equal(item?.type, "notification");
  assert.equal(item?.runId, null);
  assert.equal(item?.nodeId, null);
  assert.equal(item?.providerThreadId, null);
  assert.equal(item?.providerTurnId, null);
  assert.equal(
    projectTerminalNoticeItem({ ...input, existingItemIds: new Set([command.turnItemId]) }),
    null,
  );
  assert.throws(() =>
    projectTerminalNoticeItem({
      ...input,
      thread: { ...input.thread, projectId: ProjectId.make("other-project") },
    }),
  );
  assert.throws(() =>
    projectTerminalNoticeItem({
      ...input,
      thread: { ...input.thread, deletedAt: DateTime.makeUnsafe(1) },
    }),
  );
  assert.equal(isPublicCommand(command), false);
});
