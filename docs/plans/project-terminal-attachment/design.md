# Project terminal attachment and completion notices

Status: proposed for maintainer review. This is a design artifact, not an implementation record.

## Outcome

A person can discover a terminal started by an agent, open its contents in the web terminal dock, and choose whether to watch or interact. An agent can subscribe to that terminal's completion, choosing a thread notice alone or a notice that also wakes the agent. Terminal processes continue to belong to the environment server and project. Process recovery across server restarts is future work.

## Scope and identity

- Applies to project-owned terminals created by the terminal MCP toolkit. Existing thread-owned dock terminals keep their current contracts and behavior.
- Web and desktop expose the attachment UI; desktop uses the web client. Mobile gains no new terminal UI in this release.
- A new optional environment capability advertises project-terminal attachment. New web clients hide the project dock section and do not start the new metadata stream against older servers that lack it.
- Every client target carries environment ID, owner kind, owner ID, and terminal ID. Creating thread is attribution and the destination for activity, never the terminal owner.
- Client RPC authorization follows existing environment scopes: an authenticated terminal-operate client can access projects on that environment. The server checks that the requested project exists and that the terminal belongs to it; the client-supplied project ID is never proof of terminal ownership. MCP agents keep their narrower calling-thread project restriction.
- No server restart recovery, regex search, arbitrary process attachment, or human-created dock terminal access through agent tools.

## Discovery and dock

- A lightweight project-terminal metadata stream starts with at most 100 entries ordered by stable terminal ID and follows with compact creation, status, resize, and removal updates. It carries no output or command arguments. Further entries are available through paged listing. It is scoped to the current project and environment; slow consumers resync instead of blocking PTY output or lifecycle processing.
- The web dock lists project terminals independently of the current thread's dock terminals. The originating thread shows a compact creation activity row. A completion activity row appears when an agent subscribed to completion. Each row links to **Open in dock**. Other threads in the same project can find the terminal and its current status in the dock list.
- All terminal contents, including retained output after exit, render in the dock. Activity and summary surfaces show only title, command label, status, exit outcome, and the open action.
- Selecting a project terminal subscribes to an existing session. The attach route cannot create, restart, clear, or resize. It registers for events before reading the snapshot and reconciles by event sequence. A missing or foreign-project handle is unavailable. Closing its tab detaches; it does not kill or clean up the PTY. Exited sessions remain openable until ordinary retention or explicit cleanup removes them.
- The read-only view is the default. It suppresses keyboard input, paste, pointer escape sequences, terminal-generated replies, resize, and other writes at the client transport path. Its renderer keeps the PTY's existing grid through viewport changes and follows resize events from agents or other clients. Switching to Interactive explicitly enables input; any kill/cleanup action remains separate and clearly labeled. Read-only is a view mode, not a distinct user authorization role: the same authorized person can switch modes.
- Shared input follows the existing toolkit model: agents and interactive human attachments can write concurrently. Only focused interactive web attachments send automatic resize updates. If multiple clients are focused, the most recent resize wins, as with other shared PTY writes. Read-only views never affect dimensions.

## Completion subscriptions

- Add an MCP subscription operation for an existing toolkit terminal, plus an explicit unsubscribe/update operation. Each subscribing thread has at most one active subscription per terminal; subscribing again updates that thread's mode. The mode is `notice` or `noticeAndWake`. The agent explicitly chooses it; terminal_spawn does not subscribe implicitly. Allow at most 32 subscribing threads per terminal.
- The subscription captures the terminal's originating thread at registration. It is one-shot and triggers on observed process exit, whether natural, killed, or errored. A registration after exit delivers the outcome immediately and still at most once. Cleanup without observed exit cannot fabricate a successful completion.
- Project-terminal status remains visible in dock metadata whether or not an agent subscribed. If subscribed, one completion activity record is its persistent notice in the originating thread; it does not add a duplicate message per subscriber. If any subscription chose `noticeAndWake`, the origin receives one wake request. Unsubscribe before completion processing prevents only the optional notice/wake, not the dock status update. After delivery commits, unsubscribe cannot retract it. A delivered terminal generation keeps a tombstone so a later subscription cannot trigger another notice/wake. A deleted origin thread cancels notice/wake delivery; the terminal may remain available in the project until project deletion or cleanup. Archived threads receive the optional notice but do not automatically wake an agent.
- A `noticeAndWake` completion persists an internal intent keyed by terminal and output generation. It carries bounded terminal identity and observed exit status, not scrollback. It does not create a user message. The agent can call terminal_read for logs.
- If the origin thread is idle, the intent starts an agent continuation. If busy and its provider explicitly supports safe steering, deliver it into the running agent promptly. Otherwise queue it until that turn settles. A provider rejection that proves no input was accepted queues; an ambiguous transport failure records unknown delivery and must not blindly retry. Combine pending terminal completions into one continuation. Recheck eligibility immediately before dispatch: a deleted or archived origin cancels pending wake, and an unavailable provider session leaves the visible notice without starting a provider. Pending wakes from a previous environment-server run are canceled rather than dispatched after restart.
- Provider adapters must explicitly declare and test safe active-turn steering. The new internal continuation is processed by orchestration/provider machinery; terminal event listeners enqueue work and return promptly. Delivery failure is visible in the thread activity and leaves the completion outcome readable.
- Subscription state lives for the lifetime of the current environment server. Existing PTYs and subscriptions are not restored after restart; persisted dock links and activity handle unavailable terminals.

## Verification

- Authenticated web clients on local and remote connections can discover and attach to the same process in their selected project. A mismatched project/terminal handle is unavailable. Existing dock terminals cannot be targeted through the project attach route.
- Attaching, detaching, reading, and opening an exited terminal never spawn or restart. Read-only interaction, renderer replies, and viewport changes emit no PTY writes or resize calls. A focused interactive attachment can send input and resize; concurrent agent input remains possible.
- Metadata updates stay bounded and output only flows to attached dock views. Creation and subscribed completion activity contain no output. Opening from activity selects the right environment/project terminal.
- Subscribing before or after exit produces one notice per terminal generation. Unsubscribe before completion processing prevents the optional notice/wake; it cannot retract a delivered notice. Killed and failed processes report observed outcomes. Multiple event callbacks, reconnection, and cleanup do not duplicate notice or wake.
- `notice` never starts a turn. `noticeAndWake` steers supported busy providers, queues for unsupported or known-rejected steering, and starts an idle continuation without a synthetic user message. Ambiguous sends become visible unknown delivery without automatic retry. Pending completions coalesce; deleted/archived origin threads follow the stated rules.
- Focused contract, manager, authorization, orchestration, provider-adapter, client-runtime, and web component tests cover these paths. No browser run unless the maintainer requests it.

## Known risk

The current root turn-start path requires a persisted user message. Supporting a terminal-origin continuation requires a new internal orchestration intent and provider delivery path. Provider-specific steering cannot be inferred from the existing sendTurn method and must be declared explicitly.
