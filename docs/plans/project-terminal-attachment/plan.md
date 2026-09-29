# Project Terminal Attachment and Completion Notices Implementation Plan

> **For agentic workers:** Implement the tasks in order. The plan is saved outside the repository because this worktree's AGENTS.md forbids committing implementation plans. Use focused tests and do not launch a browser without the maintainer's permission.

**Goal:** Let people discover and attach to agent-created project PTYs in the web dock, and let agents opt into completion notices with an optional wake.

**Architecture:** Extend the existing environment-owned TerminalManager with project-only observation and compact metadata, then expose those operations through tagged WebSocket contracts. Keep the current thread-terminal path intact. A terminal activity worker records creation; a completion worker stores one-shot subscriptions and records optional completion activity. A new internal orchestration intent delivers wake requests by safe steer or queued continuation with explicit delivery states.

**Tech stack:** Effect/Schema contracts and server, Effect RPC/WebSocket, React web dock, Ghostty terminal surface, SQLite orchestration projections, Vitest via `vp test run`.

**Spec:** [design.md](./design.md)

## Global constraints

- Project PTYs remain owned by the environment server and project; creatingThreadId is attribution only.
- Existing thread dock terminals and six MCP PTY tools retain their behavior. Human attachment cannot create or restart a project PTY.
- Web and desktop get the new UI; mobile gets no new UI in this release. All RPC targets retain environment identity in the client.
- Advertise an optional `projectTerminalAttachment` environment capability; a new web client must not call new RPCs on an older server that lacks it.
- Project metadata contains no terminal output or command arguments; only attached dock views receive output. Read-only is the default view mode, preserves the PTY grid, and sends no write or resize.
- Environment authorization for human clients follows existing terminal scopes; MCP agents remain limited to the calling thread's project.
- A subscription is one-shot, keyed by terminal generation and subscribing thread, with at most 32 subscribing threads per terminal. All notices target the terminal's originating thread. Unsubscribe before completion claim prevents optional notice/wake; after claim it cannot retract them.
- `noticeAndWake` steers only providers explicitly marked safe; otherwise it queues. Proven nonacceptance queues; an ambiguous send becomes visible unknown delivery without blind retry. No synthetic user message. Undelivered wakes from a previous server run cancel; server-restart PTY recovery is out of scope.
- Do not run repo-wide checks or browser/computer-use verification without maintainer request. Do not commit this plan, screenshots, or a PR.

## Review focus

- A project and thread with equal-valued IDs and terminal IDs must remain distinct (Tasks 1–2 tests).
- A reconnect during output/resize/exit must receive a consistent snapshot and no duplicate or missing event (Task 1 test).
- ANSI device queries must not cause a read-only dock view to write replies to the PTY (Task 3 test).
- An exit racing subscription registration or unsubscribe must deliver at most once; unsubscribe before completion claim prevents optional notice/wake (Task 5 test).
- A busy thread's provider may reject a steer while completing; proven nonacceptance queues, while ambiguous acceptance becomes unknown rather than a duplicate send (Task 6 test).

---

### Task 1: Observe existing project PTYs and publish metadata

**Files:** Modify `packages/contracts/src/terminalToolkit.ts`, `apps/server/src/terminal/RuntimeTypes.ts`, `apps/server/src/terminal/Manager.ts`; test `packages/contracts/src/terminalToolkit.test.ts`, `apps/server/src/terminal/Manager.test.ts`.

**Interfaces:** Add `ProjectTerminalAttachInput = ProjectTerminalHandle`; `ProjectTerminalAttachSnapshot = { terminal: ProjectTerminalDockSummary; history: string; cols: number; rows: number; sequence: number }`; `ProjectTerminalAttachStreamEvent` as snapshot/output/resized/exited/closed with the project handle and sequence. Add `ProjectTerminalDockSummary = {projectId,terminalId,creatingThreadId,label,status,cols,rows,exitCode,exitSignal,updatedAt}` with label max 128 and no command/args/env. Add `ProjectTerminalMetadataStreamEvent` as bounded snapshot (first 100 in terminal-ID order plus `nextCursor`), upsert, or remove, and `listProjectDockSummaries(projectId, after?, limit<=100)` for further entries in the same stable order. Add internal session generation and creator label to project runtime events for dedupe, without exposing generation as a client-selected identity. Add `TerminalManager.attachProjectStream(input, listener): Effect<() => void, TerminalToolError>` and `TerminalManager.subscribeProjectMetadata(projectId, listener): Effect<() => void>`.

- [ ] Write manager tests: attaching does not spawn, resize, clear, or restart; exited output remains attachable; unknown and thread-owned handles fail; equal-valued owner IDs do not collide; reconnect across concurrent output/resize/exit yields one ordered snapshot plus later events; metadata snapshot/page/deltas stay within bounds, omit command arguments and output, and do not upsert for every output chunk.
- [ ] Run `vp test run apps/server/src/terminal/Manager.test.ts packages/contracts/src/terminalToolkit.test.ts`; expect new tests to fail.
- [ ] Add the contracts and project `created`/`resized`/status events. Implement register-before-snapshot project attachment using existing history and sequence; preserve output listeners until final output and exit are drained. Build paged metadata from summaries, not history, and scope it to project ID. Bound each listener queue: a slow metadata client receives a resync snapshot, while a slow output client reconnects for retained history rather than blocking the PTY producer or silently dropping bytes.
- [ ] Run the same tests; expect pass. Inspect the event path for full-history materialization on each callback and keep it at snapshot boundaries only.

### Task 2: Expose scoped project terminal RPCs

**Files:** Modify `packages/contracts/src/rpc.ts`, `packages/contracts/src/ipc.ts`, `packages/contracts/src/environment.ts`, `apps/server/src/environment/ServerEnvironment.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/ws.ts`, `packages/client-runtime/src/rpc/client.ts`; create `apps/server/src/terminal/ProjectTerminalClientAccess.ts`; test `apps/server/src/server.test.ts`, `apps/server/src/auth/RpcAuthorization.test.ts`, `packages/contracts/src/environment.test.ts`.

**Interfaces:** Add `projectTerminal.attach`, `projectTerminal.metadata`, `projectTerminal.list`, `projectTerminal.write`, and `projectTerminal.resize` RPCs. Inputs use `ProjectTerminalHandle` (metadata/list take `projectId`); attach/metadata stream Task 1 events. Add optional `ExecutionEnvironmentCapabilities.projectTerminalAttachment: boolean`, published true by the server. `ProjectTerminalClientAccess.requireProject(projectId)` checks existence for metadata/list; `requireExisting(handle, operation)` also verifies that the terminal belongs to that project and returns unavailable on mismatch. Apply existing `AuthTerminalOperateScope` to all five RPCs; view-only is a client mode, not an authorization role. Do not change MCP authorization.

- [ ] Write RPC tests for local and remote-style authenticated connections: project attach/metadata/paged list work, credentials without terminal scope fail for all five methods, mismatched project/terminal and human dock handles fail, new capability is advertised, and existing `terminal.attach` still behaves as before.
- [ ] Run `vp test run apps/server/src/server.test.ts apps/server/src/auth/RpcAuthorization.test.ts`; expect the new RPC tests to fail.
- [ ] Register schemas, auth map entries, handlers, and `EnvironmentApi.terminal.project*` methods. Route every operation to the current environment's singleton manager; no request-owned PTY manager. Treat client-supplied project ID as a lookup target, not proof of ownership.
- [ ] Run those tests and targeted contracts/client-runtime typechecks; expect pass.

### Task 3: Integrate project views into the web dock

**Files:** Modify `packages/client-runtime/src/state/terminal.ts`, `packages/client-runtime/src/state/terminalSession.ts`, `apps/web/src/state/terminalSessions.ts`, `apps/web/src/terminalUiStateStore.ts`, `apps/web/src/components/ThreadTerminalDrawer.tsx`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/terminal/ghostty/surface.ts`; create `apps/web/src/components/ProjectTerminalDockView.tsx`; test matching `*.test.ts(x)` and `apps/web/src/terminal/ghostty/surface.test.ts`.

**Interfaces:** Introduce `DockTerminalTarget = { environmentId; owner: {kind:'thread';threadId} | {kind:'project';projectId}; terminalId }`. Store project-tab selection and mode once per `(environmentId,projectId)` above `PersistentThreadTerminalDrawer`; only the active project view may hold an output stream. Project view has mode `'view' | 'interactive'`, default `'view'`. Project attachment uses Task 2 RPC and a dedicated buffer reducer. Add a fixed-grid mode to `GhosttyTerminalSurface`: local `fit()` may resize its canvas but may not call `core.resize`; `setRemoteGrid(cols, rows)` applies snapshot/remote resize events. Thread view retains current reducer and open/attach behavior. A project tab close is detach only.

- [ ] Write state/component tests: distinct owner targets do not collide, project selection opens existing output, closing the tab does not call kill, exited sessions remain openable, mode defaults to view, and an older server without `projectTerminalAttachment` gets no new subscription or dock controls. Switch between two threads in one project and two environments with equal-valued IDs; assert there is one visible project attachment and hidden views unsubscribe.
- [ ] Run focused client-runtime and web tests for these files; expect new tests to fail.
- [ ] Implement project tabs and views in the existing dock. Gate every input path at the transport adapter (`onData`, paste, navigation shortcuts, pointer reports, Ghostty device replies) and gate `onResize` for view mode; only focused interactive views send resize. Preserve selection/copy and dock shortcuts. If two interactive views resize, latest resize wins. Keep project-tab state when switching threads in the same project; switching environments detaches from the old one.
- [ ] Add tests that feed ANSI device queries and viewport changes into a view-only surface and assert unchanged `core` grid plus zero write/resize RPCs; a remote resize must update that grid. Assert interactive input/resize works, closing via shortcut detaches without kill, and hidden tabs do not stream output. Run focused tests; expect pass.

### Task 4: Make project terminals discoverable and record lifecycle activity

**Files:** Create `apps/server/src/terminal/ProjectTerminalActivityReactor.ts` and test; modify `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/server.ts`, `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/MessagesTimeline.tsx`; test affected orchestration and web activity files; update `docs/user/terminal.md`.

**Interfaces:** The reactor consumes Task 1 `created` events through a drainable worker. It dispatches `thread.activity.append` with kind `terminal.project.created`, a bounded payload `{projectId, terminalId, label, status}`, and stable `commandId` and activity ID derived from project/terminal/generation/`created`. Capture creatingThreadId and label in the queued runtime event before a later cleanup can remove them; the decider assigns the orchestration event ID. The dock's project list consumes Task 2 metadata and pages older entries; activity's action selects the tagged target and opens the dock. Completion activity is written only by Task 5 when subscribed.

- [ ] Write reactor tests for creation with no output in the payload, deleted creator thread, project cleanup, duplicate events, and worker drain. Write web tests for activity's **Open in dock** action, paged list updates without output subscriptions, and unavailable links after restart.
- [ ] Run focused reactor and web tests; expect new tests to fail.
- [ ] Implement the worker and web affordances. Do not do orchestration persistence inside a PTY event callback; enqueue and return. A deleted thread skips its activity safely; a project terminal remains discoverable from another thread in that project. Keep activity rows compact and never render output outside the dock. Include this worker in orchestration drain before completion work.
- [ ] Run focused tests; expect pass. Update the agent-terminal user guide with where to find and open project terminals.

### Task 5: Add one-shot completion subscriptions

**Files:** Create `apps/server/src/terminal/ProjectTerminalCompletionService.ts` and test; modify `packages/contracts/src/terminalToolkit.ts`, `apps/server/src/terminal/ProjectTerminalService.ts`, `apps/server/src/mcp/toolkits/terminal/tools.ts`, `apps/server/src/mcp/toolkits/terminal/handlers.ts`, `apps/server/src/mcp/McpTerminalToolkit.test.ts`, `apps/server/src/mcp/McpHttpServer.test.ts`, `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/server.ts`.

**Interfaces:** Add MCP `terminal_subscribe_completion({projectId,terminalId,mode:'notice'|'noticeAndWake'})` and `terminal_unsubscribe_completion({projectId,terminalId})`. The service upserts one subscription per `(projectId,terminalId,generation,subscribingThreadId)`, max 32 threads, and subscribes before checking observed terminal status. A completion worker writes one `terminal.project.completed` activity using stable command/activity IDs and bounded `{projectId,terminalId,label,status,exitCode,exitSignal}`. If any mode is `noticeAndWake` when completion is claimed, it sends one wake request to Task 6. Subscription state is environment-server lifetime only.

- [ ] Write service/MCP tests for same-project access, foreign project and dock-terminal rejection, independent subscribing threads, mode update, 32-thread cap, unsubscribe, exit before/after registration, killed/errored exit, repeated exit, and cancellation/cleanup races. Assert one optional completion row and at most one wake request; without a subscription only dock status changes. Pin the linearization point at worker claim: unsubscribe before claim prevents notice/wake, after claim cannot retract committed notice; removing the last wake subscriber before claim prevents wake. Test notice→wake update and subscribe-again after a delivered generation tombstone.
- [ ] Run `vp test run apps/server/src/terminal/ProjectTerminalCompletionService.test.ts apps/server/src/mcp/McpTerminalToolkit.test.ts`; expect new tests to fail.
- [ ] Implement the service with bounded maps keyed by explicit project ownership and generation plus delivered-generation tombstones. Its PTY listener only queues work; a drainable worker performs activity/wake dispatch. Reuse MCP capability checks and calling-thread project lookup from `ProjectTerminalService`; never return command environment values. A late subscription after exit delivers immediately only if that generation has not already been consumed.
- [ ] Run the focused tests and MCP transport test; expect pass. Keep subscription cleanup on project deletion and server shutdown explicit. Add the completion worker to orchestration drain after the creation-activity worker; Task 6 provider delivery drains after completion.

### Task 6: Deliver wake intents without synthetic user messages

**Files:** Modify `packages/contracts/src/orchestration.ts`, `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`, `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `apps/server/src/orchestration/Layers/CheckpointReactor.ts`, `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/provider/Services/ProviderAdapter.ts`, `apps/server/src/provider/Services/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Layers/{Codex,Claude,Cursor,Grok,OpenCode,Antigravity}Adapter.ts`, `apps/server/src/persistence/Migrations.ts`; create `apps/server/src/persistence/Migrations/fork/018_TerminalCompletionWakes.ts`; test changed layers/adapters plus `apps/server/src/persistence/Migrations.forkSequence.test.ts`.

**Interfaces:** Add an internal-only `thread.terminal-completion.request` command and persisted `thread.terminal-completion-requested` event containing `threadId`, terminal handle/generation, status, exit code/signal, current server-run ID, and a dedupe key. It never enters `ClientOrchestrationCommand`. Add projection rows for wake delivery state (`pending`, `claimed`, `delivered`, `canceled`, `unknown`) and a terminal-origin pending turn identity distinct from a user-message ID. Add `ProviderAdapterCapabilities.activeTurnSteer?: boolean` with conservative default false. The provider reactor sends a bounded terminal outcome prompt through `ProviderService` using a new internal continuation path that does not require a user message. `promptlessTurnContinuation` remains separate: terminal completions always carry an explicit prompt. The prompt links the handle and directs the agent to `terminal_read` for output.

- [ ] Write decider/projection tests for internal-only command, durable dedupe, no user message, archived/deleted origin, multiple completions coalesced into one pending wake, and serialization against a simultaneous user turn. Run focused tests; expect failure.
- [ ] Implement event, migration registration, pending-wake projection/query, and explicit request→claim→ack/cancel transitions. Generate one random server-run ID when the environment server starts and inject it into the completion worker/provider reactor; compare it with stored intent IDs on recovery. Recheck origin and provider eligibility after claim, immediately before dispatch. Deleted/archived origins cancel; unavailable sessions leave the visible notice and cancel pending wake; a recovered pending intent from a prior server-run ID cancels. A claimed but unacknowledged send becomes `unknown` with visible activity and is never blindly resent. Any provider rejection that proves no input was accepted returns to `pending`, including a rejected steer after the request was dispatched; uncertain acceptance becomes `unknown`. Persist only a bounded prompt and terminal outcome, not scrollback.
- [ ] Write provider-reactor tests: idle origin starts a continuation; supported busy provider gets a steer promptly; unsupported busy provider queues until turn settles; proven rejected steer racing turn completion queues; ambiguous transport failure becomes `unknown`; interruption immediately before dispatch versus after provider acceptance does not duplicate; racing user turn and multiple exits preserve ordering; archive/delete after claim but before dispatch cancels; an old pending intent recovered in a new server run cancels; delivery failure is visible. Run focused tests; expect failure.
- [ ] Add the internal `ProviderService` delivery method and explicit adapter capability assertions. Mark only adapters whose active-turn send behavior is proven by focused tests; leave all others false. Extend pending-turn projection/query and runtime ingestion so terminal-origin `turn.started`, assistant output, completion, and checkpoint association work without a persisted user message, including provider steers that reuse or replace a turn ID. Keep user turn provenance intact. Do not call the provider from a terminal callback. Run focused provider, ingestion, projection, and checkpoint tests; expect pass.

### Task 7: Integrated contracts, compatibility, and docs pass

**Files:** Modify `docs/user/terminal.md` and `docs/internals/terminal-runtime.md` only where the new behavior changes guidance; add a focused server/client integration test if Tasks 1–6 do not already cover end-to-end transport.

**Interfaces:** No new production API. Verify earlier tasks as one chain.

- [ ] Run focused tests for the changed contract, manager, WS authorization, MCP, orchestration, provider, client-runtime, and web files. Wait on receipts and worker drains in lifecycle→completion→provider order, not sleeps. Resolve only failures tied to this change.
- [ ] Run `vp run --filter @t3tools/contracts typecheck`, `vp run --filter @t3tools/client-runtime typecheck`, `vp run --filter t3 typecheck`, and `vp run --filter @t3tools/web typecheck`. Run targeted `vp lint` and `vp fmt --check` on changed TypeScript files; do not run root recursive checks.
- [ ] Review local/remote environment routing, old-client RPC compatibility, event payload size, owner-key collision, listener cleanup, provider capability claims, and project/thread deletion. Update docs to state read-only default, optional wake, shared input, and server-restart boundary.
- [ ] Report exact test results and per-provider steer support. Do not claim browser verification; the repository requires maintainer permission before browser/computer use.
