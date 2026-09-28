import * as Effect from "effect/Effect";

import * as ProjectTerminalService from "../../../terminal/ProjectTerminalService.ts";
import { TerminalToolkit } from "./tools.ts";

const handlers = {
  terminal_spawn: (input) =>
    Effect.gen(function* () {
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
  terminal_list: (input) =>
    Effect.gen(function* () {
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      return yield* terminals.list({
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    }),
  terminal_read: (input) =>
    Effect.gen(function* () {
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      return yield* terminals.read(input);
    }),
  terminal_write: (input) =>
    Effect.gen(function* () {
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.write(input);
      return { acknowledged: true as const };
    }),
  terminal_resize: (input) =>
    Effect.gen(function* () {
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.resize(input);
      return { resized: true as const };
    }),
  terminal_kill: (input) =>
    Effect.gen(function* () {
      const terminals = yield* ProjectTerminalService.ProjectTerminalService;
      yield* terminals.kill(input);
      return { requested: true as const, cleanup: input.cleanup ?? false };
    }),
} satisfies Parameters<typeof TerminalToolkit.toLayer>[0];

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer(handlers);
