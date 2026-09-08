# Project MCP servers

Use **Settings** → **Projects** to manage MCP servers for a project and checkout in the web or
desktop app. Mobile can use the server-side configuration, but does not include management UI.

## Supported transports

T3 Code supports these upstream MCP transports:

- **Streamable HTTP** for current MCP servers and automatic compatibility negotiation.
- **Legacy HTTP + SSE** when a server requires the older transport.
- **Local stdio** for a command that runs on the T3 environment machine.

For HTTP transports, use an HTTPS URL or an HTTP URL on a loopback host. URLs cannot contain
embedded usernames, passwords, or query strings. For stdio, provide the executable command,
optional arguments, working directory, and environment variables.
On macOS and Linux, `HTTP_PROXY` and `http_proxy` are separate variables. Windows treats those
names as the same variable, so T3 rejects that pair before it starts the command.

## Add or edit a server

1. Select the environment, project, and **Checkout**.
2. Open **MCP servers** and choose **Add server**.
3. Enter a name and select the transport.
4. Enter the transport settings and select the providers that should receive the server.
5. Save the server and start a new provider session.

The server applies only to the selected project and checkout. T3 gives each provider session an
authenticated, server-specific proxy endpoint. Providers never receive the upstream command,
working directory, headers, or environment values.

Catalog changes apply to new provider sessions. Existing sessions keep their issued endpoints and
configuration until they stop.

For stdio, each argument has its own text field. Choose **Add argument** to append an argument or
**Remove argument** to delete one. An empty field passes one empty argument; remove all fields to
pass no arguments. Spaces and line breaks within each field are preserved when you save, including
when you edit another setting.

Enabling or disabling a server preserves configuration changes saved from another device.

When a provider session exits, T3 revokes its proxy endpoints and releases its credentials. Deleting
a project removes its unused MCP credentials. Credentials still in use remain available until
those sessions stop.

## Credentials and OAuth

Header values, stdio environment values, and OAuth client secrets are write-only. An existing
credential is shown as **Configured**; its value is never returned or placed in the page. Leave a
retained credential blank to keep it, or choose **Remove credential** to delete it explicitly.
For a named header or environment variable, an empty new value is saved as an empty string.
Choose **Set empty value** to replace a retained value with an empty string. Choose
**Remove client secret** to remove a saved OAuth client secret.
Choose **Set empty client secret** if the OAuth client requires an explicit empty secret.

For an OAuth server, select **OAuth** and choose automatic registration or a pre-registered client.
Save your settings, reopen the server, and use **Connect OAuth**, then **Open OAuth authorization**
to authorize in a new tab. Use **Disconnect OAuth** to revoke T3's stored grant.
T3 stores tokens, PKCE verifiers, client details, and authorization state in the server secret
store, not in the project catalog or event history.

The authorization link opens only when you select it. The
callback must return to the T3 server that started authorization; a different browser origin or
server address cannot complete that state.
Local HTTP callbacks are supported only when you open T3 through a loopback address. An HTTP LAN
or tailnet address cannot host the callback; open T3 through T3 Connect or an HTTPS reverse proxy
and complete authorization at that exact HTTPS address. T3 reports an error instead of falling
back to a misleading localhost callback when it cannot form a safe browser origin.

Completing OAuth or disconnecting OAuth closes active upstream connections for that server. Rotating
a header, environment value, or pre-registered client secret applies to new provider sessions;
existing sessions retain their current leased credential until they stop. Start a new provider
session after changing a catalog credential.

## Provider status

Each selected provider has an application status:

- **Applies to new sessions** means the provider receives the server when a new session starts.
- **Applies to this session** means the provider can apply it without restarting the session.
- **Not supported by this provider** means the provider cannot receive the server.
- **Provider unavailable** means that provider instance is not currently available.

External OpenCode instances are explicitly unsupported because T3 cannot safely configure an
OpenCode server managed outside T3. T3-managed OpenCode instances use the same authenticated
proxy endpoint as the other supported providers.

If no providers are selected, the server is saved but is not attached to a provider session.

T3-managed entries, including the `t3-code` preview server, are read-only and cannot be renamed,
removed, or replaced.

## Troubleshooting

### Streamable HTTP and legacy SSE

Choose **Streamable HTTP** unless the upstream documents that it requires the older HTTP + SSE
transport. Streamable HTTP attempts current protocol negotiation and falls back to a legacy SSE
connection only for an initialization response with status 400, 404, or 405. Authentication,
rate-limit, timeout, network, and server failures are reported instead of being hidden by a
fallback.

### Stdio does not start

The command runs on the T3 environment machine, not on the browser or phone. Check that the
executable is installed there, that the selected working directory exists, and that required
environment variables are configured. The inherited environment, including `PATH`, is retained.
On Windows, rename one of two environment variables whose names differ only by case.

### OAuth does not reconnect

Some older OAuth connections require authorization again after an upgrade. If **Connect OAuth**
appears for a previously connected server, select it to reconnect. Older grants lack the registration
details needed to verify that the saved credentials belong to the current configuration.

Changing the server URL, OAuth registration mode, client ID, or client secret requires a matching
authorization. A grant for the previous configuration does not appear as connected. If T3 cannot
read the authorization status, the server shows an OAuth error.

Confirm that the OAuth callback returned to the same T3 server and that the authorization popup
was not blocked. If the client secret or grant was replaced, disconnect the old grant, connect
again, and start a new provider session.
