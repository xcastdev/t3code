# Project MCP servers

Add MCP servers for a project checkout in **Settings → Integrations → MCP servers** on web or
desktop. Configured servers run through the selected environment.

## Add a server

1. Select the environment, project, and checkout.
2. Open **MCP servers** and choose **Add server**.
3. Enter a name and select a transport.
4. Enter its connection settings and select the providers that should receive it.
5. Save the server and start a new provider session.

The server applies only to the selected checkout. T3 Code gives each provider session an
authenticated proxy endpoint, so providers do not receive the upstream command, headers,
environment values, or stored credentials.

Choose from these transports:

- **Streamable HTTP** for current remote MCP servers.
- **Legacy SSE** only when the server requires the older HTTP and SSE transport.
- **stdio** for a local command that runs on the environment machine.

HTTP URLs must use HTTPS, except for loopback HTTP. They cannot contain embedded credentials or a
query string. For stdio, enter each argument separately; spaces and line breaks within an argument
are preserved. The command inherits the environment's variables, including `PATH`.

On macOS and Linux, environment variable names are case-sensitive. Windows treats names such as
`HTTP_PROXY` and `http_proxy` as the same variable, so T3 Code rejects that pair.

## Credentials and OAuth

HTTP headers, stdio environment values, and OAuth client secrets are write-only. After saving, an
existing value appears as **Configured** instead of being returned to the client. Leave its input
blank to retain it, or use the remove action to delete it. Use **Set empty value** only when the
server requires an explicit empty value.

For OAuth, choose automatic registration or enter a pre-registered client. Save the server, then
choose **Connect OAuth** and open the authorization link. The callback must return to the same T3
server and browser origin that started authorization.

Loopback HTTP callbacks work only when T3 Code is open through a loopback address. For a LAN or
tailnet server, use T3 Connect or an HTTPS reverse proxy and complete authorization through that
same HTTPS origin.

Disconnecting OAuth removes the stored grant. Changing the server URL, registration mode, client
ID, or client secret requires matching authorization. After rotating any credential, start a new
provider session so it receives the replacement.

## Provider status

The server list reports how each selected provider applies the configuration:

- **Applies to new sessions** means a new provider session will receive the server.
- **Applies to this session** means the running provider can apply it without a restart.
- **Not supported by this provider** means that provider cannot receive it.
- **Provider unavailable** means the selected provider instance is not currently available.

If no providers are selected, the configuration is saved but is not attached to a provider
session. T3-managed entries, including the `t3-code` preview server, are read-only.

External OpenCode instances are not managed by default. To opt in, enable **Manage MCP servers on
external OpenCode** in that provider's settings. When OpenCode and T3 Code run on different
machines, configure an HTTPS **T3 MCP public origin**. Loopback HTTP works only when they share a
machine.

An opted-in external OpenCode server supports one MCP-enabled T3 session for each exact server URL
and directory within a T3 server process. This does not lock another T3 process or a native
OpenCode client. Disconnected entries remain disabled in OpenCode because its API cannot remove
them.

## Troubleshooting

### An HTTP server does not connect

Use **Streamable HTTP** unless the server documents a Legacy SSE requirement. Streamable HTTP falls
back to Legacy SSE only when initialization returns 400, 404, or 405. Authentication, rate-limit,
timeout, network, and server errors remain visible.

### A stdio server does not start

The command runs on the environment machine, not on the browser or phone. Confirm that the
executable is installed there, the working directory exists, and required environment variables
are configured.

### OAuth does not reconnect

If **Connect OAuth** appears for a previously connected server, authorize it again. Confirm that
the authorization popup was not blocked and that its callback returned to the same T3 server. If a
secret or grant was replaced, disconnect the old grant, connect again, and start a new provider
session.
