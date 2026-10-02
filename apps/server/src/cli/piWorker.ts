import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import { runPiWorkerEntrypoint } from "../provider/pi/PiWorkerEntrypoint.ts";

class PiWorkerCliError extends CliError.UserError {
  override get message() {
    return "PI_WORKER_OPERATION_FAILED";
  }
}

// Private argv must never reach the general parser's error/help reporter.
export const runPiWorkerInvocation = (args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => {
      const launch = args[0];
      if (args.length !== 1 || launch === undefined) throw Error("PI_WORKER_INVALID_LAUNCH");
      return runPiWorkerEntrypoint(launch);
    },
    catch: () => new PiWorkerCliError({ cause: "PI_WORKER_OPERATION_FAILED" }),
  });

/** Executables host the same private worker as the npm sibling entry. */
export const piWorkerCommand = Command.make("__pi-worker", {
  launch: Argument.string("launch"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ launch }) => runPiWorkerInvocation([launch])),
);
