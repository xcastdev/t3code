# @t3tools/plugin-sdk

Build trusted T3 Code plugins: panels that live beside chat, an optional backend that runs in the environment, and operations that both panels and agents can call.

## Trust

A plugin with a backend runs with the ordinary privileges of the OS account that runs T3 Code. T3 runs it in its own process to contain crashes, not to sandbox it. Installing a backend asks the user to confirm they trust its author. Only install plugins you would run as a script.

Panels run in a sandboxed frame. They get no T3 credentials, no filesystem access, and no network path to your backend. Everything goes through the T3 bridge.

## Layout

```
my-plugin/
  t3-plugin.json      manifest
  ui/main.html        one HTML file per panel
  ui/main.ts          optional; bundled and inlined into main.html
  backend/index.ts    required when the manifest declares a backend
```

Pack it with `packPlugin(dir, "dist/my-plugin-1.0.0.t3plugin")` from `@t3tools/plugin-sdk/pack`.

## Manifest (`t3-plugin.json`)

| Field                   | Meaning                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion`       | Always `1`.                                                                                                                                             |
| `id`                    | 2 to 23 chars, lowercase letters and digits in hyphen-separated segments (`request-inspector`).                                                         |
| `name`, `author`        | Shown to the user. `author` is who the user trusts on install.                                                                                          |
| `version`               | Semver. An update is an explicit package replacement.                                                                                                   |
| `hostApi`               | `"1.1"` (or `"1.0"`). Compatible when the major matches and the minor is at most the host's.                                                            |
| `ui.panels`             | `{ id, title, entry, icon? }`. `entry` is a relative `.html` path.                                                                                      |
| `ui.commands`           | `{ id, title, opens: { panel } }`. Users bind keys to `plugin.<id>.<commandId>`.                                                                        |
| `backend.entry`         | Relative `.cjs` path the backend is bundled to, such as `backend/index.cjs`.                                                                            |
| `backend.operations`    | `{ name, title, description, inputSchema, mutates, agent }`. `agent: true` exposes it as an agent tool, which needs `inputSchema.type === "object"`.    |
| `backend.topics`        | `{ name }` subscription topics.                                                                                                                         |
| `backend.resources`     | `{ name, title, operation }`, read by agents as `t3-plugin://<id>/<name>` through a non-mutating operation.                                             |
| `backend.prerequisites` | `{ executable, hint }`. T3 checks `PATH` before starting the backend and shows `hint` when one is missing.                                              |
| `settings`              | `client` and `environment` fields (`string`, `number`, `boolean`, `enum`, `secret`). The backend receives environment values as `config` and `secrets`. |
| `capabilities`          | `chat.attach` (insert text), `chat.reference` (attach references), `file.save` (download a file), `clipboard.write`. The last two need host API 1.1.    |

Packing fails with the validator's message when the manifest is invalid.

## Limits

Every payload is JSON measured in UTF-8 bytes. Nothing large travels whole.

- Operation input, operation result, stored panel state, and a subscription snapshot: 240 KiB.
- One bridge message or worker line, envelope included: 256 KiB.
- One subscription batch: 64 KiB. The SDK splits a larger batch in order under one revision. A single item over 64 KiB throws.
- Binary bodies move in chunks of at most 128 KiB raw (base64 in JSON).
- A panel HTML file: 5 MiB after inlining. A package: 50 MiB.
- An operation call times out after 30 seconds and is never retried.

## Panels

```ts
import { connectT3 } from "@t3tools/plugin-sdk/ui";

const t3 = await connectT3();
const saved = await t3.state.get();
if (saved !== null && saved.version === "1.0.0") restore(saved.value);

const result = await t3.call("search", { query: "foo" });
const stop = t3.subscribe("ticks", {}, (event) => {
  // snapshot { items, revision, cursor } | batch { items, revision } | resync | closed { reason }
});
```

- A panel can be reloaded at any time: on another device, after a thread switch, or after an update. Restore from `state.get()`, and check its `version` (the plugin version whose UI wrote it) before trusting the shape of `value`.
- On `resync`, drop what you hold for that subscription. A new `snapshot` follows. Page older items with your own non-mutating operation that takes the snapshot's `cursor`.
- A call made after the plugin was updated fails with reason `version-changed`. Errors are `T3PluginError` with a `reason`.
- `attach({ kind: "text", text })` needs a click or key press and the `chat.attach` capability. The user confirms the destination.
- `saveFile(name, mimeType, data)` saves a file on the device that shows the panel, at most 32 MiB. It needs a click or key press and the `file.save` capability. `data` is a string, bytes, or a stream (`() => AsyncIterable<Uint8Array>`). Call it from the click handler: the save starts before the stream is read, so a slow export still counts as clicked. Give `{ size, chunks }` when you know the size and the host checks it. It resolves to `"saved"` or `"cancelled"`, but `"cancelled"` is best-effort: the mobile share sheet reports `"saved"` even when dismissed.
- `copyText(text)` needs a click or key press and the `clipboard.write` capability.
- `listChatTargets(query?)` returns up to 50 threads and 50 projects in the plugin's environment, for pickers.
- `t3.hostApi` is the host's bridge version. Clients refuse to show a panel whose manifest `hostApi` is newer than theirs.
- Panels must be self-contained. `src=` or `href=` attributes that point at relative paths fail packing. Put code in `ui/<panel>.ts` and inline images as `data:` URLs.

## Backends

```ts
import { definePluginBackend, materializeAsset } from "@t3tools/plugin-sdk/backend";
import addon from "./addon.py";

definePluginBackend({
  operations: {
    search: async (input, ctx) => {
      // ctx: { caller: "ui" | "agent", context, host, signal, dataDir, config, secrets, log }
      return { items: [] };
    },
  },
  topics: {
    ticks: (params, emit) => {
      emit.snapshot({ items: [], revision: "0", cursor: null });
      const timer = setInterval(() => emit.batch([{ at: Date.now() }], String(Date.now())), 1000);
      return () => clearInterval(timer);
    },
  },
  onStart: async (ctx) => {
    // ctx.previousVersion is set after an update: migrate data in ctx.dataDir here.
  },
  onStop: async () => {
    // Stop child processes you started. The process exits after this.
  },
});
```

- The backend is bundled into one CommonJS file that may import only Node builtins at runtime. There is no `node_modules` and no install step. Packing fails on an unresolved package, a native `.node` addon, or `require()`/`import()` with a computed path.
- Native code ships as an external executable listed in `backend.prerequisites`.
- Text assets (`.txt`, `.py`) are imported as strings and embedded in the bundle. When a tool needs a real file, call `materializeAsset(name, contents)`. It writes `<dataDir>/runtime/<hash>-<name>` once per content and returns the absolute path.
- Each operation gets an `AbortSignal` that fires when the caller gives up. A mutation that can run longer than 30 seconds must enqueue the work, return an id right away, and offer a non-mutating operation to read its outcome. A timed-out call may still finish, so make retries safe.
- A topic must emit a `snapshot` before any `batch`. A snapshot over 240 KiB throws: return a window and a cursor instead.
- `ctx.context` is the caller's chat as the host resolved it: `{ projectId, thread: { id, parentThreadId, rootThreadId, relationshipToParent } | null }`. A panel docked beside a chat, or an agent in a thread, gets one. Otherwise, and on hosts before API 1.1, both fields are `null`.
- `ctx.host.resolveContext({ threadId })` or `({ projectId })` checks an id the caller passed and returns its context, or `null` when it is unknown or deleted. Never trust an id from input without it. Hosts before API 1.1 never answer, so the call rejects when the operation's signal aborts.
- `log(message)` and anything written to stderr go to the plugin's log in Settings. Keep secrets and request bodies out of it.
- `dataDir` survives uninstall until the user deletes the plugin's data.

## Testing a packed plugin

`@t3tools/plugin-sdk/testing` runs your packed archive with no T3 server:

```ts
await packPlugin(dir, archive);
await extractPluginArchive(archive, installDir);
const backend = startPackedBackend({ entryPath: `${installDir}/backend/index.cjs`, dataDir });
await backend.initialize();
await backend.invoke("search", { query: "foo" }).result;
// Pass a caller context, and answer ctx.host.resolveContext with startPackedBackend({ resolveContext }).
await backend.invoke("search", { query: "foo" }, "agent", { projectId: "p1", thread: null }).result;
await backend.close();
```
