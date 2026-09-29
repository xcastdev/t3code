import {
  McpCapabilityUnavailableError,
  ProjectTerminalCreateInput,
  ProjectTerminalKillInput,
  ProjectTerminalListInput,
  ProjectTerminalListResult,
  ProjectTerminalSubscribeCompletionInput,
  ProjectTerminalUnsubscribeCompletionInput,
  ProjectTerminalResizeInput,
  ProjectTerminalSummary,
  ProjectTerminalWriteInput,
  TerminalReadInput,
  TerminalReadResult,
  TerminalToolError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectTerminalService from "../../../terminal/ProjectTerminalService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectTerminalService.ProjectTerminalService,
];

const TerminalSpawnParameters = Schema.Struct({
  cwd: Schema.optional(
    ProjectTerminalCreateInput.fields.cwd.annotate({
      description:
        "Working directory for the process. Defaults to this project's workspace; pass a worktree path when needed.",
    }),
  ),
  cols: Schema.optional(ProjectTerminalCreateInput.fields.cols),
  rows: Schema.optional(ProjectTerminalCreateInput.fields.rows),
  title: Schema.optional(
    ProjectTerminalCreateInput.fields.title.annotate({
      description: "Short name shown when agents list shared terminals.",
    }),
  ),
  command: Schema.optional(
    ProjectTerminalCreateInput.fields.command.annotate({
      description:
        "Executable to start directly. Omit it to start the environment's interactive shell. Arguments are never interpreted by a shell.",
    }),
  ),
  args: Schema.optional(
    ProjectTerminalCreateInput.fields.args.annotate({
      description: "Arguments passed unchanged to command. Requires command.",
    }),
  ),
  env: Schema.optional(
    ProjectTerminalCreateInput.fields.env.annotate({
      description:
        "Environment overrides for this process. Values are not returned by terminal_list.",
    }),
  ),
}).check(
  Schema.makeFilter((input) => {
    if (input.args !== undefined && input.command === undefined) {
      return "Arguments require an explicit command.";
    }
    const commandBytes = input.command === undefined ? 0 : Buffer.byteLength(input.command, "utf8");
    const argumentBytes =
      input.args?.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) ?? 0;
    return commandBytes + argumentBytes > 65_536
      ? "Command and arguments exceed the 64 KiB launch limit."
      : undefined;
  }),
);

const TerminalListParameters = Schema.Struct({
  after: Schema.optional(ProjectTerminalListInput.fields.after),
  limit: Schema.optional(ProjectTerminalListInput.fields.limit),
});

const TerminalWriteResult = Schema.Struct({
  acknowledged: Schema.Literal(true).annotate({
    description: "The text was written to the PTY; this does not claim that a command completed.",
  }),
});

const TerminalResizeResult = Schema.Struct({ resized: Schema.Literal(true) });

const TerminalKillResult = Schema.Struct({
  requested: Schema.Literal(true).annotate({
    description: "Termination was requested; the terminal may still be stopping.",
  }),
  cleanup: Schema.Boolean,
});

const TerminalCompletionSubscriptionResult = Schema.Struct({
  subscribed: Schema.Literal(true),
});
const TerminalCompletionUnsubscriptionResult = Schema.Struct({
  unsubscribed: Schema.Literal(true),
});

export const TerminalToolkitError = Schema.Union([
  McpCapabilityUnavailableError,
  ProjectTerminalService.ProjectTerminalAccessUnavailableError,
  TerminalToolError,
]);

const TerminalSpawnTool = Tool.make("terminal_spawn", {
  description:
    "Start a shared PTY owned by this project. Pass command and args to launch a program directly, or omit command for the environment's interactive shell. Arguments are passed unchanged and do not receive shell parsing; choose a shell explicitly when you need shell syntax. The default working directory is the project workspace. Other agents in this project can use the same terminal, and it keeps running after this request or its creating thread ends.",
  parameters: TerminalSpawnParameters,
  success: ProjectTerminalSummary,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Start shared terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const TerminalListTool = Tool.make("terminal_list", {
  description:
    "List shared project terminals by stable terminal ID. Results include retained stopped sessions and process metadata, but never command environment values. Use the returned projectId and terminalId together when reading or controlling a terminal. Pagination defaults to 50 and allows at most 100 results.",
  parameters: TerminalListParameters,
  success: ProjectTerminalListResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "List shared terminals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalReadTool = Tool.make("terminal_read", {
  description:
    "Read retained PTY output, including ANSI control sequences; this is a text stream, not a rendered screen. Use a cursor to continue without affecting other readers, tailLines for recent lines, or search for bounded literal text. Output eviction is reported as truncation. Reads do not resize, reopen, or restart a terminal. waitMs can wait for new output or process exit. Search is literal, not a regular expression.",
  parameters: TerminalReadInput,
  success: TerminalReadResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Read shared terminal")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalWriteTool = Tool.make("terminal_write", {
  description:
    "Write text or control characters to a running shared PTY. No newline is appended: include \n or \r explicitly when the shell should submit a line. Send Ctrl-C as \u0003 to interrupt the foreground program; use terminal_kill to end the whole terminal. Agents in the project share control, so their writes may interleave. The acknowledgement confirms input was written, not that a command succeeded.",
  parameters: ProjectTerminalWriteInput,
  success: TerminalWriteResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Write to shared terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const TerminalResizeTool = Tool.make("terminal_resize", {
  description:
    "Change the dimensions of a running shared PTY. Reading output never changes terminal dimensions.",
  parameters: ProjectTerminalResizeInput,
  success: TerminalResizeResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Resize shared terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const TerminalKillTool = Tool.make("terminal_kill", {
  description:
    "Request termination of one shared project terminal. This ends the whole PTY session; to interrupt only the foreground program, write Ctrl-C (\u0003) with terminal_write. The terminal may report stopping until process exit is observed. By default its final output and exit status remain readable by other agents; set cleanup=true to remove that session and its history after termination. Never use this for a human-created dock terminal.",
  parameters: ProjectTerminalKillInput,
  success: TerminalKillResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Stop shared terminal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const TerminalSubscribeCompletionTool = Tool.make("terminal_subscribe_completion", {
  description:
    "Receive one activity in the terminal's originating thread when a shared project terminal exits. Use noticeAndWake to also ask that thread's agent to review the result; supported providers can receive the prompt during a turn, while other providers wait until the turn settles. Subscriptions last only for this server process and allow at most 32 subscribing threads per terminal.",
  parameters: ProjectTerminalSubscribeCompletionInput,
  success: TerminalCompletionSubscriptionResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Watch shared terminal completion")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TerminalUnsubscribeCompletionTool = Tool.make("terminal_unsubscribe_completion", {
  description: "Stop this thread's one-shot completion subscription for a shared terminal.",
  parameters: ProjectTerminalUnsubscribeCompletionInput,
  success: TerminalCompletionUnsubscriptionResult,
  failure: TerminalToolkitError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching terminal completion")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TerminalToolkit = Toolkit.make(
  TerminalSpawnTool,
  TerminalListTool,
  TerminalReadTool,
  TerminalWriteTool,
  TerminalResizeTool,
  TerminalKillTool,
  TerminalSubscribeCompletionTool,
  TerminalUnsubscribeCompletionTool,
);
