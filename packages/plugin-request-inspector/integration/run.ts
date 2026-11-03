// @effect-diagnostics nodeBuiltinImport:off - A test launcher, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { findOnPath } from "./harness.ts";

const packageDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const missing = ["mitmdump", "python3"].filter((name) => {
  try {
    findOnPath(name);
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  process.stderr.write(
    [
      `test:mitmproxy needs ${missing.join(" and ")} on PATH, and it is not there.`,
      "Install mitmproxy 12 or newer (https://mitmproxy.org), for example:",
      "  macOS:   brew install mitmproxy",
      "  Arch:    pacman -S mitmproxy",
      "  pipx:    pipx install mitmproxy",
      "Then check that `mitmdump --version` works in this shell and run the suite again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const result = NodeChildProcess.spawnSync(
  "vp",
  ["test", "run", "--config", "../../vite.config.ts", "--dir", "integration"],
  { cwd: packageDir, stdio: "inherit" },
);
process.exit(result.status ?? 1);
