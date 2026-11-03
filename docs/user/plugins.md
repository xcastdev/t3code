# Plugins

Plugins add panels, commands, and agent tools to T3 Code. A plugin can run on your device,
in an environment, or both. Install only plugins from authors you trust: an environment plugin
runs with the same access as T3 Code on that machine, including its files, network, and
credentials.

## Install and manage

Open **Settings → Plugins**. The page lists plugins on this device and on the selected
environment. Choose **Install** and pick a `.t3plugin` file. Installing a plugin with a backend
asks you to confirm that you trust its author first.

Each plugin can be turned off with its switch. A disabled plugin stops its backend, fails its
tools, and shows **Enable** in its panel. **Uninstall** keeps the plugin's data so a reinstall
picks up where it left off; **Delete data** removes it. Updating means installing a newer version.
Open panels switch to it and keep their state.

## Open a panel

Open a plugin from the sidebar or the command palette. With a chat open the panel docks beside it;
with none (for example in Settings), it opens as a page. If the same plugin is installed on this
device and in several environments, the sidebar and palette list each one by name. A plugin's
keybinding opens the current chat's environment first, then this device, then the only connected
environment; if that is still ambiguous, it opens the palette so you can choose.

On mobile, open plugin panels from Settings or the command palette. Plugin settings are edited
on web.

## Let an assistant use plugin tools

Assistants can call a plugin's tools only if you select them. In the assistant's resource
bindings, choose the operations under **Plugin tools**. Plugin resources are not available to
assistants. In an ordinary thread, tools that change state need the thread to have full access and
the default mode. Provider support varies, and not every provider can call plugin tools.

## Request Inspector

The Request Inspector captures HTTP traffic that you route through a local mitmproxy, then lets you
search, inspect, replay, and attach requests to a chat.

**Before you start.** Install [mitmproxy](https://mitmproxy.org) so `mitmdump` is on the
environment's PATH. Start a capture, then point your client at the proxy, for example
`curl -x http://127.0.0.1:8080`. Only traffic sent to that proxy is captured. The host, port,
and limits are in the plugin's settings.

**HTTPS.** The inspector creates its own certificate authority in the plugin's data folder,
under `mitmproxy/`. To capture HTTPS, trust `mitmproxy-ca-cert.pem` from that folder in the client you
are testing, using that client's or your system's certificate steps. Remove it when you are done.

**Replay.** A replay shows its destination first. It does not follow redirects, so a 3xx is
recorded as-is. A request whose body was cut short at capture needs a replacement body. A replay
ends as pending, completed, failed, or unknown. Unknown means the server may have received the
request. Only a failure marked "not sent" is certain not to have reached it. The inspector keeps
the latest 1000 finished replays; retrying an older one is refused as expired, and it may have been sent.

**Storage.** `maxDiskBytes` covers captures, pending replays, and body drafts. The inspector
prunes old captures to stay within it. When the remaining space holds only data that cannot be
pruned, new replays are refused. Usage can briefly pass the limit while it writes or cleans up.
If another program keeps the inspector's database open, capture shows storage blocked and
drops new flows until it closes.
