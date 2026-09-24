# OpenCode

Install and authenticate OpenCode on the machine running your environment, then
enable it in **Settings > Providers**. See [provider setup](./install.md#providers).
T3 Code requires OpenCode 1.14.19 or newer, including when you connect an existing
OpenCode server.

## Local or external server

Leave **Server URL** empty to let T3 Code start OpenCode locally. A password in
provider settings applies to both that server and T3 Code's connection. With no
password setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its
environment.

To use an existing OpenCode server, set **Server URL** and its password in provider
settings. T3 Code uses only that configured password for an external server; it
does not forward a local `OPENCODE_SERVER_PASSWORD`. If connection or version checks
fail, check the URL, credentials, and OpenCode version, then refresh provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode
session.

**Fork files too** creates a new Git worktree and moves the forked OpenCode
session into it. The OpenCode server must support session moves; if it does not,
T3 cancels the fork instead of letting the agent work in the source checkout.

## Commands and skills follow the workspace

OpenCode discovers commands and skills for the current project checkout. When you
switch projects or worktrees, the composer refreshes that catalog for the new
directory. A command or skill shown in one checkout is not evidence that it is
available in another.

Use `/` to browse commands. When T3 starts OpenCode locally, use `!` to browse and load skills in a session.

T3-managed skills are available when T3 starts OpenCode locally. T3 gives each
session its own skill source and checks that OpenCode loaded the managed version
before the session starts. Changes to a managed skill take effect in a new
provider session. If `OPENCODE_CONFIG_DIR` is already set for that provider,
managed skill delivery is unavailable because T3 cannot replace that directory
without hiding its contents. External OpenCode servers continue to expose native
skills but do not receive T3-managed session skills. You can explicitly install
a managed skill to a native project or user directory when the configured server
uses a loopback URL and shares T3's checkout path. See [skills](./skills.md)
for install scopes and the providers that read shared `.agents` installs.

## Project MCP with an external server

By default, T3 Code leaves an external OpenCode server's MCP configuration alone,
so project MCP servers cannot be attached to its sessions. If you opt that provider
instance into T3-managed MCP, T3 can register the project servers for a new session.

Use that opt-in only when T3 Code is the manager for the selected OpenCode URL and
directory. One T3 Code process allows only one such MCP-enabled session for a URL
and exact directory. On cleanup, OpenCode keeps the dynamic entry disabled because
its API cannot remove it.

When OpenCode and T3 Code run on different machines, set **T3 MCP public origin**
to the HTTPS origin OpenCode can reach. A loopback HTTP origin works only when both
processes run on the same machine. See [project MCP servers](./project-mcp-servers.md)
for transport, credentials, and OAuth rules.

Scoped catalog changes are restart-required for OpenCode. T3 attaches selected servers through
per-server authenticated proxies when the next provider session starts; it does not claim that
OpenCode refreshes a catalog in place or consume the live aggregate endpoint. Live list-change
updates are reserved for provider adapters that have been verified to refresh in place.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before T3 Code can see configuration changes.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.
