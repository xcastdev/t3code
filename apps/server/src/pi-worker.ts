import { runPiWorkerEntrypoint } from "./provider/pi/PiWorkerEntrypoint.ts";

// The parent supplies the bounded launch descriptor; stdout is the worker protocol.
try {
  if (process.argv.length !== 3) throw Error("PI_WORKER_INVALID_LAUNCH");
  await runPiWorkerEntrypoint(process.argv[2]);
} catch {
  process.stderr.write("PI_WORKER_OPERATION_FAILED\n");
  process.exitCode = 1;
}
