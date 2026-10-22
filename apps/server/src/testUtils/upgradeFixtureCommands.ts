/** Exact argv admission is independent of cwd; a disposable cwd alone never authorizes execution. */
export function isTrustedUpgradeFixtureCommand(
  command: string,
  args: ReadonlyArray<string>,
): boolean {
  if (command === process.execPath) return args.length === 1 && args[0] === "--version";
  if (command !== "/usr/bin/git") return false;
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
  if (!prefix.every((value, index) => args[index] === value)) return false;
  const operation = args.slice(prefix.length);
  return [
    ["init"],
    ["config", "user.name", "T3 Fixture"],
    ["config", "user.email", "fixture@localhost"],
    ["add", "--", "fixture.txt"],
    ["commit", "--no-gpg-sign", "-m", "Fixture baseline"],
    ["status", "--porcelain"],
  ].some(
    (allowed) =>
      operation.length === allowed.length &&
      allowed.every((value, index) => operation[index] === value),
  );
}
