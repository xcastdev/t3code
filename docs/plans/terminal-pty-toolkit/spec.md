# Shared terminal PTY toolkit

Status: implemented in this worktree; awaiting maintainer review.

## Intended outcome

Agents can create an interactive terminal, leave it running, and let another agent in the same T3 project discover, read, and control that same process. The environment server owns it. Agent exits, MCP credential renewal, cancelled tool calls, and disconnected clients do not end the terminal.

The terminal uses T3's existing PTY manager and output history so a later client feature can attach it to the terminal dock. There must be no second PTY implementation, external tmux dependency, or process owned by an MCP request.

Confirmed by the maintainer:

- Survival covers agent exits and client disconnects while the T3 server remains running.
- Sharing covers agents in the same project, across threads and providers.
- Toolkit terminals belong to the project and survive archiving or deleting any thread, including the thread that created them.
- Agents can explicitly terminate toolkit terminals through a tool call.
- Agents can access toolkit-created terminals only. Human-created dock terminals remain outside this toolkit.
- Dock sharing and new human-facing terminal controls are future work.

## Reference and intended improvements

The maintainer supplied [opencode-pty](https://github.com/shekohex/opencode-pty) as the interaction reference. Its tools support launching a named program, sending input, reading/filtering output, listing sessions, and killing with optional buffer cleanup. Its [kill implementation](https://github.com/shekohex/opencode-pty/blob/9be51267ed31c81cc953b84da5b615496ab4c95a/src/plugin/pty/tools/kill.ts) retains output unless cleanup is requested.

Adopt that interaction model while retaining the `terminal_` prefix for this T3 toolkit: spawn, write, read, list, kill, and resize. Improvements for T3 are project ownership across agents/providers, independent reader cursors with explicit output-loss reporting, and reuse of the runtime that can later serve the regular terminal dock. Do not install the plugin or introduce its separate PTY backend or observer web server.

First-version reading includes recent-output selection and bounded literal-text search, with optional case-insensitivity. Regex filtering, automatic time limits, and unsolicited completion messages to agents are deferred. A read can already wait for output or exit; that event-based wait is not a promise of provider-independent push notifications. Keep this distinction explicit when comparing the tools.

## Approach

Extend the existing `apps/server/src/terminal/Manager.ts` to support project-owned toolkit terminals alongside its existing thread-owned dock terminals. Add bounded cursor reads and a way to enumerate existing sessions without opening them. Add a thin toolkit under `apps/server/src/mcp/toolkits/terminal/`, using the existing authenticated MCP transport.

This reuses the server's existing shell selection, provider environment preparation, PTY adapter, output retention, subscriptions, process inspection, and shutdown cleanup.

Two alternatives were considered:

- A separate agent PTY service would duplicate lifetime, buffering, process cleanup, and eventually dock integration. It conflicts with the intended shared runtime.
- Keeping toolkit terminals owned by their creating thread would make another agent's terminal disappear when that thread is archived or deleted. The maintainer rejected that lifecycle. Change ownership for toolkit terminals while preserving existing dock terminal behavior.

## Identity, access, and ownership

Represent ownership explicitly in the shared manager: a terminal belongs either to a thread or to a project. Existing dock terminals retain their `(threadId, terminalId)` client contract. Toolkit terminals use `(projectId, terminalId)` and do not need a thread to remain present. Session keys, history paths, locks, and cleanup distinguish the two owner kinds, even if their IDs happen to have the same string value. Do not invent a synthetic thread for a project terminal.

The toolkit generates a unique terminal ID and returns its project-owned handle. Creating-thread and creating-agent IDs are attribution only; deleting those resources cannot invalidate the terminal. Ownership and toolkit provenance are assigned by the server and cannot be supplied through ordinary terminal-open WebSocket inputs. The toolkit never adopts an existing dock terminal or treats an ID prefix as proof of toolkit provenance.

For every request:

1. Require a `terminal` MCP capability.
2. Resolve the authenticated calling thread through `ProjectionSnapshotQuery` to obtain its current project. Caller-supplied project IDs are not an authorization source.
3. For an existing terminal, require toolkit provenance and a matching project. Unknown, foreign-project, and human-created handles return the same unavailable-target error.

Listing is scoped to the caller's project and excludes all human-created terminals. Reading, writing, resizing, and closing apply the same checks. A provider session ID is credential provenance, not terminal ownership. Revoking that credential removes the caller's access but leaves the PTY intact.

Calls from different agents are ordinary shared-terminal input. There is no exclusive writer lease in this version. The manager serializes individual writes; two agents can still send conflicting shell commands. Tool descriptions must make shared control clear.

## Lifecycle

Creation launches either a program specified as `command` plus `args`, or the existing default interactive shell when command is omitted. Direct program launches use the same PtyAdapter; do not concatenate arguments into a shell command. Shell syntax requires an explicitly selected shell and its arguments. Do not fall back to another shell when an explicit program fails to launch. A bounded optional title helps agents identify shared sessions.

Default cwd is the project's workspace directory; agents working in a particular worktree can explicitly supply that path. An explicit working directory and environment overrides use the existing terminal validation. Environment values are never returned in tool results. Project ownership does not preserve externally deleted files or worktrees, and the toolkit must not imply that it does.

Agent exit, MCP request cancellation, credential expiry, and client disconnect leave the terminal running. Once creation commits, cancellation must not leave an undiscoverable running PTY.

A shell exit retains the exit status and bounded output under the manager's existing inactive-session retention policy. Reading or listing cannot spawn, restart, resize, or clear a terminal. An exited terminal stays exited. Start another terminal to get a new shell.

Any authorized agent in the same project can call `terminal_kill`. By default it requests termination but retains the session's metadata, final output, and observed exit information so another agent can inspect what happened. `cleanup: true` additionally removes the session and its retained history after termination. It can also clean up a session that has already exited. Retained stopped sessions remain subject to the existing bounded inactive-session policy. There is no automatic idle timeout for running toolkit terminals.

Distinguish a termination request from observed process exit. Report a stopping state while termination is pending; only report completion once the process exit is observed. Preserve output listeners until final output and exit are drained. Surface kill failures rather than reporting success unconditionally. Reuse the existing platform-specific process termination/escalation path, targeting only the PTY process owned by this session. A repeated kill while stopping must not start competing escalation tasks; cleanup is final and a removed handle is unavailable.

Archiving or deleting a thread closes only its thread-owned dock terminals. It does not terminate, clear, or remove project-owned terminals or their history. This applies to the creating thread, other threads using the terminal, and the last remaining thread in a project. A new thread in that project can discover the same running terminal.

Deleting the owning project closes its toolkit terminals and removes their retained history. Consume the committed `project.deleted` event through a drainable reactor, including when the project has no remaining threads. Coordinate creation with deletion so a concurrent create cannot leave a live terminal for a deleted project. Cleanup is idempotent and server shutdown still finalizes every process.

Server shutdown ends the processes. Server restart does not promise process recovery, restored toolkit handles, or restoration of toolkit access from history files alone. Running sessions are never evicted just to enforce the inactive-session limit.

## Tool surface

Use shared schemas in `packages/contracts` for public inputs, results, handles, cursors, and errors. Each tool has an object-shaped input schema and appropriate MCP read-only/destructive annotations.

| Tool              | Behavior                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal_spawn`  | Start a named program using command/args, or an interactive shell if command is omitted. Accept optional title, cwd, environment overrides, and dimensions. Return its stable handle, cwd, status, and display label. Do not return full history or silently reuse a terminal.                                                                                                  |
| `terminal_list`   | List toolkit terminals in the caller's project, including project-owned handle, title, launched program, creating-thread attribution, cwd, status, and exit information. A deleted creating thread does not prevent listing. Include finished or killed sessions until cleanup or inactive-session eviction. Return metadata only, default 50 and maximum 100 results per page. |
| `terminal_read`   | Read retained output from a cursor, request recent output, or search for literal text. Accept a byte budget and optional bounded wait for stream reads. Return a continuation cursor, whether more output remains to scan/read, and whether earlier output was lost. Search returns bounded matching excerpts and does not advance another reader.                              |
| `terminal_write`  | Write explicit text/control characters to the existing running PTY. Do not append a newline. Use the existing write-size limit. Return acknowledgement, not an assertion that a shell command succeeded.                                                                                                                                                                        |
| `terminal_resize` | Explicitly change PTY dimensions using existing dimension limits. Reading never changes dimensions.                                                                                                                                                                                                                                                                             |
| `terminal_kill`   | End one toolkit terminal. Default `cleanup: false` retains final logs and exit status; `cleanup: true` also removes the session and history. The handle must identify a toolkit terminal in the caller's project. Never kill by an arbitrary PID or close all terminals implicitly.                                                                                             |

There is no arbitrary PID kill tool, shell-command completion inference, automatic command retry, restart tool, clear-history tool, or screen-emulation API in this version. Ctrl-C is input through `terminal_write`: it interrupts the foreground program, which is different from ending the whole terminal session with `terminal_kill`.

## Output and cursors

Use the manager's retained output as the single history source. Existing retention remains 5,000 lines and 8 MiB per terminal. Existing query/reply filtering remains in place.

Reads return the retained terminal stream, which may contain ANSI control sequences; they do not claim to be a rendered screen. Default output budget is 16 KiB of UTF-8 text, with a 64 KiB maximum. Metadata is separately bounded.

An omitted cursor starts at the oldest retained output. A cursor identifies the terminal, output generation, and an absolute position. It is self-contained and does not store a consumer position on the server. Reading with one cursor cannot affect another reader.

An initial `tailLines` request selects the most recent 1–500 retained lines, still respecting the output byte cap. It cannot be combined with an input cursor or search. Return a normal stream cursor at the end of the returned range so the caller can subsequently follow new output; indicate when the byte cap shortened the requested tail.

Search accepts a nonempty literal string of at most 256 characters and optional case-insensitivity. Regex syntax has no special meaning. Return bounded matching excerpts with their source positions. Scan no more than 256 KiB of retained source per call, independently of the returned-output cap, and return continuation even when that slice has no matches. Bind search continuation to its query and case mode; it is distinct from a stream cursor. Matches spanning PTY callback, chunk, or scan-window boundaries must not be lost or duplicated. Do not rescan all history or construct one full history string for every page.

- Advance `nextCursor` only past returned output; `hasMore` signals unread retained output.
- If retention has overtaken a valid cursor, resume at the oldest retained position and set `truncated: true`.
- Reject malformed cursors, cursors for another terminal or generation, and positions beyond the current output end.
- Clear/restart paths invalidate previous generations, even though those operations are not exposed by this toolkit.
- Never split a Unicode code point at a returned boundary. Cover surrogate pairs split across PTY callbacks.

Cursor reads walk retained chunks and materialize only the requested slice. They must not call `history.value()` and then truncate its full string on every read. Appending output must remain incremental. Listing terminals never loads history.

`waitMs` defaults to zero and is capped at 30 seconds. A stream read at the current end can await an output or lifecycle event, returning early on data, exit, or cleanup. Search and initial tail selection do not accept waiting. Register the listener before checking state to avoid missed output. Cancellation and timeout detach the listener without closing the PTY. Tests use event receipts/deferred signals and the Effect test clock, not sleeps or polling.

## Integration and surfaces

Register the toolkit in `McpHttpServer.ts` and supply the same singleton `TerminalManager` layer already used by WebSocket clients. Do not construct a second manager inside a request or provider session.

Issue the terminal capability through the managed built-in MCP credential path. It is independent of browser, device, and Project Work capabilities. Existing credentials without it fail explicitly and receive it through the normal session replacement path. This version does not introduce a separate settings UI or an approval workflow.

Audit the native MCP connection setup in `provider/Layers/ProviderService.ts`: it currently conditions shared MCP registration partly on preview access. Terminal-capable sessions must retain the connection with preview disabled, while preview tools still fail their capability checks.

Codex, Claude, Cursor, Grok, OpenCode, and Antigravity reuse their existing managed MCP configuration paths. Verify the terminal toolkit's registration is not lost in any adapter's preview-disable path. Preserve existing external/unmanaged-provider limitations; do not rewrite provider-native terminal tools.

Web, desktop, and mobile keep their current terminal controls and thread-scoped wire shapes. Existing dock metadata subscriptions and events include only thread-owned sessions. Project-owned sessions share the same internal PTY/output machinery but are exposed through the toolkit in this version. Future project-terminal attachment can use their real project identity; it must not require a hidden or resurrected creating thread. Do not silently route a project ID through the thread terminal API.

Audit the manager's port-discovery registrations as well as its PTY/history handling: existing registrations use thread IDs. Project terminals must not be registered under fabricated thread IDs. Existing thread port discovery remains unchanged; project ownership must be represented explicitly wherever project-terminal processes are registered.

Local, LAN, relay, and tunnel users all target terminals on the environment server through existing authentication and transport. No client-local PTY, new listening port, fixed localhost URL, or desktop IPC route is required.

Update `docs/user/terminal.md` with concise agent-terminal usage, output retention, shared-control behavior, and project ownership. Update the existing terminal runtime constraint only where needed to explain ownership and cursor/retention behavior. No new internal feature catalog is needed.

## Acceptance checks

1. Agent A creates a terminal; A's request scope and credential end; agent B in another thread of the same project reads and writes the same process. No new spawn occurs.
2. Another project cannot list, read, write, resize, or close that terminal. A same-project agent cannot use the toolkit on a human-created dock terminal, even with its exact handle.
3. Separate readers advance independently. Reusing a cursor reproduces the same retained range until retention evicts it.
4. Byte limits, multiline eviction, long lines, Unicode boundaries, and stale/generation-mismatched cursors behave as specified without copying full scrollback on each read.
5. Reads of exited or killed terminals return status and output without restarting. Agent A can stop a terminal and agent B can read its final logs. `cleanup: true` removes only that session after termination. Tests cover final output arriving during termination, kill failure, repeated kill, and stopping versus observed exit.
6. A waiting read wakes on data or exit. Cancellation removes its listener and leaves the PTY alive. Concurrent creation/cancellation cannot leak an undiscoverable session.
7. Missing terminal capability fails through MCP; terminal capability works with browser capability absent; browser tools remain denied.
8. Archive and delete the creating thread, then delete the project's last thread: the same project terminal remains running with its history intact. A new thread in that project can use it. Existing dock terminals still close with their owning thread. Delete the project and drain the cleanup worker: its toolkit PTYs stop and history is removed, while other projects are unaffected. A concurrent create/delete leaves no orphan process. Equal-valued project and thread IDs cannot collide in storage or cleanup.
9. Focused tests exercise actual manager behavior with the existing fake PTY, toolkit authorization with distinct thread/project contexts, and MCP registration through the existing in-process HTTP test harness. Include a real local PTY smoke test where supported, using a temporary directory and only the process started by that test.
10. Run focused tests, lint, and scoped typechecks. No repo-wide checks, browser/computer use, live database writes, commit, or PR is implied.
11. Spawn a direct program with arguments containing spaces and shell metacharacters: the adapter receives those arguments intact, and program failure does not launch an unrelated shell. Default-shell creation remains supported. Titles appear consistently in list/read results without exposing environment values.
12. Tail selection obeys both line and byte limits. Literal search obeys scan/output limits, finds matches across chunks, continues through no-match pages, and rejects mismatched query cursors. Search, stream, and tail reads do not alter each other's progress.

## Review decision

The maintainer confirmed project ownership and agent termination, and supplied opencode-pty as the interaction reference. The implementation plan carries those decisions, direct program spawning, retained logs after kill, and bounded tail/search reads. Review the revised plan before implementation under the selected planning workflow.
