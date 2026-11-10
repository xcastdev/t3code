// Pinned RPC handlers: compact owns session work; dump only exports the owned transcript.
const allowedBuiltins = new Set(["compact", "dump"]);
const denied = new Set([
  "stats",
  "task",
  "tasks",
  "subagent",
  "subagents",
  "async",
  "jobs",
  "services",
  "service",
  "goal",
  "plan",
  "model",
  "models",
  "thinking",
  "settings",
  "config",
  "extensions",
  "reload",
  "mcp",
  "python",
  "bash",
  "exec",
  "live",
  "btw",
  "handoff",
  "fork",
  "branch",
  "new",
  "resume",
  "tree",
  "login",
  "logout",
  "fast",
  "slow",
  "retry",
]);
export interface OmpCommand {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly source: unknown;
}
function allowed(command: OmpCommand) {
  const names = [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
  if (names.some((n) => denied.has(n))) return false;
  // Unknown command sources cannot establish a workspace instruction's provenance.
  const source =
    typeof command.source === "string"
      ? command.source
      : command.source && typeof command.source === "object" && "type" in command.source
        ? command.source.type
        : undefined;
  return (
    source === "skill" ||
    source === "prompt" ||
    source === "template" ||
    source === "prompt-template" ||
    source === "file" ||
    source === "custom" ||
    source === "mcp_prompt" ||
    (source === "builtin" && allowedBuiltins.has(command.name))
  );
}
const names = (command: OmpCommand) =>
  [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
export function availableCommands(commands: readonly OmpCommand[]) {
  const blocked = new Set(commands.filter((command) => !allowed(command)).flatMap(names));
  return commands.filter(
    (command) => allowed(command) && !names(command).some((name) => blocked.has(name)),
  );
}
export function assertAllowedPrompt(message: string, commands: readonly OmpCommand[]) {
  const match = /^\s*\/([^\s/]+)/.exec(message);
  if (!match) return;
  const name = match[1]!.toLowerCase();
  const found = availableCommands(commands).find((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => n.toLowerCase() === name),
  );
  if (!found || !allowed(found))
    throw new Error(`OMP command /${name} is unavailable under the T3 policy`);
}
