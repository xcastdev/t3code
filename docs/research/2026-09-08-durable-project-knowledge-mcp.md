# Durable project knowledge and tracked tasks through MCP

Date: 2026-09-08

## Summary

The strongest pattern across the projects reviewed is a server-owned structured store with one shared read and write path for agents and humans. T3 should make project knowledge, tasks, checkpoints, and decisions first-class records, then expose bounded MCP tools and the T3 UI over the same service. Git should remain the source-control authority, but task and knowledge state should not depend on markdown files or Git branch state.

The closest design references are:

- Beads for dependency-aware, agent-native work selection and durable memory.
- Rhizome for leases, resumable work attempts, bounded context, and version-pinned review.
- Saga MCP for a compact product shape with a shared SQLite database, hierarchy, notes, activity log, UI, and MCP tools.
- Letta for separating always-available current context from searchable archival memory.

These are reference patterns, not dependencies. Each project makes a different storage and deployment trade-off.

## Verified project findings

### Beads

The current Beads repository describes itself as a distributed graph issue tracker for AI agents. Its core workflow is create, inspect dependencies, select ready work, claim it, and close it. It exposes JSON output, dependency tracking, ready-work detection, and links between discovered issues. See the [Beads README](https://github.com/gastownhall/beads#readme).

Beads stores its database in Dolt. It supports an embedded single-writer mode and a server mode for multiple concurrent writers. It can synchronize data through Dolt remotes, while Git integration remains optional. See [Beads storage modes](https://github.com/gastownhall/beads#-storage-modes) and [Git-free usage](https://github.com/gastownhall/beads#-git-free-usage).

The current repository also describes hash-based IDs, typed issues, priorities, assignees, design notes, acceptance criteria, dependency edges, comments, and audit events. Its database is canonical, while JSONL is an export and interchange format. See [Beads architecture](https://github.com/gastownhall/beads/blob/main/docs/ARCHITECTURE.md) and [Beads sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md).

Beads also documents an MCP server and agent setup. Its guidance says project work belongs in Beads instead of markdown task lists, and it provides ready, claim, dependency, memory, and close operations. See the [Beads agent instructions](https://github.com/gastownhall/beads/blob/main/AGENTS.md#issue-tracking-with-beads-beads).

Useful T3 lessons:

- A task needs dependencies and a ready query, not only a status field.
- Git synchronization is useful but should not be confused with the task database's source of truth.
- Agent workflow instructions are part of the product contract. They should be discoverable through MCP resources or project instructions.
- A local database can work without requiring every task mutation to create a Git commit.
- A task model should carry acceptance criteria, design context, provenance, and typed relationships instead of forcing those fields into one description string.

Risks to avoid:

- A second database beside T3 would recreate the split the workspace direction is meant to remove.
- Shared mutable task files create merge conflicts and ambiguous ownership.
- A daemon that watches several worktrees needs explicit repository and worktree ownership.

### Rhizome MCP

Rhizome is a local-first MCP task tracker that explicitly targets concurrent, context-limited, and interruptible coding agents. It uses one SQLite database per project and supports multiple MCP clients. See the [Rhizome README](https://github.com/Odrin/rhizome-mcp#readme).

Its important design is that in-progress is derived from an active renewable lease. A vanished agent does not leave an issue permanently locked. A partial unique index limits one active attempt per issue. Rhizome also stores checkpoints with next steps, supersedable decisions, append-only history, and FTS5 search across issues, comments, decisions, and notes. See [Rhizome's failure-mode design](https://github.com/Odrin/rhizome-mcp#why).

Rhizome keeps MCP output bounded. It describes compact list projections, graph nodes without free-text bodies, snippets for search, event-ID delta sync, and a bounded work-context package. It also pins review requests to an exact issue version and event position, so an approval cannot silently apply to newer work. See [Rhizome's MCP surface](https://github.com/Odrin/rhizome-mcp#-mcp-surface).

Useful T3 lessons:

- Store attempts and leases separately from task state.
- Make recovery a normal state transition, not a cleanup script.
- Add a single bounded context tool for a new session. Do not make an agent perform ten broad searches to resume work.
- Pin approvals and reviews to a version or checkpoint.
- Use database constraints to enforce ownership and concurrency.

### Saga MCP

Saga MCP presents a Jira-like hierarchy of projects, epics, tasks, and subtasks. It adds dependency blocking and unblocking, threaded comments, typed notes, templates, source references, and batch operations. See [Saga's feature list](https://github.com/spranab/saga-mcp#features).

Saga stores its data in SQLite and exposes the same database to an MCP server and a local web UI. Every mutation writes an activity record with the old and new values. It also supports soft deletion and restoration for comments and tasks. See [Saga's storage and activity model](https://github.com/spranab/saga-mcp#how-it-works) and [Saga's shared web UI](https://github.com/spranab/saga-mcp#web-ui).

Saga limits the advertised tool catalog with a core profile, while still enforcing authorization and validation inside every tool. Its README explicitly says tool visibility is a context-size control, not an authorization boundary. See [Saga's configuration](https://github.com/spranab/saga-mcp#configuration).

Useful T3 lessons:

- The UI and MCP must call the same handlers and write the same activity log.
- Protect task descriptions from accidental progress overwrites. Progress belongs in comments or checkpoints.
- Soft delete and restore fit durable project records better than irreversible deletion.
- Tool profiles reduce context cost, but server-side authorization remains the real control.
- A dashboard or work-context query is more useful than exposing only CRUD methods.

Risks to avoid:

- A local-only unauthenticated HTTP server is not suitable for T3's remote environments.
- A single project database is simple, but T3 needs environment, project, and repository scoping across devices.
- Free-form natural-language summaries should be derived views, not the canonical record.

### Plane MCP

Plane's official MCP server models projects, work items, cycles, modules, releases, pages, labels, comments, members, and relationships as first-class resources. It consolidates many operations into one tool per resource, with an action declaration generating descriptions, annotations, validation, and dispatch. See the [Plane tool-surface design](https://github.com/makeplane/plane-mcp-server/blob/main/plane_mcp/tools/README.md#the-tool-surface).

Plane makes scope explicit. Some resources are project-owned and others workspace-owned, and the MCP server tests wrong-scope reads and writes. It supports local stdio and remote HTTP transports with API-key or OAuth authentication. See [Plane's scope rules](https://github.com/makeplane/plane-mcp-server/blob/main/plane_mcp/tools/README.md#scope-project-vs-workspace) and [Plane's transport and authentication options](https://github.com/makeplane/plane-mcp-server#transports).

Its server hides retired per-operation tool names while keeping aliases for compatibility. It also uses server-side structured querying rather than asking the model to fetch every work item and filter it in context. See [Plane's compatibility aliases and querying](https://github.com/makeplane/plane-mcp-server#retired-tool-names).

Useful T3 lessons:

- Group MCP tools around durable domain resources and high-value actions. Generate schemas, annotations, and dispatch from one declaration.
- Make project, environment, and organization scope explicit in every query and mutation.
- Keep compatibility aliases when consolidating a tool surface.
- Use structured server-side filters and bounded projections for large task lists.

### Official MCP knowledge graph server

The official MCP servers repository includes a small memory server built around entities, relations, and atomic observations. It exposes CRUD and search tools plus a readable MCP Resource for the current graph. See the [memory server concepts](https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md#core-concepts) and [API](https://github.com/modelcontextprotocol/servers/blob/main/src/memory/README.md#api).

The implementation queues mutations and persists with temporary-file-then-atomic-rename. Resource updates can notify clients to refresh. See the [memory server implementation](https://github.com/modelcontextprotocol/servers/blob/main/src/memory/index.ts#L79-L185).

Useful T3 lessons:

- Keep relationships as first-class records rather than relying only on Markdown links.
- Make knowledge changes serializable and recoverable under concurrent agent writes.
- Expose a resource or subscription so the UI can react when an agent updates project knowledge.

### Letta

Letta separates always-available current context from searchable historical memory. Its memory architecture describes bounded, labeled core memory blocks that remain in context, and archival memory that is searched explicitly when needed. See [Letta's memory architecture](https://github.com/letta-ai/skills/blob/main/letta/agent-development/references/memory-architecture.md).

Letta's current repository also separates the agent runtime and persistent identity from the client surfaces, with local/self-hosted and cloud deployment options. See the [Letta repository landing page](https://github.com/letta-ai/letta#readme).

Useful T3 lessons:

- Do not put the entire project knowledge base into every prompt.
- Keep a small current-project briefing, active tasks, constraints, and decisions available by default.
- Put historical notes, prior conversations, and large references behind search and explicit hydration.
- Give memory records labels, descriptions, size bounds, and ownership.
- Distinguish current context, durable knowledge, and conversation history. They have different retention and retrieval rules.

## Cross-project comparison

| Concern                 | Beads                          | Rhizome                                    | Saga MCP                   | Letta                            | T3 recommendation                                                                |
| ----------------------- | ------------------------------ | ------------------------------------------ | -------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Primary store           | Dolt                           | SQLite                                     | SQLite                     | Database-backed memory           | T3 SQLite event and projection model                                             |
| Task graph              | Strong dependency graph        | Dependencies, claims, reservations         | Hierarchy and dependencies | Not the focus                    | First-class tasks with typed relations                                           |
| Agent concurrency       | Claim and sync workflows       | Renewable leases and unique active attempt | Basic tracker operations   | Agent/runtime state              | Leases, attempts, and database constraints                                       |
| Knowledge               | Agent memory and linked issues | Decisions, checkpoints, notes, FTS5        | Typed notes and search     | Core plus archival memory        | Current briefing plus searchable durable records                                 |
| Recovery                | Sync and import/export         | Expired attempt and checkpoint handoff     | Soft delete and restore    | Conversation and archival recall | Resume, supersede, restore, and audit                                            |
| UI                      | Mostly CLI and integrations    | CLI and status board                       | Web UI over same DB        | Desktop, web, cloud              | T3 web, desktop, and mobile over one service                                     |
| MCP                     | Agent setup and JSON workflows | Broad lifecycle toolkit and profiles       | Broad CRUD plus profiles   | MCP tools for memory and agents  | Small intent tools plus bounded work-context reads                               |
| Source-control coupling | Optional or synchronized       | Local project store                        | Separate local DB          | Independent                      | Keep project records server-owned; link Git refs without making Git the database |

## Recommended T3 model

### One project record, multiple record types

Use a shared project record with typed children:

- Task: planned work with status, priority, owner, dependencies, labels, source references, and acceptance notes.
- Attempt: one agent or human working interval with a renewable lease, checkpoint, and outcome.
- Knowledge note: a decision, constraint, context note, technical reference, blocker, or progress note.
- Decision: a supersedable record with rationale, alternatives, author, and affected scope.
- Comment: append-only discussion attached to a task, note, or attempt.
- Review request: a version-pinned request for validation, tied to a task or Git checkpoint.
- Event: append-only mutation history used to build projections and audit views.

Keep record IDs stable across worktrees and sessions. Store Git branch, commit, and worktree references as links. Do not make branch names the task IDs.

### Current context and search

Expose two retrieval shapes:

1. get_project_briefing, which returns active tasks, blockers, current attempts, recent decisions, and the latest checkpoints in a strict size bound.
2. search_project_knowledge, which returns ranked snippets and record IDs. The agent must call get or read to hydrate full content.

This follows Letta's current-versus-archival split and Rhizome's bounded context package. It keeps routine prompts small and makes historical retrieval deliberate.

### Claims and recovery

An agent claims a task by creating an attempt with a lease. The task's effective in-progress state comes from the active attempt. Lease expiry makes the task claimable again and leaves the checkpoint available to the next session.

A task cannot have two active attempts unless a policy explicitly allows parallel work on disjoint resources. Add optional resource reservations for files, directories, ports, or deployment slots. Preserve the failed attempt and its checkpoint instead of overwriting it.

### Human and agent writes

The T3 UI and MCP use the same command handlers, as Saga does. UI controls should be more discoverable, but they must not have a separate validation path.

Use field-level write rules:

- A task description can be locked after approval.
- Progress goes into comments or checkpoints.
- Decisions are superseded, not edited in place after adoption.
- Deletes are soft and restorable.
- Batch planning is atomic and validates dependency cycles before writing.

Tool profiles can hide advanced operations from ordinary agents, but profiles are not authorization. The server checks project, environment, subject, and capability on every call.

### Storage and sync

Use T3's server-owned SQLite persistence and event/projector model instead of adding a second project database. Keep large note bodies and search indexes out of list responses. Add bounded projections and full-text search as a read model.

For offline or multi-device use, synchronize events or server projections through T3's existing connection and relay mechanisms. Do not synchronize competing copies of a mutable database through Git. Git can hold optional exported snapshots for human review, but the server record remains canonical.

### MCP tools

Start with intent-level tools:

- project.open and project.get_briefing
- tasks.list_ready, tasks.get, tasks.create, tasks.update, tasks.claim, tasks.checkpoint, tasks.complete
- knowledge.search, knowledge.read, knowledge.upsert
- decisions.list, decisions.read, decisions.propose, decisions.supersede
- comments.list, comments.add, comments.restore
- reviews.request, reviews.get, reviews.approve, reviews.reject

Return compact structured data and a receipt or record ID. Include MCP annotations for read-only, destructive, and approval-gated tools. Keep the full CRUD surface behind explicit profiles.

## Product conclusion

T3 should borrow Rhizome's lease and checkpoint model, Saga's shared UI/MCP handlers and activity log, Beads' dependency graph and ready-work query, and Letta's current-versus-archival memory split.

The central design decision is to keep all four inside T3's existing server-owned persistence and authorization model. Add adapters for MCP and clients, not another project tracker. Start with tasks, attempts, checkpoints, decisions, and search. Add richer notes and resource types after the core recovery and concurrency rules work.
