# Project terminal toolkit implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for inline execution, or `superpowers:subagent-driven-development` if the maintainer selects delegation. Read the spec and this plan together. Do not begin product changes before plan review.

**Goal:** Give agents an opencode-pty-style spawn/write/read/list/kill workflow with project-owned PTYs, using T3's existing terminal runtime and adding resize.

**Architecture:** Make terminal ownership explicit inside the existing manager while preserving the thread-terminal WebSocket interface. A project-terminal service enforces project access and coordinates creation/deletion; six MCP tools call that service. Cursor reads use the existing retained chunks without introducing another output buffer.

**Tech stack:** TypeScript, Effect, Effect Schema/MCP, existing node-pty adapter, vite-plus tests.

**Spec:** [spec.md](spec.md)

## Global constraints

- Project-owned toolkit terminals survive archiving or deleting any thread. Project deletion and server shutdown terminate them.
- Agent access is limited to toolkit-created terminals in the authenticated caller's project.
- No second manager instance, PTY backend, output buffer, new dependency, or invented thread ID.
- Dock terminal contracts and behavior stay compatible across web, desktop, and mobile.
- Retention: 5,000 lines and 8 MiB. Reads: default 16 KiB, maximum 64 KiB. Wait: default zero, maximum 30 seconds. Lists: default 50, maximum 100.
- `terminal_spawn` accepts an optional executable and argument array, or uses the existing interactive shell. `terminal_kill` retains logs by default; `cleanup: true` removes the session after termination.
- Tail reads: 1–500 lines within the byte cap. Search: literal text, maximum 256 characters, optional case-insensitivity, maximum 256 KiB scanned per call. No regex, unsolicited exit notifications, or automatic lifetime timeout in this version.
- Project workspace is the default cwd. An agent can explicitly choose a worktree; keeping a process alive does not preserve deleted files.
- Keep this spec and plan in the worktree plan directory as requested by the maintainer. No commits, PRs, browsers, live-state writes, or repo-wide checks are authorized by this plan.
- Test async behavior with receipts, worker drains, and controlled events; do not introduce sleeps or polling.

## Review focus

- A project and a thread have the same ID string: keys, history paths, and cleanup must stay distinct. Task 1 tests this.
- The last thread is deleted, then a new thread is created in that project: the new agent must use the existing PTY. Tasks 1 and 3 test this.
- Project deletion races an in-progress PTY spawn: after the cleanup receipt there must be no process or history left behind. Task 3 controls spawn with a Deferred.
- Output evicts a cursor position or splits an emoji across PTY callbacks: readers must see an explicit gap and valid Unicode. Task 2 tests both.
- Browser access is disabled and there are no configured external MCP servers: terminal tools must still be delivered without granting preview capability. Task 5 covers the shared setup and all six adapters.

## File responsibilities

- `packages/contracts/src/terminalToolkit.ts`: project terminal handles, six tool inputs/results, bounded schemas, public errors; export from `packages/contracts/src/index.ts`.
- `apps/server/src/terminal/RuntimeTypes.ts`: internal explicit owner and session target types. Existing client-facing thread types remain unchanged.
- `apps/server/src/terminal/History.ts`: existing chunked history implementation with cursor slice support, extracted from Manager only to keep that algorithm independently testable.
- `apps/server/src/terminal/Manager.ts`: one runtime for both owner kinds, shared spawn/output/cleanup, project operations, legacy thread adapters.
- `apps/server/src/terminal/ProjectTerminalService.ts`: project access, launch-context resolution, project creation/deletion coordination, event-based read waits.
- `apps/server/src/terminal/OutputSearch.ts`: bounded literal search and query-bound continuation over retained chunks; no second retained history buffer.
- `apps/server/src/orchestration/ProjectTerminalReactor.ts`: drainable cleanup on committed `project.deleted` events.
- `apps/server/src/mcp/toolkits/terminal/{tools,handlers}.ts`: tool schemas, descriptions, annotations, and thin handlers.
- Existing server composition, MCP credential setup, provider delivery, and docs receive only changes needed to expose this feature.

## Task 1: Add project ownership to the existing terminal runtime

**Files:** create RuntimeTypes.ts and terminalToolkit.ts; modify Manager.ts, contracts/index.ts, and Manager.test.ts; add terminalToolkit.test.ts.

**Interfaces:**

- `TerminalOwner = { kind: "thread"; threadId: string } | { kind: "project"; projectId: ProjectId }`.
- `TerminalTarget = { owner: TerminalOwner; terminalId: string }` is the internal identity. Existing thread wire inputs adapt to it.
- Public `ProjectTerminalHandle = { projectId: ProjectId; terminalId: string }` and `ProjectTerminalSummary` add title, launched program, cwd, creating-thread attribution, label, status, and observed exit information without environment values or history. Project summaries distinguish `stopping`, `killed`, and natural `exited` states without widening the old dock wire status schema.
- Manager adds `createProject(input)`, `listProject(projectId)`, `writeProject(input)`, `resizeProject(input)`, `killProjectTerminal({ ...handle, cleanup })`, and `closeProject(projectId)`. Creation takes a generated terminal ID, creating-thread attribution, optional title/command/args, and existing validated launch fields. Project-targeted failures use `TerminalToolError`, not errors with fabricated thread IDs.
- Preserve all existing manager thread methods and wire results. Project and thread operations converge on common runtime lifecycle functions.

- [ ] Write failing manager tests: create one project terminal and one thread terminal with equal-valued owner IDs and equal terminal IDs; closing the thread leaves the project process, output, and history untouched; closing the project leaves an unrelated project alive. Assert the fake adapter spawned exactly one process per terminal and both owner kinds use that same adapter instance.
- [ ] Add contract tests for project handles and exact existing write/dimension limits; reject missing owner IDs and oversized values. Title is at most 128 characters. Command is nonempty when supplied, at most 8,192 characters; args has at most 128 entries, each at most 8,192 characters, and total command/argument UTF-8 text at most 64 KiB. Reject args without command. Reject NUL bytes in command/args/env launch inputs before spawning.
- [ ] Run `vp test run apps/server/src/terminal/Manager.test.ts packages/contracts/src/terminalToolkit.test.ts` and confirm the new behavior fails before implementing it.
- [ ] Refactor manager state keys, locks, persistence requests, process-event routing, shutdown finalizers, and history filenames around TerminalTarget. Preserve legacy thread log paths; place project logs in a distinct namespace. Creating-thread attribution must not participate in project lookup or cleanup.
- [ ] Keep existing thread event/metadata subscriptions thread-only. Project output remains observable internally for Task 2. Do not pass project IDs or creator IDs to thread-only port registrations; retain ordinary environment port scanning and defer project port attribution.
- [ ] Add failing tests for direct program launch: arguments with spaces and shell metacharacters arrive intact at PtyAdapter; unknown executable fails without shell fallback; omitted command uses the existing shell selection. Assert titles appear in metadata and raw environment values do not.
- [ ] Implement the project methods using the common runtime. Creation is new-only; reading/listing never calls open. Pass an explicit program and its argv through the existing adapter directly, preserving shell fallback only for default-shell creation. Do not change ordinary dock launch behavior.
- [ ] Add failing lifecycle tests: kill with omitted cleanup retains final logs and observed exit status; cleanup removes the session; repeated kill reuses pending termination; kill failure is surfaced; a delayed exit remains `stopping`; final output arriving after the termination request is retained. Agent B can read logs after agent A kills the process.
- [ ] Implement termination with the existing platform-specific kill/escalation primitives, but preserve listeners until final output and exit are drained. The current `stopProcess` detaches listeners early, so calling it unchanged cannot satisfy this behavior. Pending stopping sessions must not be evicted; completed sessions follow inactive retention. Project deletion uses termination plus cleanup. Never target arbitrary PIDs.
- [ ] Rerun the focused tests. Also test server-scope finalization terminates both owner kinds and releases listeners/process registrations.

## Task 2: Add bounded independent reads

**Files:** create History.ts, History.test.ts, OutputSearch.ts, and OutputSearch.test.ts; modify Manager.ts, Manager.test.ts, terminalToolkit.ts, and terminalToolkit.test.ts.

**Interfaces:**

- `TerminalReadInput`: project handle, optional opaque cursor, `maxBytes` (1–65,536), `waitMs` (0–30,000), optional `tailLines` (1–500), and optional `search: { text: string; ignoreCase?: boolean }`. Tail is initial-only and excludes cursor/search/wait. Search excludes wait. Defaults are applied server-side.
- `TerminalReadResult`: stream/tail results contain summary/status, `output`, `nextCursor`, `hasMore`, and `truncated`; search results contain summary/status, bounded `matches` with source positions/excerpts, `nextCursor`, `hasMore`, and `truncated`. Search cursors carry query/case identity and cannot be used as stream cursors.
- `BoundedTerminalHistory.read(position, maxBytes)` returns a bounded text slice, absolute next position, more-output flag, and eviction flag. Positions are opaque to callers; cursor encoding carries terminal identity and generation.
- Manager adds `readProject(input)` for an immediate read and a scoped internal project-session event subscription. Task 3 supplies optional waiting without holding the project lifecycle lock while idle.

- [ ] Write failing tests for two readers independently reading the same output; a repeated cursor; omitted cursor starting at oldest retained output; defaults of 16,384 bytes and rejection above 65,536; eviction resumption with `truncated: true`; malformed, foreign, future, and old-generation cursors.
- [ ] Test a long unterminated line, line-limit eviction, multibyte characters at budget boundaries, and surrogate pairs split across callbacks. A budget too small for the next complete code point must return an explicit invalid-budget error rather than an empty page that can never advance.
- [ ] Add failing tail/search tests: tail obeys both limits and follows new output with its returned cursor; literal metacharacters have no regex meaning; case-insensitive search returns source positions; scan stops at 262,144 source bytes even without matches; continuing finds later matches; query/case mismatches fail; boundary-spanning matches are neither lost nor repeated. Returned matching excerpts collectively obey maxBytes.
- [ ] Run `vp test run apps/server/src/terminal/History.test.ts apps/server/src/terminal/Manager.test.ts packages/contracts/src/terminalToolkit.test.ts` and verify the new tests fail for the missing behavior.
- [ ] Extract the existing history implementation without altering append/retention behavior. Track absolute positions and generation changes; walk chunks for reads and never materialize the entire history to serve a small slice. Preserve the existing history tests when moving imports.
- [ ] Implement bounded tail selection and OutputSearch over the retained chunk API. Bind search continuation to query/case/terminal/generation, retain enough boundary context to find split matches, and advance the source cursor through no-match windows. Do not keep another full log or run an unbounded regex on the server event loop.
- [ ] Add immediate project reads and scoped event subscription. Return exited-state output without spawning, resizing, or resetting history. Separate process-event sequence from output cursor position.
- [ ] Run the tests, including OutputSearch.test.ts, and a focused full-scrollback throughput comparison with the unchanged append workload. Confirm repeated small reads/searches allocate bounded working slices and results, not an 8 MiB snapshot.

## Task 3: Enforce access and project lifetime

**Files:** create ProjectTerminalService.ts and its test; create orchestration/ProjectTerminalReactor.ts and its test; modify orchestration/Services/RuntimeReceiptBus.ts, orchestration/Layers/OrchestrationReactor.ts, server.ts, and affected composition tests. Extend existing ThreadDeletionReactor tests to cover project-session preservation.

**Interfaces:**

- `ProjectTerminalService`: `spawn`, `list`, `read`, `write`, `resize`, `kill` for toolkit calls, plus internal `closeProject(projectId)` for the reactor. Toolkit methods require McpInvocationContext; internal project cleanup does not. Kill defaults cleanup to false and delegates to the manager's retained-log termination path.
- All toolkit methods require the terminal capability and resolve the calling thread's live project through ProjectionSnapshotQuery. Foreign, dock-owned, and unknown handles produce the same unavailable-target error.
- `ProjectTerminalReactor`: `start()` and `drainThrough(sequence)`, matching existing drainable-worker conventions. Publish `project.terminals.closed` with `projectId` and event `sequence` after successful cleanup.

- [ ] Write failing service tests for same-project cross-thread access; foreign-project and dock-terminal denial for every operation; missing capability; creation attributed to a thread that is later deleted; a new thread accessing the same PID after all earlier threads are gone.
- [ ] Write failing lifecycle tests for archive/delete preserving the project terminal, project deletion without remaining threads closing it, repeated cleanup, and another project remaining unaffected. Hold a fake spawn behind a Deferred, commit deletion, release spawn, then await cleanup receipt/drain and assert no process/history survives.
- [ ] Test a waiting read with event-controlled output and shell exit; use TestClock for the 30-second maximum. Cancel the read and assert its listener is removed while its PTY remains writable.
- [ ] Run the service/reactor tests, plus `vp test run apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts`, and establish the new failures.
- [ ] Implement project-scoped serialization shared by service creation and reactor cleanup. Validate that the project is still active inside that critical section. The current OrchestrationEngine commits projection changes in its SQL transaction before publishing domain events; preserve and test that dependency so a create after cleanup sees the deleted project. Do not hold the lifecycle lock during an idle read wait.
- [ ] Resolve default cwd from the project workspace, use the authenticated provider's existing terminal environment preparation, and allow explicit title/command/args/cwd/env/dimensions. Generate IDs server-side and ensure committed creation remains discoverable after request cancellation. Natural program exit reports the real process status, without inferring command completion from shell output.
- [ ] Implement register-before-check waits with guaranteed unsubscription on success, timeout, failure, and cancellation. Add bounded list pagination scoped to the project, ordered by a stable terminal ID key.
- [ ] Wire the required project reactor and shared service into production composition and the orchestration drain. Preserve existing thread cleanup behavior. Rerun the focused tests through receipt/drain completion.

## Task 4: Expose the six MCP tools

**Files:** create mcp/toolkits/terminal/tools.ts, handlers.ts, and focused tests; modify McpInvocationContext.ts and McpHttpServer.ts; add mcp/McpTerminalToolkit.test.ts.

**Interfaces:** tool names are `terminal_spawn`, `terminal_list`, `terminal_read`, `terminal_write`, `terminal_resize`, and `terminal_kill`; handlers call Task 3's service. Use contracts from Tasks 1–2 and the existing missing-capability error.

- [ ] Write failing tool/transport tests: all six object-shaped schemas register; calls execute with invocation context; a missing capability returns a tool error; unknown handles do not spawn; list/read/search results respect bounds; writes preserve explicit newlines/control characters; agent kill defaults to retaining readable logs; cleanup removes a finished session.
- [ ] Run `vp test run apps/server/src/mcp/McpTerminalToolkit.test.ts apps/server/src/mcp/toolkits/terminal` and verify missing-tool failures.
- [ ] Implement definitions and thin handlers, register them in the shared MCP transport, and provide the same service/manager instances used by the environment runtime.
- [ ] Describe shared control, explicit newline handling, retained ANSI output, literal search, tail reads, loss detection, and process survival in tool descriptions. Creation and writes are not idempotent; reading is non-destructive; kill is destructive. Explain Ctrl-C versus whole-session kill, and stopping versus confirmed exit. A write acknowledgement does not claim command completion. Do not promise unsolicited exit notifications in this version.
- [ ] Rerun tool/transport tests and the existing McpHttpServer tests to confirm other toolkits remain registered.

## Task 5: Deliver terminal tools independently of browser access

**Files:** modify mcp/McpSessionRegistry.ts and its tests; provider/Layers/ProviderService.ts and its tests; inspect and modify only the necessary MCP gating in CodexAdapter.ts, ClaudeAdapter.ts, CursorAdapter.ts, GrokAdapter.ts, OpenCodeAdapter.ts, and AntigravityAdapter.ts with their existing focused tests.

**Interfaces:** `McpCapability` includes `terminal`; managed credentials grant it independently of preview/device/project-work access. Existing unsupported or unmanaged MCP delivery paths retain their limitations.

- [ ] Add failing tests for a terminal-capable session with preview disabled and no external servers: the built-in endpoint remains configured; preview capability remains absent; terminal calls work. Add a renewal/revocation test proving replacement credentials can reach the same existing project terminal.
- [ ] For each of the six adapters, identify its existing managed MCP configuration assertion and add the preview-disabled/terminal-enabled case. Do not change a provider's browser permission policy to make terminal delivery work.
- [ ] Run only the changed credential/provider test cases and confirm the missing-capability or dropped-endpoint failures.
- [ ] Grant terminal capability in the shared managed credential path and remove browser-only conditions that incorrectly discard the shared endpoint. Preserve capability checks on every individual toolkit and current external-provider restrictions.
- [ ] Rerun the focused credential/provider cases. Record any adapter limitation explicitly; do not report a native provider run as verified when only its configuration test ran.

## Task 6: Integrated proof and user guidance

**Files:** add a focused real-PTY smoke test under apps/server/src/terminal if needed; update docs/user/terminal.md and the ownership/cursor constraints in docs/internals/terminal-runtime.md. No new feature catalog or planning files in the repo.

- [ ] Run a temporary-directory PTY smoke test: spawn a shell via the project service, write a marker and persistent shell variable, end the caller scope, then read/use that variable through another caller in the same project. Kill it, observe process exit, verify retained logs, then clean up. Also launch a short executable directly and verify its real exit code. Use output/exit callbacks as receipts and clean up only the processes spawned by this test.
- [ ] Document project ownership, survival after thread archive/delete, program/shell spawning, kill with retained logs, explicit cleanup, project deletion cleanup, worktree cwd selection, concurrent-agent input, bounded stream/tail/search reads, and the lack of server-restart survival. State that human-created dock terminals are not exposed to agents yet. Explain that literal search and bounded waits do not imply regex support or pushed completion messages.
- [ ] Run the focused tests introduced or changed by the plan. Run `vp run --filter @t3tools/contracts typecheck` and `vp run --filter t3 typecheck`. Run `vp lint` with the changed TypeScript file list and `vp fmt --check` with the changed file list. Do not run root recursive checks.
- [ ] Review the final diff for owner-key collisions, project/creator confusion, duplicate manager layers, large history materialization, orphan processes, and accidentally granted preview access. No browser verification is necessary for the server-only scope.
- [ ] Report what changed, focused validation results, each provider's delivery status, and the explicit survival boundary. Do not commit or create a PR.

## Plan review

Recommended execution: inline in this session, because the ownership, output, and lifecycle changes share manager interfaces and should be integrated sequentially. Delegation is an alternative only if the maintainer selects it. The writing-plans workflow requires review of this plan and an execution-method choice before product changes.
