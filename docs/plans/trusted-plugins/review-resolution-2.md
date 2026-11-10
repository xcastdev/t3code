# Review resolution 2: implementation-plan.md

Validator: Opus 5.5 (design subagent). I checked each finding from the primary's second adversarial pass against the worktree source (`t3-ca5fe124`), the approved `design.md`, and the plan. Then I revised `implementation-plan.md` in place and reread the whole plan for new contradictions. `review-resolution.md` is unchanged and remains the record of the first pass. The pre-revision copy is at `/tmp/claude-1000/-home-user--local-share-t3-worktrees-t3code-t3-ca5fe124/63831f83-95b3-4443-bae5-c712e8ff7da1/scratchpad/implementation-plan.before-r2.md`.

No product code changed. I installed nothing, started no servers or probes, made no commits, and spawned no subagents. The only file reads were of source.

This is not final approval. The primary rereviews it independently.

## Verdicts

| #   | Finding                                                             | Verdict  |
| --- | ------------------------------------------------------------------- | -------- |
| 1   | The archive excludes `addon.py`                                     | Accepted |
| 2   | Replay's timeout outcome is ambiguous                               | Accepted |
| 3   | No snapshot cursor protocol                                         | Accepted |
| 4   | An open UI goes stale after an update                               | Accepted |
| 5   | Commands lose environment identity and the command-to-panel mapping | Accepted |

I found no false positives.

## 1. Missing addon asset: accepted

**Evidence**

- Before this revision, Task 3's `packPlugin` said the archive holds only the manifest, panel HTML, and the one backend file.
- Task 13 ran `mitmdump … -s addon.py`, a relative path to a file that was never packed. The integration tests ran from the package source, so they would not have caught it.
- `mitmproxy/addons/script.py:23-57` (`load_script`) puts the script's directory on `sys.path` while it loads. Wherever the addon is written, that directory needs to hold nothing else.

**Plan changes** (smallest model that keeps the single builtins-only `.cjs`)

- New decision row, "Backend assets":
  - `packPlugin` uses esbuild `loader: { ".py": "text", ".txt": "text" }`, so imported text assets are embedded in the `.cjs`.
  - The SDK's `materializeAsset(name, contents)` writes the asset to `<dataDir>/runtime/<sha256-16>-<name>` (temp file plus rename, mode 0600) and returns the absolute path.
  - The archive still holds exactly the manifest, panel HTML, and backend entry. That means no manifest asset list and no extraction rules. SEA and Electron-as-Node portability are unchanged.
- Task 3:
  - New `materializeAsset` and a `./testing` export (`extractPluginArchive`, `startPackedBackend`).
  - The echo fixture embeds `hello.txt` and gains an `asset` operation.
  - New tests: `embeds an imported .txt asset…the archive lists exactly…` and `materializeAsset writes once per content hash`.
- Task 6: `packed backend materializes its embedded asset under dataDir/runtime`. This runs from a package installed outside the repository through the server path.
- Task 13:
  - `index.ts` imports `./addon.py` as text, and `mitm.ts` passes the materialized absolute path to `-s`.
  - The unit test checks the argv.
  - `integration/` runs only the packed archive, extracted under `os.tmpdir()`, and asserts that the archive has no `addon.py` entry.
  - Step 4 no longer cites an unspecified server-path check. It points to the three layers that prove it.
- Task 15 Step 5b runs capture, search, replay, and `get_replay` from the installed package on the release binary, then checks that the worker and mitmdump PIDs are gone.

## 2. Replay timeout outcome is ambiguous: accepted

**Evidence**

- The supervisor's `invoke` had a 30 s timeout (Task 6).
- The transient replay had its own 30 s timeout, which started later, after mitmdump started (Task 13).
- A capture-mode replay had no deadline at all.
- `replay_request` returned only after settling. The caller could therefore see a failure while the upstream mutation still ran, with no id to reconcile and no safe way to retry.

**Plan changes** (enqueue-and-query)

- New decision row, "Long-running mutations".
  - `PluginRequestError` gains `timed-out`, whose message says a state-changing operation may still finish.
  - The worker protocol gains a `cancel { id }` notification. The SDK exposes it as `OperationContext.signal`.
  - The supervisor sends `cancel` on timeout or interruption (client disconnect, MCP abort), drops late responses, and never retries.
  - The README tells authors that a mutation that can exceed 30 s must enqueue.
- Inspector:
  - `replay_request` requires an `idempotencyKey` and returns `{ replayId, state: "pending", destination }` once the replay is accepted.
  - The same key with the same input returns the existing replay and sends nothing. The same key with different input is refused.
  - An abort before acceptance records nothing. After acceptance, a disconnect or abort does not stop the replay.
  - States are `pending`, `completed`, `failed`, and `unknown`, with a `dispatched` flag. A 10 s startup limit before dispatch gives `failed` with `dispatched: false`. A 30 s deadline after dispatch gives `unknown`. Worker restart or mitmdump exit settles pending rows by the same rule.
  - Only `completed` and undispatched `failed` are definite. Exactly-once delivery is explicitly not promised.
  - New agent operation `get_replay { replayId, waitMs ≤ 20000 }`, which needs no polling loop and stays inside the invoke budget.
  - The UI keeps the key and `replayId` in bridge state and sees state changes through the `requests` topic.
- Tests:
  - Task 6 (`it.effect` plus `TestClock` over in-memory streams, no wall clock): timeout sends cancel and drops the late response, and interruption sends cancel.
  - Task 13 unit tests (injected timer and spawner): pending before the upstream answers, idempotent retry dispatches once, key reuse with different input is refused, abort before and after acceptance, the deadline gives `unknown` and stops the transient PID, a never-connecting transient gives `failed`, restart recovery, and `get_replay` wait.
  - Task 13 integration: a delayed upstream whose response is released on test milestones, never sleeps. Its same-key retry produces one upstream request.
- Eval case (f): the agent calls `get_replay` after `pending` and does not reissue with a new key.
- Task 15 checks a delayed-upstream replay in the UI. Docs cover the outcome states.

## 3. Snapshot cursor protocol missing: accepted

**Evidence**

- `PluginSubscriptionEvent` had only `items` (Task 2).
- The SDK's `emit.snapshot(items)` and the worker's `event { kind, items }` (Task 3) had no cursor.
- Task 7 promised "window plus cursor" that nothing carried.
- Overflow said "the next event is a snapshot", but no protocol message made the worker produce one.

**Plan changes**

- `PluginSubscriptionEvent` moves to Task 1 contracts as one schema from SDK to worker to RPC to bridge:
  - `snapshot { items, revision (≤ 128), cursor (≤ 1024) | null }`
  - `batch { items, revision }`
  - `resync`
  - `closed { reason }`, with an enumerated reason
- Host invariants:
  - The first event of a worker subscription must be a snapshot, or the subscription closes with `protocol-error`.
  - Size caps give `too-large`.
  - The host never reads `items`.
  - On overflow it unsubscribes the worker subscription, emits `resync`, and resubscribes under a new id, dropping late events from the old id. This needs no new protocol message.
- The SDK throws on a batch before the snapshot and splits oversize batches under one revision. The host splits batches of more than 200 items the same way.
- Item identity and paging stay in the plugin. In the inspector:
  - `seq` is a store-wide change counter, and `revision` is its high-water mark.
  - Cursors are keyset-bounded at snapshot time, so new rows arrive only as batches.
  - Items upsert by id with the highest `seq`. A prune is sent as `removed`.
  - The panel discards page results from a stale revision.
- Tests:
  - Contracts decode.
  - Bridge passes `revision` and `cursor` through.
  - SDK enforces ordering and splitting.
  - Supervisor raises `protocol-error` for a batch before the snapshot.
  - Service overflow resubscribes and drops old-id events.
  - Inspector paging while 100 records are inserted and 10 updated yields each record exactly once.

## 4. Open UI stale after update: accepted

**Evidence**

- `apps/web/src/assets/longLivedAssetUrls.ts:35-63` keys its family by `JSON.stringify([environmentId, resource])` and re-mints only within `minLifeMs` of expiry.
- The plan's `plugin-panel` resource had only `{ pluginId, panelId }`. After an update, a remount would reuse the cached URL, whose token was bound to the old version and now returns 404.
- An open frame had no update signal, so old UI could call the new backend.

**Plan changes**

- New decision row, "Panel revision identity":
  - `plugin-panel` gains `version`. That puts the version in the signed resource and the cache key. The server serves only the active version.
  - Frames and bridges are keyed by `${panelKey}@${version}`. A registry version change from any client disposes the bridge (releasing subscriptions), mints a new URL, and remounts.
  - UI calls and subscribes carry `expectedVersion`. A mismatch fails with `version-changed` before reaching the worker.
  - `update` closes subscriptions with `plugin-updated`, and `uninstall` with `plugin-uninstalled`.
  - Panel state is preserved and returned as `{ value, version }`, so new UI decides whether it can use older state.
  - A failed update shows the status and `failedUpdate` text with Restart and Logs, and mounts no frame.
  - The surface also shows a not-installed state.
- Tests:
  - Task 2: `state.get` returns the version.
  - Task 4: client reinstall keeps state.
  - Task 7: stale `expectedVersion`, and update closes subscriptions.
  - Task 8: a non-active version is not found.
  - Task 10 browser test: another client updates v1 to v2 while the panel is open. The old subscription is released, `src` names v2, and the state keeps `version: "1"`.
  - Task 15: a two-browser update check.
- Mobile (Task 11) follows the same keying, state, and `expectedVersion` rules.

## 5. Command identity and mapping: accepted

**Evidence**

- `PLUGIN_OPEN_COMMAND_PATTERN` was `plugin.<pluginId>.<contributionId>`. Task 10 dispatched `plugin.<id>.<panel>`. The converter's command `open` targets panel `converter`, and Task 1's test decodes `plugin.converter.open`, so the mapping was inconsistent.
- The command carried no environment. The sidebar lists every connected environment, and an id can exist in A, B, and on the client.
- `apps/web/src/shortcuts/dispatcher.ts:60-73` looks handlers up by exact command string. The only fallback-style resolution is ChatView's script fallback (`ChatView.tsx:2779-2783`), which lives only while ChatView is mounted. That would not work for opening plugins without a chat.

**Plan changes**

- New decision row, "Command resolution":
  - Keybindings name `plugin.<pluginId>.<commandId>`, a `ui.commands` id, and resolve to a panel only through `opens.panel`. Task 1 validates that `opens.panel` names a declared panel.
  - Precedence: (1) the current chat's environment, (2) the client install, (3) the only connected environment. Otherwise the palette opens with the command title as its query (`openCommandPalette({ query })`, `commandPaletteBus.ts:16-28`) and lists one item per scope.
  - Sidebar, palette items, Settings, and mobile always carry explicit `PluginPanelKey`s with scope labels.
- `PluginPanelKey` moves to `packages/client-runtime/src/plugins/commands.ts`, created in Task 4, because Task 4's stores key state by it. That also fixes an ordering defect: previously the key was defined in Task 10 but used in Task 4.
- Task 10 adds `listPluginPanelTargets` and `resolvePluginCommand` there. Mobile reuses them in Task 11.
- New `apps/web/src/shortcuts/pluginCommands.ts` registers a dynamic `registerCommands` scope, rebuilt when the registry or client store changes, so keybindings work with no chat.
- Tests:
  - `commands.test.ts` table: command-to-panel mapping, the A/B/client precedence rows, no chat with only B, no chat with A and B giving `choose`, unknown giving `missing`, and distinct labeled targets.
  - Task 15 installs the converter in A, B, and on the client.
- Task 5 now states that an environment accepts UI-only packages (no trust flag, no worker), which the duplicate case depends on. The surface shows "not running" only when a backend exists.

## Whole-plan consistency changes

- Self-review notes: type ownership is updated (`PluginSubscriptionEvent` and the new error reasons in Task 1; `materializeAsset`, `signal`, `cancel`, and `./testing` in Task 3; `PluginPanelKey` in Task 4; resolution helpers in Task 10). Spec coverage and byte budgets are extended.
- Review Focus items 3 and 4 are rewritten. Items 9 through 11 are new.
- The global panel-identity constraint now says the loaded frame is also keyed by version.
- Task 14 docs cover asset embedding, enqueue-and-query, envelope invariants, version identity, keybinding precedence, and replay outcomes.
- Line references verified this pass: `longLivedAssetUrls.ts:35,63`, `dispatcher.ts:60,69`, `commandPaletteBus.ts:16,28`, `ChatView.tsx:2779-2783`, `projectScripts.ts:68-80`, `mitmproxy/addons/script.py:23-57`.

## Remaining limits and questions

1. **I did not run any probes this pass.** The esbuild text loader and mitmdump's `-s <absolute path>` are standard behavior. The Task 13 packed-archive integration suite and Task 15 Step 5b are the proof.
2. **Replay `unknown` is an honest but weak outcome.** Matching a late upstream response after the deadline is not attempted. The 30 s post-dispatch deadline is a choice, not a measured value. Maintainers may want it configurable.
3. **The agent must supply `idempotencyKey`.** It is required, so a retry is safe only if the model reuses the key. Eval (f) guards the reissue behavior, but pass rates are unknown until Task 13 runs.
4. **Keybinding precedence prefers the current chat's environment over the client copy.** That is a product choice. The reverse (client first) would also be deterministic.
5. **UI-only packages installed into an environment.** I made the store accept them explicitly so that environment duplicates are real. If maintainers want environments to hold only backend packages, the duplicate case shrinks to client plus environments with backends, and the resolution logic is unchanged.
6. The earlier open questions in `review-resolution.md` (SEA `createRequire` from an absolute path, Electron's Node version, project-team roles, iframe reload on ChatView remount) still stand.
