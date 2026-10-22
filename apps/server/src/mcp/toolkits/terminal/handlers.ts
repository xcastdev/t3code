import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, assertLiveCaller, loadCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectTerminalService from "../../../terminal/ProjectTerminalService.ts";
import { TerminalToolkit } from "./tools.ts";

const readAuthority = loadCaller().pipe(Effect.tap(assertLiveCaller));
const writeAuthority = readAuthority.pipe(
  Effect.tap((caller) =>
    assertFullAccess(
      caller,
      "Shared PTY control requires a live full-access/default calling thread.",
    ),
  ),
);

const handlers = {
  terminal_spawn: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* writeAuthority;

      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      return yield* terminals.spawn({
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.env === undefined ? {} : { env: input.env }),
      });
    }),
  ),
  terminal_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* readAuthority;

      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      return yield* terminals.list({
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    }),
  ),
  terminal_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* readAuthority;
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      return yield* terminals.read(input);
    }),
  ),
  terminal_write: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* writeAuthority;
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.write(input);
      return { acknowledged: true as const };
    }),
  ),
  terminal_resize: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* writeAuthority;
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.resize(input);
      return { resized: true as const };
    }),
  ),
  terminal_kill: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* writeAuthority;
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      return yield* terminals.kill(input);
    }),
  ),
  terminal_subscribe_completion: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* writeAuthority;
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.subscribeCompletion(input);
      return { subscribed: true as const };
    }),
  ),
  terminal_unsubscribe_completion: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("terminal");
      yield* writeAuthority;
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.unsubscribeCompletion(input);
      return { unsubscribed: true as const };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
