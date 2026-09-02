# Project MCP servers

Use **Settings** → **Projects** to manage external MCP servers for a project in the web and
desktop clients. Mobile does not include project MCP server management.

## Add an external MCP server

1. Select the environment, project, and **Checkout**.
2. Add the server name and URL.
3. Select the **Providers** that should receive the server.
4. Save the server.

Each external MCP server applies only to the configured project and **Checkout** selected in
**Settings**. Other projects and checkouts cannot use it.

T3 Code accepts HTTPS URLs and HTTP URLs with loopback hosts. It rejects HTTP URLs for other hosts.
It also rejects URLs with an embedded username or password or a query string. Saving or viewing an
entry does not check whether its URL is reachable.

The initial release supports remote HTTP MCP URLs. T3 Code does not support custom headers,
secrets, OAuth, local stdio MCP servers, or live reload for project MCP servers.

## Check provider support and application labels

T3 Code sends a server only to selected providers that support it. OpenCode or another
unsupported provider may remain selected, but it shows **Not supported by this provider** and does
not receive the server.

The application label for each selected provider tells you when the server applies:

- **Applies to this session** means the provider can use the server in the current session.
- **Applies to new sessions** means the provider receives the server when a new session starts.
  Existing sessions do not change.
- **Not supported by this provider** means the provider does not receive the server.
- **Provider unavailable** means the provider is not available to receive the server.

If you select no providers, T3 Code saves the server but attaches it nowhere. Start a new session
when the application label says **Applies to new sessions**. This applies after you add, edit,
enable, disable, or reassign a server.

## T3-managed servers are read-only

T3-managed MCP entries may appear in the same list as your external servers. These entries are
read-only. You cannot rename, remove, or replace them.
