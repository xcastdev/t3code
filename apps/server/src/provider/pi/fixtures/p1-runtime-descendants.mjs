import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
// Both children stay in the SDK shell's process group. No detached escape is claimed.
const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
await NodeEvents.once(child, "spawn");
const pids = [Number(process.argv[2]), process.pid, child.pid];
await NodeFSP.writeFile(process.argv[3], JSON.stringify({ pids }));
if (!["shell-pre-receipt-stall", "cleanup-abort-stall"].includes(process.argv[4]))
  process.stdout.write(JSON.stringify({ pids }) + "\n");
setInterval(() => {}, 1000);
