# Review resolution: implementation-plan.md

Validator: Opus 5.5 (design subagent). I checked each finding against the worktree source (`t3-ca5fe124`) and the approved `design.md`, then revised `implementation-plan.md` in place. The pre-revision copy is at `/tmp/claude-1000/-home-user--local-share-t3-worktrees-t3code-t3-ca5fe124/fd380ad8-fd38-4c42-80da-a9d29d67e46c/scratchpad/implementation-plan.before.md`.

No product code changed. I installed nothing, started no servers, made no commits, and spawned no subagents. The only process I ran outside planning was a throwaway mitmproxy replay probe in the scratchpad: a local Python server, stopped by its captured PID.

This is not independent final approval. The primary agent rereviews it.

## Verdicts

| #   | Finding                                            | Verdict                                                        |
| --- | -------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Backend packages not self-contained                | Accepted                                                       |
| 2   | Assistant tool policy cannot represent plugin keys | Accepted                                                       |
| 3   | Panel still needs a selected thread                | Accepted                                                       |
| 4   | Replay fidelity via Node fetch                     | Accepted. The fix replaces `fetch` with mitmproxy's own replay |
| 5   | Data budgets disagree                              | Accepted                                                       |
| 6   | `a--b` plugin id collides in tool names            | Accepted, reproduced                                           |
| 7   | Task 9 eval imports a manifest created in Task 13  | Accepted. Task 12 had the same defect                          |

## 1. Backend packages not self-contained: accepted

**Evidence**

- Before the fix, `packPlugin` bundled panels only. The echo and inspector backends import `@t3tools/plugin-sdk/backend`.
- Packages extract under `stateDir/plugins/packages/...`, which has no `node_modules`.
- In a worktree, `stateDir` is `<worktree>/.t3`. Bare imports would therefore resolve from the repo's `node_modules`, and dev tests would pass while real installs fail.
- The release runtime is a Node SEA. See `HostProcess.IsExecutable = NodeSea.isSea()` and `docs/operations/release.md:47-49`.
- `scripts/lib/cli-executable-imports.ts:5` says SEA imports resolve only builtins and file-backed code must load through `createRequire`. Server code does exactly that, for example `apps/server/src/preview/ServerBrowserContexts.ts:12-13`.
- The plan's `import(pathToFileURL(entry))` was therefore unsafe on the shipped runtime.

**Plan changes**

- New decision row "Backend artifact":
  - `backend.entry` must be one `.cjs` file.
  - esbuild bundles it as CJS for Node with `target: "node22"`, SDK included.
  - Pack fails on external non-builtin imports, `.node` addons, and computed `require`/`import()`.
  - The worker loads the file with `createRequire(import.meta.url)(absPath)`.
  - Native code ships as an external prerequisite.
- The Worker transport row states runtime portability. The worker spawns via `resolveSelfInvocation`/`selfInvocationArgs`, so it runs on dev Node, the SEA, or Electron-as-Node (inheriting `ELECTRON_RUN_AS_NODE`), with no `node` needed on PATH.
- Task 1: manifest validation requires a relative `.cjs` entry.
- Task 3:
  - The SDK backend uses Node builtins only.
  - New echo fixture in `packages/plugin-sdk/src/testFixtures/echo`.
  - `packPlugin` bundles and checks the backend.
  - Three new pack tests.
- Task 5: refuses a package whose backend entry is missing.
- Task 6:
  - The `bin.ts` branch loads via `createRequire`, never `import(pathToFileURL)`.
  - The test helper packs the fixture and installs it into an `os.tmpdir()` state dir, then asserts no ancestor `node_modules` exists. New test: `packed backend runs from a state dir outside the repository`.
- Task 13 Step 4 repeats the outside-repo check on the packed inspector.
- Task 15 Step 5b adds a packaged-binary smoke: `build:exe` with a scratch `--home-dir`, install, start, search. It also adds a desktop Electron-as-Node start check.
- `node:sqlite` stays. The server already loads it in all runtimes (`apps/server/src/serverOwnership.ts`).

## 2. Assistant tool policy cannot represent plugin keys: accepted

**Evidence**

- `AssistantResourceSelection.mcpTools` holds only `{ definitionId, toolNames }` (`packages/contracts/src/assistants.ts:39-54`).
- Snapshot `toolIds` are built from that field alone (`AssistantResources.ts:139,152`).
- `AssistantNativeResources.ts:49-54` intersects the snapshot with `${definitionId}:${name}`.
- The gateway filters tools by `${transportDefinitionId}:${tool.name}` (`McpCatalogGateway.ts:141-180`). Under any policy it hides resources, templates, and prompts, and refuses reads (`:182-183,203-204,224-226`).
- `plugin:<id>:<op>` could never appear in the snapshot. The web (`AgentResourceBindings.tsx:261-292`) and mobile (`AssistantResources.tsx`) selection UIs know only MCP definitions.

**Plan changes**

- New decision row "Assistant policy".
- Task 9 now has an end-to-end assistant path:
  - Contracts: `AssistantResourceSelection.plugins` is an `optionalKey`. It stays absent when empty, so the canonical configuration hash of stored assistants is unchanged (`AssistantResources.ts:23-26`).
  - Both `toolIds` builders append `pluginToolPolicyKey`, and the `current` set in `AssistantNativeResources` includes plugin keys.
  - New client-runtime helper `setAssistantPluginOperations`, plus a "Plugin tools" checkbox row on web and mobile with an "Unavailable plugin" fallback.
  - The gateway filters list and call on `plugin:<id>:<op>`.
- Resource policy is explicit: plugin resources follow today's rule, hidden and read-refused whenever an assistant policy applies.
- Tests: gateway (selected/unselected, resources hidden under a policy, read without one), `AssistantNativeResources` (admitted vs deselected), and contracts decode of a stored config without `plugins`.
- Task 1 adds `pluginToolPolicyKey`, `pluginResourceUri`/`parsePluginResourceUri` (`t3-plugin://<id>/<name>`), and `pluginAgentTools`. Manifest resources now name a declared non-mutating operation.
- New ordering fix found during self-review: the selection UI needs registry atoms, which were created in Tasks 10 and 11. They moved to Task 7 (client-runtime, web, and mobile `state/plugins.ts`), and Task 7 typechecks web and mobile.

## 3. Panel still needs a selected thread: accepted

**Evidence**

- `ChatView.tsx:1081-1083`: `usePanelPresence(rightPanelOpen && activeThreadRef !== null, …)`.
- `:3260`: `rightPanelContent = activeThreadRef ? <RightPanelSurfaceContent …> : undefined`.
- `RightPanelSurfaceContent` requires `threadRef` (`chat/RightPanelSurfaceContent.tsx:70`).
- ChatView is keyed per draft or handoff (`ThreadRouteView.tsx:150,174,198`), so it can remount.
- No route rendered a panel without a chat. The precedent for thread-free pages is `_chat.pull-requests.tsx`.

**Plan changes**

- New decision row "Panel hosts". Task 10 is rewritten:
  - **Page host:** `apps/web/src/routes/_chat.plugins.$scope.$pluginId.$panelId.tsx` with `PluginPanelPage`. It needs no thread. Its `chatTarget` is the most recent thread in scope, or `null`, in which case attach refuses with "Open a chat to attach this.".
  - **Dock host:** ChatView renders `PluginPanelSurface key={panelKey}` before, and independent of, the `activeThreadRef` branch. The presence condition becomes `(rightPanelOpen && activeThreadRef !== null) || docked !== null`. `RightPanelSurfaceContent` is left unchanged.
  - `resolvePluginOpenTarget` and `openPluginPanel` route every entry point (sidebar, command palette, keybinding, Settings) to dock or page.
  - `PluginPanelSurface` takes `panelKey`, never a thread ref. Bridge `state` is keyed by `PluginPanelKey` in the client plugin store, for client and environment panels alike, so state survives thread switches, route changes, and remounts.
  - Tests: an `openPluginPanel` table, plus `PluginPanelPage.browser.test.tsx` covering no-chat opening and state restored after unmount and remount.
- Task 13's inspector UI keeps its filter and selection in bridge `state`, which is what Task 15's "filter persists" check relies on.
- Task 15 checks no-chat opening from the sidebar.
- Review Focus item 8.

## 4. Replay fidelity: accepted. The fix replaces `fetch` with mitmproxy replay

**Evidence**

- The plan's `backend/replay.ts` used Node `fetch`. Its defaults follow redirects and decode content encoding. Its `Headers` merges duplicates (except `getSetCookie`).
- `/usr/lib/python3.14/site-packages/mitmproxy/addons/clientplayback.py` (mitmproxy 12.3.1, installed here) provides `replay.client` (`ReplayHandler`) and `check()`, which refuses live, intercepted, WebSocket, and missing-content flows.
- **Probe** (scratchpad `replayprobe/`): `mitmdump --set server=false` with an addon that built a flow and called `replay.client` against a local server.
  - Result: `status=302` (not followed), upstream received `X-Dup=['1','2']` and the exact binary body, response `set-cookie=['a=1','b=2']`, and `raw_content` was still gzip.
- **Second probe:** the `http.Request(...)` constructor keeps `content` raw. `Request.make` re-encodes per `Content-Encoding` (`raw_content == z` → `False`) and rewrites Content-Length (`mitmproxy/http.py:523-537,631`).

**Plan changes**

- New decision row "Replay engine".
- Task 13 is rewritten around `backend/mitm.ts`, `addon.py` replay handling, and `backend/replay.ts`:
  - The addon constructs `http.Request` directly, with raw bytes from a body file, wraps it the way `view.flows.create` does, and calls `replay.client`.
  - The result is reported from the `response`/`error` hooks (`is_replay == "request"`).
  - A running capture's mitmdump does the replay. Otherwise a transient `--set server=false` mitmdump starts and is stopped by captured PID.
- Promised semantics:
  - Redirects are never followed.
  - Header order and duplicates are preserved.
  - Bodies are byte-exact, and the response is stored raw.
  - Upstream TLS is verified (default `ssl_insecure=false`). The HTTP version is advisory.
  - An edited body updates an existing `Content-Length` and never touches `Transfer-Encoding`.
- Refusals:
  - A truncated captured request body without a replacement fails with `operation-failed` and an explicit detail. `PluginRequestError` gains `operation-failed` with bounded `detail`.
  - WebSocket and non-HTTP flows are refused.
  - A truncated response does not block replay.
- Store: ordered header byte pairs, raw wire bodies with `capturedBytes`, `declaredBytes`, `truncated`, and `contentEncoding`.
- Tests:
  - Unit: incomplete-body refusal, Content-Length rewrite.
  - `integration/` (real mitmdump): a 302 with duplicate headers, binary request, and gzip response, replayed through a running capture and through the transient engine, which must exit.
- The mitmproxy requirement keeps the earlier fix: an explicit `test:mitmproxy` script, no conditional skip, no invented quarantine issue.

## 5. Data budgets disagree: accepted

**Evidence**

- Before the fix:
  - Worker responses: ≤ 1 MiB (Task 6).
  - Bridge: 256 KiB, app-to-host only (Task 2). The bridge constant is at `client-runtime/src/mcpApps/host.ts:7`.
  - Captured bodies: 1 MiB.
  - `get_request` body: ≤ 64 KiB, with no range access.
- The server WebSocket has no frame cap. A grep for `maxPayload` found none.
- Logs could return 500 × 2 KiB = 1 MiB.

**Plan changes**

- New decision row "Payload budgets". Task 1 defines one constant set, `PLUGIN_LIMITS`:
  - `maxPayloadBytes` 240 KiB (operation input, result, resource read, state, snapshot)
  - `maxMessageBytes` 256 KiB (bridge in both directions, worker NDJSON line)
  - `maxBatchBytes` 64 KiB
  - `maxBodyChunkBytes` 128 KiB raw. As base64 that is 174,764 bytes, which fits under the payload cap with its envelope.
  - `maxPendingRequests` 16
  - A Task 1 test guards the arithmetic.
- Task 2: the cap applies in both directions, with a host-to-app too-large test, and `state.set` uses `maxPayloadBytes`.
- Task 6: the 1 MiB response cap is replaced, a too-large test is added, and logs return the newest lines that fit.
- Task 7: RPC input and result caps, a test that oversize input never reaches the worker, and a snapshot window plus cursor.
- Task 13:
  - Agent and UI share one body interface: `get_request` previews (≤ 32 KiB per side, headers cut and flagged), `read_body` (offset and length ≤ 128 KiB, raw or decoded, base64), `body_draft_write` (UI-only, chunked, ≤ 16 MiB), and `replay_request.edits.body` (inline ≤ 128 KiB or a draft id).
  - `maxBodyBytes` ranges from 0 to 16 MiB.
  - Tests: 1 MiB binary reassembly, decoded vs raw, the draft cap, and every result under `maxPayloadBytes`.

## 6. Plugin id `a--b` collides: accepted, reproduced

**Evidence**

- `node -e`: `/^[a-z][a-z0-9-]{1,22}$/.test("a--b")` is `true`.
- `plugin_a__b__search` is produced both by (`a--b`, `search`) and by (`a`, `b__search`).

**Plan changes**

- `PluginId` is 2 to 23 chars and matches `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`: no leading, trailing, or doubled hyphens.
- The encoded id therefore has no `__` and no trailing `_`. Operations start with a letter, so the first `__` is always the separator.
- `parsePluginToolName` re-validates both halves.
- The maximum name is 7 + 23 + 2 + 32 = 64 chars.
- Tests:
  - Reject table: `a--b`, `a-`, `-a`, `a`, uppercase, underscore, 24 chars.
  - Accept table, including the 23-char boundary.
  - Round-trip pairs, including the exact 64-char name.
  - A distinctness assertion.
  - Parse-reject table: `mcp_…`, `plugin___x`, `plugin_a__`, `plugin_a___x`, uppercase.
- Catalog `mcp_` names cannot collide (`ProjectMcpBroker.ts:3-4`).

## 7. Eval ordering: accepted, and the same defect existed in Task 12

**Evidence**

- Task 9 evals imported the inspector manifest created in Task 13.
- Task 12's eval (d) required the inspector's `get_request`, also from Task 13.

**Plan changes**

- All plugin eval cases (a) through (e) move to Task 13 Step 5:
  - (a)-(c) as before.
  - (d) the reference snapshot.
  - (e) the refusal message.
- Task 13 extends `run.ts` with a plugin tool source built by `pluginAgentTools` from the real manifest, with refusal text from the exported `PLUGIN_MUTATION_REFUSED_MESSAGE`. Nothing is copied.
- Tasks 9 and 12 have no evals.
- New global constraint: every task's gate passes using only that task's and earlier tasks' files.
- Note: these are new tools, so "fail on old text" cannot apply. Task 13 records pass rates and relies on the control case.

## Other corrections made during self-review

- The OpenCode v1 row said "pending a Task 9 verification test" that did not exist. Source shows it registers `catalogEndpoint` (`adapter.ts:985-992`, `supportsMcpTools: true`), so the row now reads Supported. The OpenCode2 rule (tool discovery and invocation proof, not just registration) is unchanged.
- Line references corrected: `bin.ts:35-37`, gateway layer `:456-458`, empty-generation path `:410-428`.
- Review Focus item 4 cited a nonexistent Task 10 test. It now names `shows Enable for a disabled plugin…`.
- Docs (Task 14) cover the page route, SEA bundling, mitmproxy replay, `PLUGIN_LIMITS`, and assistant selection. `docs/user/assistants.md:57` gets a one-sentence update.

## Remaining material questions

1. **Packaged-binary verification needs a host matching `engines.node` (26.12.1).** This host runs Node 24.22.1. Task 15 Step 5b specifies the smoke, but whether an implementer can run it in their environment is unconfirmed. I did not verify that the SEA can `createRequire` an absolute `.cjs` path outside its directory. The repo's precedent loads packages near the executable, so Step 5b is the proof.
2. **Electron 44's bundled Node and `target: "node22"`.** I assumed Electron 44 ships Node ≥ 22. I did not check it.
3. **Assistant selection is per environment and per plugin operation.** Project-team role `toolIds` (`ProjectTeamPolicy.ts`) are not extended. The gateway only applies assistant policy today, so this matches current behavior, but maintainers may want team roles to select plugin tools later.
4. **The docked frame may reload on thread switch when ChatView remounts.** Plugin state is restored from bridge `state` and the backend, not from iframe DOM. This meets the design's "preserve … plugin state" if bridge state counts as plugin state. Keeping a live iframe across ChatView remounts would need a layout-level frame pool, which I judged unnecessary complexity.
