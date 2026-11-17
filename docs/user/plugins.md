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

To keep a panel on the right-panel rail, pin it in **Settings → Plugins**. Pins are per device and
show where the panel can dock beside a chat. Right-click a pinned item on the rail to unpin it.
There are no pins on mobile.

On mobile, open plugin panels from Settings or the command palette. Plugin settings are edited
on web.

## Let an assistant use plugin tools

Assistants can call a plugin's tools only if you select them. In the assistant's resource
bindings, choose the operations under **Plugin tools**. Plugin resources are not available to
assistants. In an ordinary thread, tools that change state need the thread to have full access and
the default mode. Provider support varies, and not every provider can call plugin tools.

## Request Inspector

The Request Inspector runs local mitmproxy proxies, records the HTTP traffic you send through them,
and lets you search, export, decode, and replay it. Install [mitmproxy](https://mitmproxy.org) so
`mitmdump` is on the environment's PATH.

**Proxies and recordings.** Create a proxy, start it, and point your client at it, for example
`curl -x http://127.0.0.1:8080`. A running proxy forwards traffic but keeps nothing until you start
a recording on it. You can run several proxies at once. Leave the port on auto to use the first
free one.

**Import saved flows.** Choose **Import…** in the Requests view to add a mitmproxy `.mitm` dump
or a HAR file as a new recording, named after the file, under the proxy you pick. **Upload from
this device** picks a file on the device you are using. **Choose on** the environment's machine
opens the command palette to browse that machine's files, so nothing is uploaded; on mobile, type
the file's path instead (`~/` works). An upload can be at most half the storage budget; choose a
larger file on the environment's machine instead. Large files
import in the background, and the recording fills in as they do. Only HTTP and WebSocket flows are
kept; TCP, UDP, and DNS flows are skipped. Imported bodies are cut at the same size limit as
recorded ones, and imports count against the storage budget: when it is full, an import
keeps what it has read and drops the rest. A HAR file is loaded into memory whole on the
environment's machine, so for very large captures prefer a `.mitm` dump. Delete the recording to stop an
import.

**Link a proxy to a chat.** Link a proxy to a chat or a project, and agents there use it without
being told which. A chat or project can link several proxies; the most recently linked one is the
default, and linking a proxy again makes it the default. An agent can still use any other proxy by
picking it.

**Pass-through and ignored hosts.** Both skip decryption, so no certificate is needed for them.
Pass-through hosts still appear as a row with host, timing, and bytes, but not their contents.
Ignored hosts are forwarded and not recorded at all. Patterns look like `example.com` or
`*.example.com`, optionally with `:port`.

**Upstream proxy.** A proxy can forward to another HTTP(S) proxy, with optional credentials, or
listen as SOCKS5. SOCKS5 listening cannot be combined with an upstream proxy.

**Export.** Export requests as HAR, cURL, raw HTTP, JSON, fetch, or Python. Exports keep headers
as recorded, including cookies and authorization, so treat them as secrets. To export or replay
several requests at once, turn on **Select** in the request list and tick them. In the panel the
export downloads to your device.
When an agent exports, large results are written to the inspector's exports folder on the
environment, and the agent copies the file where it needs it.

**What agents see.** The panel shows every header as recorded. When an agent reads, exports,
formats, or decodes requests, and in requests you attach to a chat (as a reference or as text),
credential headers such as `Authorization`, `Proxy-Authorization`, and `X-Api-Key` show as
`[redacted]`, as do headers named like tokens, secrets, keys, sessions, JWTs, or signatures (such
as `Private-Token`). `Cookie` and `Set-Cookie` keep cookie names with `[redacted]` values.
Credentials in URLs, query strings, and bodies are not redacted. Redaction keeps credentials out of
the model's context by accident; it does not stop a determined agent with shell access, which can
read the inspector's data on the environment's machine. An agent gets the values only by asking
for them explicitly, so tell it when it needs a token. An agent can still replay a request that
carries them: a header it leaves as `[redacted]` is sent with the recorded value, but only to the
request's recorded scheme, host, and port. When an agent replays to another destination, recorded
credentials are left out unless it asks to send them. Agents can create proxies that listen on
loopback or on the default listen host from the plugin's settings; choose any other listen host in
the panel yourself.

**HTTPS.** To capture HTTPS, trust the inspector's certificate in the client you are testing. The
certificate helper shows the file paths and the system trust commands for your OS; run those
yourself, since they need `sudo`. On Linux it can also install the certificate into Chrome and
Firefox certificate stores on the environment's machine. Remove it when you are done, with the
removal commands the helper shows.

**Replayer and Decoder.** The Replayer edits a request and sends it again. The Decoder applies
steps such as base64, URL, and gzip decoding to a header or body value.

**Replay.** A replay shows its destination first. It does not follow redirects, so a 3xx is
recorded as-is. A request whose body was cut short at capture needs a replacement body. A replay
ends as pending, completed, failed, or unknown. Unknown means the server may have received the
request. Only a failure marked "not sent" is certain not to have reached it. The inspector keeps
the latest 1000 finished replays; retrying an older one is refused as expired, and it may have been sent.

**Storage.** `maxDiskBytes` covers recordings, exports, pending replays, and body drafts. To stay
within it, the inspector deletes old exports first, then prunes the oldest recorded requests.
When the remaining space holds only data that cannot be pruned, new replays are refused. Usage
can briefly pass the limit while it writes or cleans up. If another program keeps the
inspector's database open, recording shows storage blocked and drops new flows until it closes.
