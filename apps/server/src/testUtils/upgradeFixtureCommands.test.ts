import { expect, it } from "@effect/vitest";
import { isTrustedUpgradeFixtureCommand } from "./upgradeFixtureCommands.ts";

it("admits only the exact authored executable and argv even inside a disposable cwd", () => {
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  expect(isTrustedUpgradeFixtureCommand(process.execPath, ["--version"])).toBe(true);
  expect(isTrustedUpgradeFixtureCommand("/usr/bin/git", [...prefix, "status", "--porcelain"])).toBe(
    true,
  );
  for (const [command, args] of [
    [process.execPath, ["-e", "process.exit(0)"]],
    ["/bin/sh", ["-c", "printf unsafe"]],
    ["git", [...prefix, "status", "--porcelain"]],
    ["/usr/bin/git", ["status", "--porcelain"]],
    ["/usr/bin/git", [...prefix, "config", "core.hooksPath", "/tmp/hooks"]],
    ["/usr/bin/git", [...prefix, "status", "--porcelain", "--untracked-files=all"]],
    ["/usr/bin/git", [...prefix, "fetch", "https://example.com/repository"]],
  ] as const) {
    expect(isTrustedUpgradeFixtureCommand(command, args)).toBe(false);
  }
});
