# Project MCP servers

Use **Settings** → **Projects** to manage external MCP servers for a project.

## Add an external MCP server

1. Select the environment, project, and physical checkout.
2. Add the server name and URL.
3. Select the provider instances that should receive the server.
4. Save the server.

Each external MCP server applies only to the configured project and physical checkout selected in
**Settings**. Other projects and checkouts cannot use it.

The initial release supports remote HTTP MCP URLs. Use HTTPS for remote servers. Loopback HTTP URLs
are supported for local servers. T3 Code does not support custom headers, secrets, OAuth, local
stdio MCP servers, or live reload for project MCP servers.

## When changes take effect

T3 Code gives a configured server to the selected provider instances when a new session starts.
Existing sessions keep their current MCP configuration.

Start a new session after you add, edit, enable, disable, or reassign a server. If you select no
provider instances, T3 Code saves the server but attaches it nowhere.

## T3-managed servers are read-only

T3-managed MCP entries may appear in the same list as your external servers. These entries are
read-only. You cannot rename, remove, or replace them.
