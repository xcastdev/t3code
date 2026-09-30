import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
// Both children stay in the SDK shell's process group. No detached escape is claimed.
const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
await NodeEvents.once(child, "spawn");
process.stdout.write(
  JSON.stringify({ pids: [Number(process.argv[2]), process.pid, child.pid] }) + "\n",
);
setInterval(() => {}, 1000);
