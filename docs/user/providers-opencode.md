# OpenCode

T3 Code uses the OpenCode setup on the connected environment. With a remote environment, its
OpenCode login and configuration apply, not the setup on your desktop or phone.

T3 Code requires OpenCode 1.14.19 or newer. It checks the server version before it loads models or
starts work. If the check fails, update OpenCode or fix the server URL and password, then refresh
the provider status. Reconnecting the client also runs the check again.

## Server authentication

Without a server URL, T3 Code starts a local OpenCode server. The process inherits
`OPENCODE_SERVER_PASSWORD` from the environment. A password in the provider settings overrides
that environment value for both the local process and T3 Code.

With a server URL, T3 Code connects to that external server and uses only the password in the
provider settings. It does not send a local `OPENCODE_SERVER_PASSWORD` to an external server.
OpenCode uses this password for HTTP Basic authentication.

## Stop and reconnect

When you stop an active OpenCode turn, T3 Code asks OpenCode to abort it. T3 Code marks the turn
stopped only after OpenCode confirms the abort through an event or an idle session status.

If T3 Code cannot confirm the abort, it reports the failure and keeps the session active so you can
try again. A successful HTTP request alone does not mean that OpenCode stopped the turn.

Restarting T3 Code, reconnecting a client, stopping all sessions, or changing the provider
connection detaches T3 Code from an external OpenCode server. It does not stop work on that server.
When you start the thread again, T3 Code reattaches to the saved OpenCode session and can continue
or stop the existing turn.

## Refresh the model list

T3 Code loads the model list when an enabled OpenCode provider starts and keeps the list in its
cache. Reconnecting a client or using a refresh control asks OpenCode for the list again. The
periodic provider health setting does not refresh OpenCode's catalog.

After changing an OpenCode login or configuration outside T3 Code, open **Settings > Providers**,
select the environment, and choose **Refresh provider status**. Changing the provider's
configuration in T3 Code also replaces that provider connection.

On mobile, open the thread settings and select **Refresh models**. The control stays disabled while
the refresh runs and shows an error if the refresh fails.

OpenCode reads credential changes on each model-list request. Native OpenCode configuration files
can stay cached while the local helper is running. The helper closes after 30 seconds with no
model-list or text-generation work. Refresh after that idle period to start a new helper and read
the file changes. Repeated refreshes or active helper work can extend this wait.

T3 Code does not own an external OpenCode server. Native configuration changes on that server can
require its own reload or restart before a refresh returns the new list.

If a refresh fails, T3 Code keeps the last known models, slash commands, and skills. Fix the
connection, then refresh again. A successful refresh can remove entries that OpenCode no longer
offers.

## Continue an existing thread

An existing thread keeps its selected model and options when that model is temporarily absent
from the catalog. The web picker shows an **Unavailable** row and keeps saved option values visible
until the model metadata returns. T3 Code does not switch the thread to the first model in the
list.

The stored selection does not guarantee that OpenCode can still run the model. If the provider
rejects it, select an available model before trying again.
