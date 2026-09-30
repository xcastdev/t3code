Github Tracked: false
Status: in_progress
Github Issue: none
Plan review: READY_WITH_EXPLICIT_GATES

# Pi project teams

## Goal

Make T3 a project-management workspace for directing pi teams across multiple
projects, with GitHub issue intake, shared project memory, guided delivery, and a
consolidated view of progress and decisions. The user captures work cheaply,
develops it when ready, and supervises execution without following every agent
conversation.

This record preserves the specification agreed in the conversation. It is an
implementation work artifact copied into the repository root at the user's
explicit request, overriding the usual AGENTS.md artifact policy. The original
copy remains at `/home/user/Projects/t3code-work-notes/pi-project-teams.md`; the
repository-root copy is the maintained implementation record after this save.
`Github Tracked: false` describes delivery of this work record, not the product's
GitHub integration.

## Confirmed decisions

| Area          | Decision                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Execution     | Pi runs the initial custom team. Roles and workflow are independent of the runtime.                       |
| Environment   | One T3 environment serves multiple projects, accessible remotely.                                         |
| Coordination  | One coordinator per project; the user sets cross-project priorities.                                      |
| Autonomy      | Guided: human approval of specification, plan, and merge.                                                 |
| Communication | Workers communicate directly through durable, task-linked messages.                                       |
| Intake        | Issues from connected GitHub repositories automatically appear in T3.                                     |
| Starting work | The user explicitly starts investigation or execution. Capture and synchronization never dispatch agents. |
| Internal work | Research subtasks, conversations, attempts, and working notes stay in T3.                                 |
| Memory        | Agents automatically capture sourced observations; accepted decisions remain protected.                   |
| Deployment    | An established self-hosted memory engine may run alongside T3.                                            |
| Authority     | T3 owns workflow state, decisions, and approvals. GitHub owns its issues, PRs, reviews, and checks.       |

## Scope

In scope: automatic issue intake; issue refinement into tasks or missions; project
coordinators; configurable pi roles; direct team communication; local memory
integration; guided execution; isolated implementation; independent review;
GitHub delivery; portfolio and human inbox; web/desktop management and mobile
supervision; restart, disconnect, cancellation, and evidence recovery.

Later extensions: execution across multiple T3 environments; mixed-runtime custom
teams; automatic merge; broad scheduled autonomous work. Initial contracts leave
room for those extensions without implementing them.

## Specification

### Everyday workflow

1. Capture a GitHub issue with a short description and an optional label. It
   appears in its project's T3 intake. Lightweight reminders do not require a
   specification or agent activity.
2. Explicitly start investigation. The project coordinator retrieves relevant
   knowledge and delegates focused research where useful. Investigation does not
   authorize implementation.
3. Refine the same work. Findings remain internal. Propose a specification with
   scope, exclusions, acceptance criteria, and unresolved decisions. Publish a
   concise agreed description to the linked issue while preserving its identity.
4. Approve the specification and plan. A bounded issue becomes an execution task;
   larger work becomes a mission with deliverable tasks and dependencies. Internal
   research and execution steps do not each require GitHub issues. The user can
   request changes, defer, or cancel.
5. Dispatch eligible work according to priority, dependencies, capacity, and
   limits. Independent implementation branches receive separate worktrees. Each
   worker receives the approved assignment and relevant context.
6. Handle exceptions through the inbox. Workers resolve ordinary details and ask
   teammates questions. Product ambiguity, material scope changes, conflicting
   decisions, and exhausted repair limits reach the user. Other eligible work
   continues.
7. Validate and review the result. Retain test evidence and independent findings
   tied to the actual revision. Permit bounded repairs and PR creation under the
   approved workflow. The user authorizes merge.
8. Preserve the result, evidence, decisions, and useful lessons. Link PRs to tasks
   and issues. Future workers can retrieve the relevant history.

An investigation may end with a recommendation, duplicate finding, or decision to
abandon the issue. Human-completed reminders and non-code deliverables do not
require a PR.

### Team model

A role defines how an agent works. A team member has a durable identity and
assignments. An execution session is replaceable.

Initial role templates:

- Coordinator: maintain the project's current picture, propose and assign work,
  summarize progress, and escalate decisions.
- Investigator: examine code, documentation, failures, and uncertainty; return
  sourced findings.
- Specifier/planner: turn intent into clear behavior, criteria, tasks, and
  dependencies.
- Implementer: make scoped changes and produce validation evidence.
- Reviewer: independently examine specifications, changes, and evidence.
- Integrator: reconcile dependent changes and validate the combined result.

Profiles configure instructions, skills, tools, model selection, memory access,
and delegation limits. Tasks use only needed roles. Each run retains the profile
revision and resolved configuration it started with. The coordinator retains its
identity and relevant context across sessions and wakes for meaningful events;
routine scheduling and state updates do not require a model.

Every pi child execution appears in T3 with its parent, role, task, workspace,
configuration, and usage. Delegation uses T3 scheduling and limits. Role names
alone do not impose tool restrictions.

### Communication and steering

Workers directly share findings, ask questions, request reviews, and hand off
artifacts within authorized project scope. Exchanges record sender, recipient,
task or mission, and evidence. Delivery, acknowledgment, and resolution are
distinct. Pending questions survive session replacement; duplicate delivery must
not duplicate work.

The coordinator resolves assignment conflicts and escalates decisions. Messages
cannot silently change approved scope or grant authority. The user can inspect
exchanges and distinguish queued steering, immediate interruption, and a requested
assignment revision. History records what changed and why.

### Memory and context

T3 retains authoritative source records. The external memory engine extracts
observations and retrieves relevant information. Each attempt receives a bounded
briefing containing its objective, approved specification, scope, decisions,
pending questions, evidence, and remaining limits. Additional history is fetched
as needed. Compaction and replacement reconstruct context from durable records.

Memory covers architecture, conventions, terminology, decisions, investigations,
previous attempts, failure explanations, validation evidence, useful lessons, and
team practices. Automatic extraction produces sourced observations immediately
available to authorized agents. Observations remain distinct from accepted
decisions. Conflicts remain visible, and corrections or supersession affect later
retrieval.

Project memory is isolated by default; cross-project sharing is explicit. The user
can inspect, correct, supersede, and remove knowledge. Deletion reaches derived
retrieval data. Memory outages preserve tasks, approvals, decisions, and basic
briefings. Pending extraction catches up without duplication.

Evaluate Mem0 and Graphiti against representative project history; select one
engine based on recall, project isolation, correction/deletion, provenance,
recovery, and operating cost. The reviewed P1 memory slice selects Mem0 as a
derived dense-only index; configuration, evidence, and remaining production
obligations are recorded under Implementation progress. The full P1 exit gate
and subsequent memory integration remain incomplete.

- [Mem0 self-hosted overview](https://docs.mem0.ai/open-source/overview)
- [Graphiti temporal memory and provenance](https://github.com/getzep/graphiti)
- [Pi SDK integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi subagent example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md)

### Management interface

The portfolio shows active missions, queued work, blockers, recent results, work
awaiting review, and human decisions. Each project has issue intake, a work board,
coordinator conversation, team activity, and knowledge. Tasks link specification,
plan, workers, worktree, evidence, communications, and PRs.

Inbox requests explain what is needed, why, available choices, and what resumes.
Marking a request seen does not resolve it. The PR view combines changes, criteria,
test evidence, CI, findings, and merge conditions. Status follows recorded events;
queued, waiting, stopping, failed, and disconnected states remain distinct. Cached
views show their age when disconnected.

Web and desktop provide full management. Mobile provides supervision, questions,
approvals, steering, and pause/stop through the same authoritative command path.

### Scheduling, recovery, and GitHub

T3 determines run eligibility and enforces dependencies, ownership, concurrency,
approvals, and limits. Coordinators propose priorities and assignments. Limits
persist across retries, model changes, and replacement agents; delegated work
counts toward usage. Repeated failure without relevant change leads to diagnosis
or escalation.

Pause prevents dispatch and records how active work stops. Cancellation propagates
to owned execution and preserves history. Resume rechecks ownership, dependencies,
approvals, and evidence. Integrated revisions require validation in addition to
individual worker branches.

GitHub issue edits/comments update the external record. Changes affecting approved
scope become proposed revisions requiring approval. External issue closure does
not prove acceptance. Repeated or delayed events cannot duplicate workers,
overwrite newer decisions, or duplicate publication. Changed PR revisions make
affected review and test evidence visibly stale.

### Preserved invariants and material risks

Extend existing Project Work and provider-neutral contracts. Preserve remote
access, bounded subscriptions, recoverable history, and equivalent UI/agent
authorization. Main risks are conflicting copies of project truth, stale evidence,
memory pollution, and coordination overhead.

## Acceptance criteria

- [ ] AC-1: Connected repository issues appear in intake without starting agents.
- [ ] AC-2: A minimal issue can develop into a specified task or mission while preserving its identity, links, and investigation history.
- [ ] AC-3: Internal research, attempts, conversations, and working notes remain accessible in T3 without requiring separate GitHub issues.
- [ ] AC-4: Guided execution enforces approval of the applicable specification and plan; merge requires human authorization.
- [ ] AC-5: Each project has a coordinator, and every delegated pi execution is visible with its task, parent, role, workspace, and usage.
- [ ] AC-6: Parallel implementation verifies and uses separate assigned worktrees.
- [ ] AC-7: Agent messages and pending questions survive restart; repeated delivery does not duplicate work.
- [ ] AC-8: An answer from another device resolves the intended request and resumes only eligible work.
- [ ] AC-9: Automatically captured memory includes provenance and remains distinguishable from accepted decisions.
- [ ] AC-10: Retrieval respects project boundaries, corrections, supersession, and deletion.
- [ ] AC-11: Memory-service failure preserves authoritative workflow operations and basic briefings.
- [ ] AC-12: Session replacement and compaction preserve assignments, approved scope, decisions, pending questions, and remaining limits.
- [ ] AC-13: Pause, cancellation, recovery, and reassignment prevent conflicting ownership and preserve execution history.
- [ ] AC-14: Repeated failures exhaust the configured repair allowance and produce an actionable escalation.
- [ ] AC-15: Review and validation evidence identify their applicable revisions; subsequent changes invalidate affected evidence.
- [ ] AC-16: GitHub synchronization handles duplicate events and concurrent edits without duplicating effects or silently changing approved scope.
- [ ] AC-17: The user can supervise concurrent work in two projects and identify ownership, stage, blockers, and next actions without opening individual transcripts.
- [ ] AC-18: A real issue reaches a reviewable PR with its approved specification, plan, decisions, evidence, and review accessible from T3.
- [ ] AC-19: The same work and human requests can be supervised remotely through web, desktop, and mobile.

## Implementation plan

Slug: `pi-project-teams`

Grounded in `/home/user/Projects/t3code` at commit
`91b7c87b4656dbe467a7043bab1e91045311d4da`. Source paths below are relative to that
checkout. Paths marked **new** are proposed files, not claims about existing code.
Execute steps according to their dependencies and the parallel-agent execution
strategy below. Contracts, authorization, and state transitions have one writable
owner at a time. Astra reviews integrated candidates read-only.

### Parallel-agent execution strategy

Use one lead/integrator and two or three implementation workers. The user owns
priorities and product decisions; the lead owns assignments, dependencies, and
integration. Assign one worker per independent writable scope. Roles change by
stage rather than remaining permanent seats.

The planning session supports four active agents total, including the lead.
Use at most three concurrent workers, and give Astra a freed worker slot at
review gates. This development-team limit does not change the product's runtime
concurrency policy.

| Stage                                | Concurrent assignments                                                                                                                                                                            | Exit gate                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Dependency proofs, P1             | Worker A proves pi sessions, tools, cancellation, isolation, and packaging. Worker B evaluates memory engines against the same project-context fixtures. The lead settles integration boundaries. | Required runtime and memory behaviors have concrete evidence; unresolved P1 constraints block dependent work. |
| 2. Foundation, P2–P3                 | One owner implements contracts, persistence, and authorization. Other workers may finish isolated probes and prepare fixtures without changing shared contracts.                                  | Stable interfaces and passing persistence/authorization checks.                                               |
| 3. Runtime and lifecycle             | Worker A implements P7 pi integration. Worker B implements P4 guided lifecycle, then P5 GitHub intake. The lead owns shared wiring.                                                               | Both branches integrated and tested against the foundation.                                                   |
| 4. Supervised execution              | Worker A implements P8 scheduler/recovery. Worker B implements P6 initial human workflow. Worker C may build only the selected P10 memory backend adapter against an agreed interface.            | Durable dispatch/recovery and usable human approval controls.                                                 |
| 5. Coordination and delivery         | Complete P9 mailboxes, then P10 context/memory integration, then P11 review/PR delivery. Independent adapter work may overlap where contracts and writable scopes are settled.                    | A guided task reaches a reviewable PR with recorded evidence.                                                 |
| 6. Client supervision and validation | After backend and shared client APIs are stable, P12 web and P13 mobile presentation work may overlap. The lead performs final integration and P14 checks.                                        | Integrated client behavior, failure recovery, and required real-workflow evidence.                            |

These assignments preserve each step's dependency and acceptance gates. An early
adapter or presentation slice is preparatory work, not completion of its parent
step. In particular, full P10 still requires P8–P9; P11 retains P8–P10; and P13
completion still requires P12 integration. Declare the bounded slice and its
interface before dispatching it. Do not guess unfinished contracts to fill an
otherwise idle worker slot.

#### Ownership and isolation

- Pi worker: provider adapter, worker process, protocol, and focused tests.
- Workflow worker: lifecycle policy and transitions, followed by intake.
- Client worker: assigned web or mobile components consuming agreed contracts.
- Lead: shared contracts and exports, migration sequence, server registration,
  shared client APIs, dependency/lockfile changes, and final integration. During
  P2–P3, the lead may delegate the whole foundation scope to one owner.
- Astra: read-only adversarial review of an integrated candidate, with findings
  tied to acceptance criteria and reproducible failure cases.

Give every implementation worker a separate worktree and branch based on an
explicit integrated revision. One owner edits each shared boundary at a time.
Worktrees prevent filesystem collisions; ownership prevents conflicting designs.
Workers request shared-interface changes from the lead before implementing them.
They do not independently rewrite contracts, migrations, or server wiring.

Each assignment includes a self-contained brief:

```text
Task: Implement P7 pi integration.
Base: <integrated commit>
Required behavior: <specific acceptance criteria>
Writable scope: <explicit files/directories>
Dependencies: <approved contracts and completed steps>
Checks: <focused commands from this plan>

Report shared-interface changes to the lead before implementing them.
Return changed files, exact test results, limitations, and integration requirements.
Do not launch dev servers, change unrelated code, or delegate further.
```

#### Integration and review

The lead integrates small completed slices, inspects their diffs, runs relevant
cross-component checks, and then dispatches dependent work from the new base.
Workers run focused tests. The lead owns integrated verification; no repo-wide
checks or worker-owned dev servers. Browser/device interaction requires the
permission specified by repository instructions.

Use Astra after the foundation, after dispatch/recovery, and before declaring the
first complete workflow ready. Each gate reviews its integrated candidate. Ask
it to challenge duplicate dispatch, stale approvals, surviving worker processes,
cross-project memory leakage, and PR head changes after review. Separate branches
passing independently do not establish that their boundaries agree. Apply the
shared workflow's repair limits to each validation candidate.

First dispatch: pi feasibility and memory evaluation in parallel, with the lead
settling common interfaces. This resolves the dependencies most likely to force
a redesign before parallel implementation starts.

This execution strategy was added after Astra's recorded specification/plan
review below. Astra has not separately reviewed this scheduling revision; its
prior verdict does not certify the new parallel assignments.

### Existing foundation and actual gaps

- `packages/contracts/src/projectWork.ts` already defines tasks, one leased/running
  attempt per task, specification approval, evidence, relationships, knowledge,
  decisions, attention, bounded reads, and commands. There is no team/mission,
  plan-approval, issue-intake, mailbox, or execution-dispatch contract here.
- `apps/server/src/projectWork/ProjectWorkRepository.ts` appends project-work events
  and projects them in one SQL transaction, with durable command receipts and
  reducer checkpoints. Use this authority; do not introduce a competing workflow
  database or put workflow events into the legacy chat stream.
- `ProjectWorkGateway.ts` handles authorization and shared RPC/MCP commands;
  `ProjectWorkPolicy.ts` determines eligibility; `ProjectWorkRuntime.ts` wires the
  event bus and lease worker. Extend these seams.
- `apps/server/src/provider/ProviderDriver.ts`, `builtInDrivers.ts`, and
  `Layers/ProviderInstanceRegistryLive.ts` support per-instance drivers.
  `ProviderDriverKind` is already an open branded slug. Add a pi driver without
  closing that contract or routing sessions by role name.
- `Services/ProviderAdapter.ts` exposes start/send/steer/stop, compaction, and child
  transcript/control capabilities. OpenCode already handles child sessions. Pi
  should use the same T3 projections instead of a second chat implementation.
- `mcp/McpSessionRegistry.ts` and `McpInvocationContext.ts` currently identify an
  agent by provider-instance/thread and grant broad default terminal/PR capability.
  Team execution needs verified attempt bindings and narrower role capabilities.
- `pullRequest/IssueSearch.ts` is a capped, on-demand picker (30 results), not an
  intake synchronizer. Reuse GitHub transport/account routing, not this query limit.
- `pullRequest/PullRequestService.ts`, `PullRequestSyncReactor.ts`,
  `ThreadPullRequestReactor.ts`, and web `components/pullRequest/` provide existing
  PR operations, reads, checks, and thread links. Add task evidence and merge gates.
- `GitWorkflowService.ts`, `GitManager.ts`, and `WorktreeSetupTracker.ts` provide
  worktree and setup infrastructure. A worktree alone does not isolate credentials
  or give a durable guarantee that an old worker stopped writing.
- Web already has `components/work/` and `routes/work.$environmentId.$projectId.tsx`.
  Shared client queries/stream state live in `packages/client-runtime/src/project-work/`.
  Mobile has no equivalent work-management screen; navigation lives in
  `apps/mobile/src/Stack.tsx`.
- Fork migrations currently end at 018. Allocate new fork migration numbers at
  implementation time and register them in `persistence/Migrations.ts`; never
  modify already-applied migration bodies.

### Design decisions

1. **Preserve existing ownership.** Add missions as project-scoped grouping records
   with task references. Each independently scheduled assignment, including a
   research/review subtask, is an internal Project Work task with at most one active
   attempt. Parent/child run links record delegation; they do not relax that index.
   The initial portfolio aggregates project-owned missions and tasks without
   transferring their ownership or adding cross-project mission orchestration.
2. **Separate intake from authorization.** Cache external issue records separately
   from tasks. Stable host/repository/issue identity and project bindings survive
   rename, close/reopen, and repeated synchronization. Import never creates a
   provider session. Investigation and execution require different durable intents.
3. **Make gates revision-specific.** Store plan revisions and approvals alongside
   existing specifications. Bind approval to exact task/spec/plan content; bind
   merge authorization to repository, PR, head SHA, target branch, method, and
   applicable integration evidence. A stale gate is rejected, not silently renewed.
4. **Record effects before executing them.** Commit dispatch, publication, mailbox
   wake, and memory-indexing intents with domain changes. Workers consume a durable
   outbox with stable effect IDs and typed outcomes. Rebuild projections without
   replaying completed external effects. A lost response enters reconciliation;
   an ambiguous non-idempotent remote result does not receive a blind retry.
5. **Give every run an explicit identity.** A server-created binding joins project,
   task, attempt, team member, role revision, provider instance, thread/session,
   worktree, and lease generation. Derive identity from the credential/session
   binding, never caller-supplied actor fields. Use one T3 thread per scheduled
   worker; show parent/child relationships through the existing Agents experience.
6. **Keep the pi loop in a managed worker process.** Use the pinned pi SDK with a
   T3-owned resource/tool loader and a typed parent/worker protocol. Delegation calls
   T3; workers cannot start invisible team children. The protocol handles terminal
   lifecycle, actual cwd, bounded events, cancellation, compaction, and receipts.
   Packaging must support npm, Electron-hosted server, and the single executable.
7. **Prove operational authority.** Ordinary editing/testing is allowed only for
   the approved role/scope. Publishing and merging use server-held credentials
   and gate-checked tools. P1 must demonstrate that managed worker tools cannot
   reach those credentials, the live database, or the main checkout through an
   alternate shell/MCP path. This boundary includes worktree setup/install scripts
   and all their descendants, not only pi and its tool calls. If host isolation
   cannot support that guarantee,
   report the boundary and stop the dependent rollout; do not label an advisory
   prompt an enforced gate. General hostile multi-tenant isolation is out of scope.
8. **Keep memory reconstructible.** Store observations, source references,
   corrections, and retraction tombstones in T3. The selected engine is a derived
   extraction/retrieval service with project namespaces. Revalidate returned IDs
   against current authorized T3 records before hydrating context. An engine's
   inferred conflict resolution cannot change an accepted decision.
9. **Reuse GitHub and PR paths.** Synchronize intake with bounded, rate-aware
   conditional reads and periodic reconciliation, which works behind NAT without
   a public webhook endpoint. Publish approved summaries as versioned workflow
   comments on the existing issue; preserve human-authored body text. A separate
   explicit user edit may change the body. GitHub events/observations always enter
   the same reconciler; webhooks are an optional later transport.
10. **Stage delivery without weakening the end goal.** Every step has a focused
    gate. Keep execution disabled until identity, policy, pi, and dispatch gates
    pass. The full scope is complete only after mobile and the two-project recovery
    scenario pass. A dependency proof failing is a blocker, not permission to
    silently remove memory, guided authorization, or remote/mobile behavior.

### Ordered steps

- [ ] **P1 — Prove dependency boundaries and select one memory engine.**
      Dependencies: none. Covers AC-5, AC-6, AC-9–AC-12; validation V1.
      Read `.repos/effect-smol/LLMS.md` before writing Effect code. Verify the official
      pi repository/package scope and pin a released SDK version; do not assume older
      `@mariozechner` examples match the selected release. Build disposable probes
      outside the worktree for explicit cwd, fresh/resumed sessions, streaming,
      steering, cancellation of descendants, compaction, custom tool/resource loading,
      role-specific restrictions, model/auth routing, MCP bridging, and a true settled
      signal rather than the end of one model call. Test privilege isolation from D7,
      including setup/install scripts and descendants launched before pi, and packaging
      in the supported host layouts. Identify the actual local isolation
      mechanism before P7; if it introduces an unsupported host/deployment requirement,
      surface that decision before continuing. Compare pinned Mem0 and Graphiti on
      identical synthetic/project fixtures: source recall, conflicting observations,
      project isolation, delayed delete, restart during ingestion, repeated requests,
      current-vs-superseded facts, and outage fallback. Correctness gates require zero
      cross-project/deleted hits and retained provenance on every returned observation;
      compare recall to existing FTS on labeled relevant results. Record latency,
      model/token use, dependencies, license, backup procedure, and chosen configuration.
      Select Mem0 if both satisfy the gates and its operational cost is lower; select
      Graphiti only when measured retrieval/temporal benefits justify its extra service
      needs. If neither passes, stop memory implementation and report the failed facts.
      Promote useful deterministic fixtures into **new**
      `provider/pi/PiRuntimeContract.test.ts` and
      `projectWork/memory/MemoryBackendContract.test.ts` (under server `src/`).

- [ ] **P2 — Extend contracts and persistence additively.**
      Dependencies: P1 results for runtime/memory boundaries. Covers AC-2–AC-5,
      AC-7–AC-16; validation V2.
      Extend `packages/contracts/src/projectWork.ts`, `rpc.ts`, `settings.ts`, and their
      exports; use **new** sibling `projectTeams.ts`, `projectIssueIntake.ts`, and
      `projectMemory.ts` for the new bounded schemas. Define issue references/intake,
      mission/task membership, execution kind, immutable role/profile revisions,
      team-member identity, plan revisions, gates, run bindings, messages/questions,
      evidence applicability, repair episodes, limits/reservations, and memory source
      status. Preserve old task/attempt IDs and the one-active-attempt invariant.
      Extend project-work decider events, reducer state, projections, query shapes,
      stream record-ID extraction, and export versions. Add fork migrations for
      normalized projections plus durable effect receipts/outbox, run binding,
      repository-level intake cursor, and reservations. Claims, reservation allocation,
      and outbox insertion share one SQL transaction; competing projects must not
      reserve the same environment capacity. Unique keys cover live project
      coordinator, active task attempt, source observation, message command, and
      external effect ID. Projection/reducer checkpoint version changes invalidate old
      derived caches and replay safely; unknown read variants remain displayable.

- [ ] **P3 — Bind team authority to authenticated sessions.**
      Dependencies: P2. Covers AC-4, AC-5, AC-7–AC-10, AC-12–AC-13; validation V3.
      Extend `ProjectWorkGateway.ts`, `auth/EnvironmentAuth.ts`,
      `auth/RpcAuthorization.ts`, `mcp/McpSessionRegistry.ts`,
      `mcp/McpInvocationContext.ts`, and `mcp/toolkits/projectWork/{tools,handlers}.ts`.
      Resolve managed session -> current run binding -> role capabilities server-side.
      Bind credential validity to attempt generation and permitted project/task scope;
      revoke expired/reassigned runs. Keep legacy non-team identities compatible.
      Narrow the registry's current default terminal/PR grants for managed team runs;
      apply role restrictions at every toolkit handler, not just tool advertisement.
      Human approval cannot be minted by agent-originated requests. Spec/plan approval,
      question answers, delegation, memory promotion, and protected operations use one
      command path with expected revisions and idempotent receipts. Test forged actor,
      project, role, recipient, and lease fields; credential renewal; stale generation;
      duplicate approval consumption; and cross-device races.

- [ ] **P4 — Implement guided lifecycle and real investigation before approval.**
      Dependencies: P2–P3. Covers AC-2–AC-4, AC-8, AC-12–AC-15; validation V4.
      Extend `ProjectWorkDecider.ts`, `ProjectWorkPolicy.ts`, `ProjectWorkRepository.ts`,
      `ProjectWorkLeaseReactor.ts`, and **new** `ProjectTeamPolicy.ts`.
      Add explicit start-investigation and start-execution authorizations. Starting
      investigation creates a linked internal research assignment with bounded
      objective/outputs and a read-only role, without claiming the unspecified parent
      issue/task. The existing claim path currently needs a ready specified task; do
      not weaken it globally. Generated research assignments are eligible only through
      the explicit investigation grant. Planner/reviewer assignments similarly inherit
      authorized bounded scope, not new self-approved implementation authority.
      Freeze specification and plan revisions for an execution run; legacy approve or
      claim commands cannot bypass managed-task gates. Record approve/reject/revise,
      defer/reopen, pause/resume, cancel, failure resolution, and reassignment. Completion
      uses deliverable kind and required evidence; reminders and research can complete
      without code while code delivery distinguishes review-ready, awaiting merge, and
      delivered. Preserve revision-specific invalidation and bound repair episodes
      across task rerouting/session replacement. Parent completion requires the approved
      required deliverables; canceled dependencies do not count as success.

- [ ] **P5 — Add automatic, read-only issue intake and refinement.**
      Dependencies: P2–P4. Covers AC-1–AC-3, AC-16; validation V5.
      Add **new** `projectWork/github/GitHubIssueSync.ts`, `GitHubIssueClient.ts`, and
      `ProjectIssueIntake.ts`. Reuse `sourceControl/GitHubCli.ts`, canonical repository
      identity, account routing, and existing rate-limit helpers. Keep the existing
      30-result `IssueSearch.ts` picker unchanged. Fetch bounded pages including
      close/reopen changes; persist successful-page progress, overlap update windows,
      and use stable issue identity rather than titles. Deduplicate bindings when
      projects/worktrees share a repository; cache a repository once and select the
      explicit project when starting work. Reconnect/rename/auth failure cannot drop
      local investigation history or silently choose another repository/account.
      Bound comment bodies and pagination; issue listings exclude PR entries. Persist
      source revision and sync age/error. Add start-investigation/refine actions which
      create/link T3 records once. No intake event creates a model call. Closing an
      externally active issue raises attention; it does not fabricate acceptance or
      cancel an active worker without a recorded user decision. Add service startup/
      shutdown wiring in `server.ts` and `ProjectWorkRuntime.ts`.

- [ ] **P6 — Expose the first human workflow using existing Work UI.**
      Dependencies: P3–P5. Covers AC-1–AC-4, AC-8; validation V6.
      Extend `packages/client-runtime/src/project-work/index.ts` and
      `apps/web/src/components/work/{WorkPage,WorkTasks,TaskLifecycleControls}.tsx`.
      Add **new** `IssueIntake.tsx` and `GuidedTaskDetail.tsx` in the work directory.
      Provide paginated intake, investigate, linked findings, specification/plan
      review, approve/reject, and visible gate invalidation. Use expected revisions;
      preserve drafts on conflicts. Provide actions through project Work, settings,
      command palette, and relevant existing keybinding paths rather than only chat.
      No browser run in this planning task. This slice permits human-driven refinement
      before automated execution is enabled.

- [ ] **P7 — Register pi and implement managed runtime sessions.**
      Dependencies: P1–P3. Covers AC-5–AC-6, AC-12–AC-13; validation V7.
      Add **new** `provider/Drivers/PiDriver.ts`, `provider/Layers/PiAdapter.ts`,
      `provider/pi/PiWorkerProtocol.ts`, `provider/pi/PiWorker.ts`, and driver/adapter
      tests. Register `piAgent` in `provider/builtInDrivers.ts`; implement the existing
      driver snapshot/config/probe/adapter and declared capabilities. Keep driver kind
      separate from instance ID. Use the managed worker protocol and D7's proven
      isolation; never load arbitrary project extensions that bypass role tools or
      uncontrolled subagent spawns. Supply explicit model/auth/resource configuration,
      T3-issued MCP access, scoped skill materialization, and a frozen role revision.
      Add pi skill delivery to `skills/ProviderSkillAdapters.ts` and selected provider
      driver discovery; maintain native/managed resource precedence and report
      unsupported capabilities honestly. Emit T3 turn/tool/usage/agent events with
      stable IDs and cancellation/settlement semantics. Persist native session
      references and recoverable context without serializing credentials. Update the
      existing Pi Agent coming-soon entry in provider settings and provider metadata
      on web/mobile. New managed worker entry follows the existing Claude-history
      worker pattern: npm sibling entry plus executable subcommand through
      `apps/server/vite.config.ts`, `src/bin.ts`/CLI routing, and packaging scripts.
      Existing Codex/Claude/Cursor/Grok/OpenCode/Antigravity remain ordinary drivers;
      team eligibility advertises pi-only initially, not silent fallback.

- [ ] **P8 — Dispatch durable assignments and recover ownership.**
      Dependencies: P3–P5, P7. Covers AC-4–AC-6, AC-12–AC-14; validation V8.
      Add **new** `projectWork/ProjectTeamScheduler.ts`, `ProjectTeamDispatch.ts`,
      `ProjectTeamRecovery.ts`, and `ProjectTeamLimits.ts`; extend `ProjectWorkRuntime.ts`
      and layer wiring in `server.ts`. On explicit authorization, create the project
      coordinator identity once and dispatch work through existing orchestration/
      provider services. Commit assignment, lease, reserved capacity, and dispatch ID
      before worktree/process effects. Advance durable stages: reserved -> workspace
      ready -> session bound -> running -> stopping/settled. Reconcile a crash between
      each stage using the same effect ID. Reuse `GitWorkflowService.createWorktree`
      and orchestration thread creation with stable task/attempt links. Extend
      `project/ProjectSetupScriptRunner.ts` with a managed execution path using the
      same isolation and restricted credentials as managed pi; do not invoke its
      ordinary privileged terminal path for managed work. Record setup ID, script
      revision, cwd, run generation, and launch intent durably before starting it.
      `WorktreeSetupTracker` remains a UI projection: its current in-memory map is not
      restart evidence. Persist setup started/completed/failed receipts, track setup
      descendants, and verify real process completion before advancing. On restart,
      reconcile an uncertain setup without blindly repeating possibly non-idempotent
      scripts. Quarantine if the setup or descendants may still write and termination
      cannot be established. Await durable setup completion before sending the
      assignment. Verify canonical root,
      worktree registration, branch, and worker-reported cwd before the first tool.
      Never launch a replacement writable worker while the old process may still
      write; revoke tools and confirm exit, otherwise quarantine the run/worktree and
      request attention. Track owned PIDs/process handles at spawn, never by pattern.
      Waiting coordinators release model-call slots so children cannot starve. Reserve
      environment/project/model concurrency atomically and include child usage.
      Start conservatively with two environment model calls, one writable worker per
      project, delegation depth two, and two automatic repairs per episode; expose
      these as project policy. Freeze per-attempt token/time limits from configured
      model policy and reserve each model request's maximum before dispatch. Missing
      limits/capabilities block managed execution explicitly. Timeout, rate-limit
      retry, and semantic repair are separate counters; record actual route/model and
      never silently enable a paid fallback. Pausing revokes future dispatch and
      checkpoints/stops workers; resuming revalidates all gates and bindings.

- [ ] **P9 — Add durable worker mailboxes and human requests.**
      Dependencies: P3–P4, P8. Covers AC-5, AC-7–AC-8, AC-12–AC-14; validation V9.
      Add **new** `projectWork/ProjectTeamMailbox.ts` and `ProjectTeamWakeReactor.ts`;
      extend `ProjectWorkAttentionReactor.ts` and the MCP toolkit. Store message ID,
      sender/recipient member IDs, task/mission scope, reply-to, artifact references,
      delivery generation/cursor, acknowledgment, and resolution. Separate enqueue
      acknowledgment from successful model consumption; on uncertain delivery keep
      the original ID visible, and deduplicate resulting commands. Team identity
      survives session replacement. Bounded context delivery hydrates selected
      messages; queue normal messages until a safe turn boundary and make immediate
      stop/steer explicit. Durable wake IDs coalesce repeated notifications; no worker
      awakens just to acknowledge another acknowledgment. Cap message-driven work by
      the same task budget and depth. Persist human questions with target gate/revision;
      answer once via UI/MCP authorization and wake only eligible dependent work.
      Mark-seen remains independent from answer/resolution. Cancel/reassign identifies
      outstanding recipients and retains an actionable unresolved state.

- [ ] **P10 — Integrate the selected memory engine and context assembly.**
      Dependencies: P1–P4, P8–P9. Covers AC-9–AC-12; validation V10.
      Add **new** `projectWork/memory/MemoryBackend.ts`, one selected backend adapter,
      `ProjectMemoryService.ts`, `ProjectMemoryIndexReactor.ts`, and
      `projectWork/ProjectTeamContext.ts`. Extend `ProjectWorkBriefing.ts`,
      `ProjectWorkSearch.ts`, `ProjectWorkContentGuard.ts`, provider `RuntimeInstructions.ts`
      and `Layers/ProviderService.ts`. Auto-capture bounded meaningful findings/results
      as versioned observations with stable source IDs; raw tool streams stay artifacts.
      Reuse content guarding before extraction. The service endpoint/auth/model/embedder
      are server configuration, not browser origins or client secrets. Extraction
      outputs are schema-validated and retained in T3; index operations are idempotent
      on project/source/revision/generation. Fetching context never waits for ingestion.
      Rehydrate engine hits only after checking current project authorization,
      source revision, conflict status, and tombstones. Immediately suppress retracted
      IDs locally before asynchronous deletion; generation-fence delayed extraction
      and retries so a deleted source cannot reappear after restart or rebuild. Record
      explicit cross-project shares and revoke them when the source/share is removed.
      Preserve deterministic required context and FTS fallback, with omissions and
      degraded memory status. Reconstruct after every resume/compaction, keeping
      approvals and limits outside model-authored summaries. Retention/export/project
      deletion covers backend namespaces and source caches; deletion failures remain
      visible pending cleanup. Configure health, restart, backup, and restore for the
      companion service. Select one engine; do not operate two engines in production.

- [ ] **P11 — Tie evidence, independent review, integration, and GitHub delivery.**
      Dependencies: P4–P5, P8–P10. Covers AC-3–AC-4, AC-14–AC-16, AC-18; validation V11.
      Add **new** `projectWork/ProjectWorkEvidencePolicy.ts`, `ProjectTeamReview.ts`,
      `projectWork/github/ProjectWorkGitHubOutbox.ts`, and `ProjectWorkPullRequests.ts`.
      Evidence records exact command, exit status, retained raw artifact, workspace,
      tested tree/commit, base/head, environment summary, and spec/plan revisions.
      A dirty workspace result must identify the tested tree and cannot automatically
      qualify a later commit. Start reviewers in fresh sessions without implementer
      conversation history. Findings have stable IDs, severity, criterion references,
      revision, and resolution evidence; they do not imply authority to change scope.
      Integration jobs test the combined result and invalidate affected evidence when
      base or head changes. Reuse `PullRequestService.ts`, `PullRequestSyncReactor.ts`,
      `ThreadPullRequestReactor.ts`, `git/linkCreatedPullRequest.ts`, and the existing
      Git services for publication and links. Route every managed task PR-creation or
      merge path through policy, including existing RPC/MCP/PR actions; direct team
      shell credentials are unavailable under D7. Extend
      `packages/contracts/src/pullRequest.ts` (`PullRequestActionInput`),
      `pullRequest/PullRequestProvider.ts` (`runAction`),
      `GitHubPullRequestProvider.ts`, and `GitHubPullRequestCli.ts` to carry a required
      server-resolved expected head SHA for managed merges while preserving ordinary
      callers. Use a GitHub immediate merge operation with its head-SHA precondition;
      an ordinary `gh pr merge` success is insufficient because it can enqueue work.
      Reject `enable-auto-merge` for managed delivery. A queued/deferred outcome is
      not successful completion or standing authorization to merge later. Repositories
      that require a queue remain blocked for attention unless a future reviewed path
      can preserve approval of the exact revision through queue execution; do not
      bypass branch protections. Pre-existing or externally enabled standing
      auto-merge is surfaced for the human to disable before T3-controlled delivery
      resumes. Recheck the remote result and mark delivered only after confirming
      the authorized revision actually merged. Reconcile externally performed
      merges with actor/provenance; do not invent a T3 approval or success evidence.
      For outgoing comments/PRs, persist effect identity before sending, embed an
      opaque marker where possible, and reconcile uncertain responses by marker or
      repository/head branch before retrying. If reconciliation is ambiguous, stop
      publication for attention. External edits remain observations and proposed scope
      revisions. Do not automatically create external issues for internal assignments.

- [ ] **P12 — Complete portfolio, board, team, memory, inbox, and PR supervision.**
      Dependencies: P6, P8–P11. Covers AC-1–AC-5, AC-7–AC-10, AC-13, AC-15–AC-18;
      validation V12.
      Extend shared client queries/stream normalization and server bounded portfolio/
      inbox reads. Add **new** `apps/web/src/features/projectTeams/` with Portfolio,
      Team, Inbox, and memory inspection views. Extend existing Work pages and
      `components/pullRequest/PullRequestDetailPanel.tsx` rather than duplicate PR
      editing/diff/check components. Display current role/model, assignment, meaningful
      activity, linked worker, blocked reason, evidence applicability, and next action.
      Board moves request valid commands and explain rejected transitions. Include
      reverse controls (resume/reopen/unassign/re-enable) and preserve history. Add
      project/team/memory configuration to existing project settings. Wire sidebar,
      `CommandPalette.tsx`/logic, settings search, and relevant keybindings. Regenerate
      `routeTree.gen.ts` through the existing router generator after new routes. Use
      bounded pages/deltas and invalidate changed records; no full transcript fanout
      or continuously repainting status animation. Cached views show freshness and
      disable authoritative actions on disconnect.

- [ ] **P13 — Add mobile supervision and notifications.**
      Dependencies: P3, P8–P12. Covers AC-8, AC-13, AC-17, AC-19; validation V13.
      Add **new** `apps/mobile/src/features/project-work/` screens, register routes in
      `apps/mobile/src/Stack.tsx`, and reuse shared client-runtime project-work queries,
      applicability, and expected-revision actions. Support portfolio/project/task
      inspection, worker transcript links, questions, spec/plan/merge approval,
      queued steering, interrupt, pause/resume, and cancel. Wire mobile sidebar/home
      navigation and `features/agent-awareness/notificationNavigation.ts` to durable
      request IDs, not obsolete provider prompt IDs. Notifications are best-effort
      hints; the server inbox persists until resolution. Validate two-client answers,
      disconnect/reconnect, wrong environment/project routing, and stale notification
      targets. Desktop uses the same web routes; add shell-specific work only for
      deep links/notifications and packaged pi launch requirements.

- [ ] **P14 — Prove recovery, compatibility, packaging, and the real workflow.**
      Dependencies: P1–P13. Covers AC-1–AC-19; validation V14 plus scoped checks below.
      Add **new** `projectWork/ProjectTeams.integration.test.ts`,
      `ProjectTeamsCompatibility.test.ts`, and
      `ProjectTeamsPerformance.bench.ts`. Run two disposable Git repositories/projects
      and real SQLite services with a deterministic provider process and fake GitHub/
      memory servers. Interrupt at each committed dispatch/publication/index boundary;
      assert no duplicate writes, workers, observations, or completed effects. Exercise
      all 19 criteria through shared RPC/MCP handlers and client reducers. Include a
      waiting coordinator with queued children, two projects racing for one slot,
      process exit uncertainty, canceled work still sending messages, archived/deleted
      projects receiving old events, and malformed/unknown older-client variants.
      Rebuild projections and compare with authoritative history without executing
      side effects. Preserve existing FTS/briefing bounds and benchmark the existing
      2,000-task/8,000-knowledge scale with bounded portfolio/message pages.
      Add a separate explicitly opt-in real pi/memory/GitHub fixture runner for the
      disposable two-project issue-to-PR scenario; a mocked run cannot satisfy AC-18.
      Test npm bundle, packaged Electron server, and executable worker startup with
      install/auth failure reporting. Run one primary-agent integrated web/desktop and
      mobile pass using the repository skills only after permission for browser/device
      use; report unavailable host platforms as unverified. Update concise task-oriented
      guidance in **new** `docs/user/project-work.md`, relevant existing provider/
      settings/remote guides, and one operations section for memory service maintenance.
      Keep test-only screenshots out of Git. This work record is retained at the
      repository root by explicit user request.

## Validation commands and expected proof

Commands run from `/home/user/Projects/t3code`. New test paths below are explicit
implementation deliverables from the corresponding P step. These are planned
commands, not checks already run. Each V group is focused on its step; do not run
the repository-wide `test`, `typecheck`, or `check` scripts. Use receipts, queue
drains, controlled clocks, and captured worker exits rather than test sleeps.

### V1 — Dependency contracts (P1)

```sh
vp test run apps/server/src/provider/pi/PiRuntimeContract.test.ts apps/server/src/projectWork/memory/MemoryBackendContract.test.ts
```

The deterministic cases cover protocol validation; P1 also records exact
version-pinned disposable probe commands and results in this record before P7 or
P10 proceeds. Live dependency probes must fail clearly rather than pass as skipped
when the required engine/runtime is absent. No product dependency is installed as
part of this planning task.

### V2 — Contracts and durable storage (P2)

```sh
vp test run packages/contracts/src/projectWork.test.ts packages/contracts/src/projectTeams.test.ts packages/contracts/src/projectIssueIntake.test.ts packages/contracts/src/projectMemory.test.ts packages/contracts/src/providerInstance.test.ts
vp test run apps/server/src/projectWork/ProjectTeamsPersistence.test.ts apps/server/src/projectWork/ProjectWorkRepository.test.ts apps/server/src/projectWork/ProjectWorkProjection.test.ts apps/server/src/projectWork/ProjectWorkStream.test.ts apps/server/src/persistence/Migrations.forkSequence.test.ts
vp run --filter @t3tools/contracts typecheck
```

`ProjectTeamsPersistence.test.ts` (new, P2) applies new migrations and tests old
records, uniqueness, transactional reservations/outbox, receipts, replay, and
checkpoint-version invalidation. AC-2–AC-5 and AC-7–AC-16 storage guarantees.

### V3 — Session authority (P3)

```sh
vp test run apps/server/src/projectWork/ProjectTeamAuthorization.test.ts apps/server/src/projectWork/ProjectWorkGateway.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/mcp/toolkits/projectWork/handlers.test.ts apps/server/src/auth/RpcAuthorization.test.ts
```

`ProjectTeamAuthorization.test.ts` is new in P3. Test role restrictions through
real handlers, including terminal/PR tools, not only capability flags. AC-4–AC-5,
AC-7–AC-10, AC-12–AC-13.

### V4 — Lifecycle and gates (P4)

```sh
vp test run apps/server/src/projectWork/ProjectTeamPolicy.test.ts apps/server/src/projectWork/ProjectWorkDecider.test.ts apps/server/src/projectWork/ProjectWorkLeaseReactor.test.ts apps/server/src/projectWork/ProjectWorkRuntime.test.ts
```

`ProjectTeamPolicy.test.ts` is new in P4. Prove pre-spec investigation without
implementation permission, stale spec/plan/merge gates, non-code completion,
bounded repairs, and lease/reassignment races. AC-2–AC-4, AC-8, AC-12–AC-15.

### V5 — Intake (P5)

```sh
vp test run apps/server/src/projectWork/github/GitHubIssueSync.test.ts apps/server/src/projectWork/ProjectIssueIntake.test.ts apps/server/src/pullRequest/IssueSearch.test.ts apps/server/src/sourceControl/GitHubCli.test.ts
```

The two new files exercise more than one page, repeated/out-of-order updates,
auth failure/recovery, repository rename/shared bindings, PR filtering, and zero
provider dispatch on import. AC-1–AC-3, AC-16.

### V6 — Initial human workflow (P6)

```sh
vp test run packages/client-runtime/src/project-work/index.test.ts apps/web/src/components/work/IssueIntake.interaction.test.tsx apps/web/src/components/work/GuidedTaskDetail.interaction.test.tsx apps/web/src/components/work/WorkPage.interaction.test.tsx
```

The two new interaction files exercise observable intake/refinement/gate behavior
and stale edits, not static markup. AC-1–AC-4, AC-8.

### V7 — Pi driver and process (P7)

```sh
vp test run apps/server/src/provider/Drivers/PiDriver.test.ts apps/server/src/provider/Layers/PiAdapter.test.ts apps/server/src/provider/pi/PiWorkerProtocol.test.ts apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts
```

New pi tests cover the actual child-process protocol, correct cwd, settled/cancel
events, resource restrictions, auth failures, identity, and restore. AC-5–AC-6,
AC-12–AC-13. Add targeted existing skill tests for any modified shared dispatcher.

### V8 — Dispatch and recovery (P8)

```sh
vp test run apps/server/src/projectWork/ProjectTeamScheduler.test.ts apps/server/src/projectWork/ProjectTeamDispatch.test.ts apps/server/src/projectWork/ProjectTeamRecovery.test.ts apps/server/src/projectWork/ProjectTeamLimits.test.ts apps/server/src/git/GitWorkflowService.test.ts apps/server/src/project/WorktreeSetupTracker.test.ts apps/server/src/project/ProjectSetupScriptRunner.test.ts
```

The four team files are new. Test crash boundaries with real disposable Git
worktrees and processes; wait on receipts/exits. Include restart during setup,
surviving setup descendants, uncertain setup completion without automatic rerun,
and setup access attempts against protected resources. AC-4–AC-6, AC-12–AC-14.

### V9 — Messages and questions (P9)

```sh
vp test run apps/server/src/projectWork/ProjectTeamMailbox.test.ts apps/server/src/projectWork/ProjectTeamWakeReactor.test.ts apps/server/src/projectWork/ProjectWorkAttentionReactor.test.ts
```

The first two are new. Exercise ambiguous delivery, replacement recipients,
duplicate two-device answers, canceled senders, wake coalescing, and bounded reply
loops. AC-5, AC-7–AC-8, AC-12–AC-14.

### V10 — Memory and context (P10)

```sh
vp test run apps/server/src/projectWork/memory/MemoryBackendContract.test.ts apps/server/src/projectWork/memory/ProjectMemoryService.test.ts apps/server/src/projectWork/memory/ProjectMemoryIndexReactor.test.ts apps/server/src/projectWork/ProjectTeamContext.test.ts apps/server/src/projectWork/ProjectWorkBriefing.test.ts apps/server/src/projectWork/ProjectWorkSearch.test.ts apps/server/src/projectWork/ProjectWorkContentGuard.test.ts
```

New service/index/context files test project leakage, stale revisions, deletion
races/rebuild, explicit sharing revocation, conflict provenance, quotas, fallback,
and required context after compaction. AC-9–AC-12.

### V11 — Evidence and delivery (P11)

```sh
vp test run apps/server/src/projectWork/ProjectWorkEvidencePolicy.test.ts apps/server/src/projectWork/ProjectTeamReview.test.ts apps/server/src/projectWork/github/ProjectWorkGitHubOutbox.test.ts apps/server/src/projectWork/ProjectWorkPullRequests.test.ts apps/server/src/pullRequest/PullRequestService.test.ts apps/server/src/pullRequest/GitHubPullRequestProvider.test.ts apps/server/src/pullRequest/GitHubPullRequestCli.test.ts apps/server/src/orchestration/ThreadPullRequestReactor.test.ts apps/server/src/git/linkCreatedPullRequest.test.ts
```

The first four are new. Test independent reviewer inputs, dirty-tree evidence,
base/head movement, integration failure, duplicate/uncertain publication, external
edits/merges, and merge approval through every managed action path. Explicitly
reject `enable-auto-merge`, a merge returning queued/deferred status, and a changed
head after authorization; prove the ordinary-head precondition survives RPC,
service, provider, and GitHub transport. AC-3–AC-4,
AC-14–AC-16, and the deterministic part of AC-18.

### V12 — Full web supervision (P12)

```sh
vp test run packages/client-runtime/src/project-work/index.test.ts apps/web/src/features/projectTeams/Portfolio.interaction.test.tsx apps/web/src/features/projectTeams/Inbox.interaction.test.tsx apps/web/src/features/projectTeams/Team.interaction.test.tsx apps/web/src/features/projectTeams/Memory.interaction.test.tsx apps/web/src/components/work/WorkPage.interaction.test.tsx apps/web/src/components/pullRequest/PullRequestDetailPanel.work.test.tsx apps/web/src/components/CommandPalette.logic.test.ts
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/web typecheck
```

New projectTeams/PR work interaction tests cover two projects, meaningful status,
valid/rejected board actions, same inbox from different entry points, evidence
staleness, and disconnected behavior. AC-1–AC-5, AC-7–AC-10, AC-13, AC-15–AC-18.

### V13 — Mobile supervision (P13)

```sh
vp test run apps/mobile/src/features/project-work/projectWorkNavigation.test.ts apps/mobile/src/features/project-work/projectWorkActions.test.ts apps/mobile/src/features/project-work/projectWorkSupervision.test.ts packages/client-runtime/src/project-work/index.test.ts apps/mobile/src/features/agent-awareness/notificationNavigation.test.ts
vp run --filter @t3tools/mobile typecheck
```

New project-work tests cover deep links and user-visible actions through shared
state/handlers, with server conflict outcomes and connection changes. Native
interactive validation remains a separate real-device/simulator pass. AC-8,
AC-13, AC-17, AC-19.

### V14 — Integrated completion gate (P14)

```sh
vp test run apps/server/src/projectWork/ProjectTeams.integration.test.ts apps/server/src/projectWork/ProjectTeamsCompatibility.test.ts
vp test bench apps/server/src/projectWork/ProjectWorkPerformance.bench.ts apps/server/src/projectWork/ProjectTeamsPerformance.bench.ts --run
vp run --filter t3 typecheck
vp run --filter @t3tools/desktop typecheck
git diff --check
```

P14 adds **new** `apps/server/scripts/verify-project-teams.ts`; its exact invocation
is `node apps/server/scripts/verify-project-teams.ts`. It requires an explicitly
configured disposable T3 home, two fixture repositories, the pinned pi runtime,
chosen memory endpoint, and an authorized GitHub fixture repository; absent
prerequisites are an error, not a passing skip. It must refuse the developer's
live T3 home and must not consume an end-user pairing link. The runner prints the
fixture revisions, runtime/backend versions, real PR URLs, and evidence locations.
GitHub writes in that future pass require the user's explicit fixture authorization.
Browser/device validation requires permission under AGENTS.md and uses test-t3-app
or test-t3-mobile; obtain it only after integration is ready. AC-18/AC-19 stay
unchecked if that evidence is unavailable.

Run scoped lint/format on files actually changed in each step; use explicit file
arguments from that diff, not repository-wide checks. Register future PRs with the
T3 thread when created. No PR creation is authorized by this planning request.

## Compatibility, deployment, and rollback

- Feature-gate team execution separately from existing `projectWorkEnabled`.
  Intake/read views can ship first; missing pi/memory configuration reports an
  actionable unavailable/degraded state. Do not accidentally enable teams merely
  by upgrading or importing issues.
- Capability-negotiate new team reads/actions. Preserve additive read variants,
  bounded cursors, old project-work records, and existing providers. Legacy callers
  cannot mutate managed-task gates through an older general command.
- Disable execution by pausing dispatch, draining/stopping owned workers, revoking
  active team credentials, and retaining events/evidence. Do not roll back by
  deleting state. Older binaries can be used only if their decoders/migration
  behavior have been demonstrated compatible; otherwise keep the upgraded server
  with teams disabled or restore a coordinated pre-upgrade backup.
- Memory can be disabled independently: use authoritative source records and FTS,
  retain index/deletion work, then rebuild against the same source generations.
  Coordinate T3 database backup with memory namespace metadata; never copy a live
  SQLite file without a consistent snapshot.
- Repository detach, project archive, and project deletion stop new intake/dispatch
  and invalidate pending effects. Preserve or explicitly retire links and knowledge
  under existing project lifecycle rules. A delayed effect cannot recreate a
  deleted project. Do not delete linked GitHub data implicitly.
- Host packaging and runtime compatibility are part of P1/P7/P14. If a required
  isolation or SDK behavior cannot be delivered on a supported host, that host's
  managed execution remains disabled until the limitation is resolved and visible.

## Planning outcome

The specification and implementation plan are saved against the checkout above.
This record describes future work; no product implementation, dependency
installation, live verification, or PR has been performed. The user subsequently
requested saving the parallel execution strategy and committing this Markdown
record at the repository root. All 19 acceptance criteria have implementation
and validation coverage in P1–P14/V1–V14.
Dependency selection and process/isolation behavior have explicit P1 exit gates.

## Astra adversarial review

Reviewer: GPT-6-Astra subagent, independently inspecting the saved record and
repository source. Read-only review followed by one focused review of the
corrections. Final verdict: **READY WITH EXPLICIT GATES. No remaining blocking
plan gaps identified.** This is a plan-readiness verdict, not a claim that the
implementation or its dependencies have passed tests.

Two findings were verified against source and corrected:

1. **Deferred merge could outlive its approval.** Existing
   `apps/server/src/pullRequest/GitHubPullRequestCli.ts:986` supports deferred
   auto-merge, `PullRequestService.ts:3227` acknowledges a merge can merely enqueue,
   and `PullRequestProvider.ts:456` lacks an ordinary-head precondition. P11/V11 now
   explicitly carry the expected head through contracts and provider transport,
   require immediate conditioned merge, reject standing auto-merge/unsupported
   queued delivery, and confirm the merged revision. Queue-required repositories
   remain an explicit delivery gate rather than bypassing protections.
2. **Setup scripts were outside the detailed recovery guarantee.**
   `apps/server/src/project/WorktreeSetupTracker.ts:120` stores live state in memory;
   `ProjectSetupScriptRunner.ts:358` launches through an ordinary terminal. D7/P1,
   P8, and V8 now include setup/install scripts and descendants in restricted
   execution, durable prelaunch identity, completion receipts, reconciliation,
   termination checks, and quarantine. Setup-runner failure tests are explicit.

The focused re-review confirmed both corrections and the clarification that
initial missions remain project-owned. P1's dependency, isolation, and packaging
proofs and P14's real workflow/client evidence remain required exit conditions.

Planning checks: 19 consecutive AC IDs, 14 consecutive P steps, 14 validation
groups, balanced Markdown fences, and no trailing whitespace. Existing test paths
were checked against the checkout; proposed tests are identified as implementation
deliverables. `git diff --check` passed and `git status --short` was empty. The
Markdown record was originally outside the worktree under the repository's
artifact policy. It was subsequently updated with the parallel execution strategy
and copied to the repository root for a documentation-only commit at the user's
explicit request. The prior planning checks and review describe their original
candidate; they do not claim implementation validation.

READY_TO_IMPLEMENT (begin with P1; dependent steps remain gated).

## Implementation progress

Implementation began on 2026-09-29 in branch
`t3code/implement-pi-project-teams`. The worktree was clean at
`91b7c87b4656dbe467a7043bab1e91045311d4da`; it was fast-forwarded to the saved-plan
commit `6cc1a0ffad2f61a707a4b18971e187ea216f6f17`, whose only change is this record.
The complete 969-line specification/plan was read before assignments.

The user's execution instructions select GPT-6.1-Sol high for coordination,
three GPT-6.1-Sol medium implementation workers, fresh GPT-6.1-Sol xhigh reviewers
at each part/wave gate, and separate fresh xhigh final verifier and validator.
Workers do not delegate. Each has a separate branch/worktree and an explicit base.
The coordinator owns shared contracts, migrations, server wiring, dependency
changes, this record, and integrated client verification. No push or PR creation
is authorized. Scoped commits and local integration merges are authorized.

Dependency-ordered waves retain the saved strategy:

1. P1: pi runtime, memory comparison, and isolation/packaging proofs in parallel.
2. P2–P3: one foundation owner, after all P1 exit conditions pass.
3. P7 alongside P4 followed by P5, then combined runtime/lifecycle validation.
4. P8 alongside P6; a bounded selected-memory adapter slice may overlap.
5. P9, then complete P10, then P11, with only independent agreed slices parallel.
6. P12 and bounded P13 presentation work, then P13 completion and P14 integration.

Each part requires coordinator inspection and fresh read-only adversarial review
before merge to its wave branch. Each combined wave requires checks and another
fresh review before landing here. Final verification/audit inspect the same exact
main-worktree commit. Unavailable real-runtime/platform evidence remains unchecked.

Wave 1 assignments all start at
`6cc1a0ffad2f61a707a4b18971e187ea216f6f17`:

| Worker | Branch                  | Exclusive repository scope                                                                                                  |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A      | `pi-teams/p1-runtime`   | `apps/server/src/provider/pi/PiRuntimeContract.test.ts` and its uniquely named deterministic fixtures                       |
| B      | `pi-teams/p1-memory`    | `apps/server/src/projectWork/memory/MemoryBackendContract.test.ts` and its deterministic fixtures                           |
| C      | `pi-teams/p1-isolation` | `apps/server/src/provider/pi/PiIsolationContract.test.ts`, `PiPackagingContract.test.ts`, and their uniquely named fixtures |

Their worktrees and disposable probe directories are below
`/tmp/pi-project-teams-11b7e351/`; integration is on `pi-teams/wave1`.
No production dependency, contract, or managed execution path has been changed.
P1 and all 19 acceptance criteria remain unchecked while proofs run.

### P1 evidence and current blockers

The user subsequently selected CommandCode, prohibited further OpenAI model
calls and all Ollama use, and prohibited memory-intensive work on this machine.
The user later clarified that normal tests and builds may use higher memory
limits; the intent was to prohibit hosting models locally. All model calls remain
remote. Ollama, llama, and other local models remain prohibited. Probes retain
explicit resource limits and captured process ownership. No prerequisite or
acceptance criterion is weakened.

**Runtime.** Pi was upgraded from 0.84.2 to the pinned
`@earendil-works/pi-coding-agent@0.99.1`; the official
`@commandcode/pi-commandcode-provider@0.3.0` extension was installed in the user's
pi configuration. Settings backups are outside the worktree. The existing Cursor
endpoint refused connections. A CommandCode Haiku call failed with HTTP 403
`MODEL_NOT_IN_PLAN`: GOAT supports API calls, but Haiku requires Pro or extra
credits. The saved pi key takes precedence over the different ambient key.

In `/tmp/pi-project-teams-11b7e351/probes-runtime/`:

- `node live-commandcode-free-probe.mjs`: actual SDK plus CommandCode
  `inclusionai/ling-3.1-flash:free` streaming, settlement, persistence, and native
  reopen passed. Its compaction failed at the 128-token output cap; the combined
  result correctly remains blocked.
- `node commandcode-compaction-probe.mjs`: one focused real compaction request
  with a 2048-token cap succeeded and persisted its compaction entry. Its original
  summary-marker assertion was rejected as insufficient.
- `node verify-commandcode-compaction-context.mjs`: no additional model call;
  actual SDK session reopen/context assembly retains four complete synthetic
  assignment/decision/question/limit facts in the recent user message. This is
  native context evidence, not AC-12's authoritative T3 context proof.

Fresh xhigh review independently reproduced the offline context checks. The
original static-JSON tests in runtime commit
`54204be2ee9ce565b6413ecfa04f90e4abecd034` were rejected because they exercised no
SDK or consumer. Coordinator repair commit
`479c5285ee24ba8735d56cd074db84b68bc347a5` withdrew those files without rewriting
history; the reviewer approved the withdrawal. That branch's tree equals its
original base, so there is no runtime implementation to merge.
`commandcode-evidence.md` and `commandcode-sha256.txt` retain commands, current
artifact digests, and the distinction between the live and revised offline
assertions. Earlier OpenAI-route evidence predates the prohibition and does not
qualify the currently selected route.

**Memory.** Worker commit `cfbcfdb80e2b04f89a6e00abc59769c678500e8b` contains only
the assigned evaluation oracle, labeled fixture, and real SQLite FTS comparator.
`vp test run apps/server/src/projectWork/memory/MemoryBackendContract.test.ts`
passed 7/7; scoped lint, format, and `git diff --check` passed. These checks do not
certify a memory backend. The fixture FTS macro recall is 5/7 nonempty query groups.
Fresh xhigh review passed this preparatory three-file commit only; the required
backend exit gate remains blocked, so the branch has not been integrated.

Actual pinned Mem0 2.2.1 and Graphiti 0.30.2 probes are preserved in
`/tmp/pi-project-teams-11b7e351/probes-memory/report.md` and raw result files.
Graphiti completed eight ingestions and eight searches: semantic recall improved,
but conflict-source recall was 0.5, a failed gate. Mem0 completed only its first
extraction in 226.351 seconds and invented an assistant attribution for a user-only
source. Its full corpus and both engines' delayed deletion, restart, repeated
requests, T3 outage fallback, and consistent restore matrix remain unverified.
Neither engine is selected.
The reviewer additionally found that Graphiti labeled an unaccepted observation
a decision, wrongly invalidated unrelated transport/receipt facts, and returned
those facts with empty temporal filters. Repeatedly returning the same sources
also means the semantic recall improvement does not establish selective retrieval.
The source/provenance oracle cannot detect invented wording or incorrect temporal
semantics; scratch deduplication cannot certify duplicate-free native results.

Those earlier probes used disposable Ollama inference/embeddings and Neo4j before
the subsequent prohibitions. Both captured owned container IDs were stopped and
confirmed `Running=false`, PID 0; evidence/stores were preserved. A later
standalone FastEmbed package installation completed before the resource steering,
but no embedding weights were downloaded, loaded, or used. The worker confirms no
provisioning, download, local model, inference, or embedding process remains.
CommandCode memory setup made zero completion requests. CommandCode's documented
API has no embedding endpoint. The user then identified pi's OpenRouter support;
its saved API key was present, and an authenticated remote catalog listed
`nvidia/nemotron-3-embed-1b:free` with zero pricing.
`node openrouter-embedding-smoke.mjs` received HTTP 200 but rejected the returned
internal model identity. One focused repair accepted only the exact observed
NVIDIA alias; `node openrouter-embedding-smoke-repair1.mjs` passed with three finite
2048-dimensional vectors, 30 input tokens, and reported cost 0. Provider fallback
was disabled. Scripts/results/raw synthetic response are retained in the memory
probe directory; no local model was downloaded or loaded for these calls. This
proves the existing remote embedding route, not either backend or recall/recovery.
Fresh xhigh review verified all five artifact hashes, all three finite vectors,
returned indexes, token/cost evidence, and the two total remote requests. It
confirmed the route-only claim with no new blocking finding.
The existing file-backed Qdrant and SQLite components permit a small remote-only
Mem0 candidate without a local model service. Its resource use and full lifecycle
matrix still need proof. Graphiti has no configured remote graph database here.

**Isolation and packaging.** Linux x64 bubblewrap 0.12.0 fixtures passed seven
actual isolation/process/layout checks, including npm setup descendants,
captured-process cancellation, and parent death. Minimal SDK initialization and
native reopen passed in extracted npm, actual Electron 44.1.0 ASAR, and Node
26.8.1 SEA layouts. These used empty tools/resources; they do not establish full
T3 packaging or enabled lazy-resource closure. The SDK still needs explicit
trusted metadata, WASM/image/codemode worker resources, and platform variants.

Fresh xhigh review rejected the original parent Git broker's authority claim:
worker-writable Git metadata and ambient host Git configuration were unsafe.
It also found that readline framed data before checking size. Separate retained
repair evidence at `probes-isolation/repair1/report.md` fixes trusted metadata,
read-only Git pointer, constructed Git environment, and incremental byte limits
within a newly initialized, known-clean Git-status fixture. The reviewer verified
all 11 hashes, unchanged configuration provenance, three successful broker
invocations, and 11 framing categories/15 assertions. Model responses were
explicitly simulated. Those original findings are resolved only within this
fixture; production authorization, imported/included configuration, TOCTOU,
privileged Git writes, leases/revocation/recovery, and real model/auth brokerage
remain unproved. Four source revisions exceeded the skill's two automatic repair
allowance; no further automatic repairs or reruns proceeded. Memory peak was not
measured, and no builds ran after the resource constraint arrived. All captured
worker processes exited. The isolation branch remains clean with no commits.

Linux requires installed bubblewrap and kernel/container namespace permissions;
this deployment prerequisite is not established by existing T3 packaging.
macOS/Windows isolation remains unproved. A supported-host deployment decision
and full resource/runtime evidence remain required before dependent work.

**Integration state.** P1's exit gate has not passed. No worker implementation
has been merged into `pi-teams/wave1` or this main worktree; production dependencies,
contracts, migrations, wiring, and clients remain unchanged. P2–P14 and all 19
acceptance criteria remain unchecked. No combined-wave approval, integrated
client/browser/device gate, final acceptance verifier, or final independent audit
has been claimed. Those final agents must inspect the same exact completed
implementation commit after all required waves land.

An attempted pinned dev-dependency addition failed the existing pnpm virtual-store
and unused-patch guards without changing tracked files; unrelated patches were
preserved. Worker restart/spawn attempts also encountered an agent-thread limit;
the coordinator performed the narrow runtime withdrawal repair, and fresh review
capacity became available after workers finished. No repository-wide checks,
browser/device use, live T3 writes, pushes, or PR creation occurred.

### Resumed P1 work

After the user reiterated implementation, the complete current record was read
again. Three medium workers resumed in the existing isolated branches from:
memory at `cfbcfdb80e2b04f89a6e00abc59769c678500e8b`, runtime at
`479c5285ee24ba8735d56cd074db84b68bc347a5`, and isolation at
`6cc1a0ffad2f61a707a4b18971e187ea216f6f17`. The current main base is
`e346e4055af964c72bfff98f225180204ed33761`; its advances are record-only.
Their exclusive scopes remain those assigned above. Existing evidence is retained;
new probes use new artifact names. Workers neither delegate nor merge.

The memory worker evaluated a native dense-only Mem0 candidate with hosted
CommandCode completions and OpenRouter NVIDIA embeddings, explicit request budgets,
and a hard subprocess resource limit before imports. The runtime worker proved
actual session tool dispatch and role restrictions. The isolation worker checked
enabled text-tool resources in the existing package layouts without a full rebuild.
Images and codemode may be explicitly unavailable in the initial managed profile;
this does not permit advertising those capabilities as supported. These are ongoing
proofs, not completed P1 gates. Unsupported-host execution remains disabled under
the saved deployment policy. P2–P14 remain gated.

The first resumed proof reviews found actionable gaps. Current repair evidence:

- Runtime commit `467cd7c41e1e1be21b100169e043ed9e980e4c87` adds four actual SDK
  consumer/test files. Six cases passed with 13 synthetic callbacks and no new
  remote call; a private service recorded a 113,135,616-byte kernel memory peak.
  Fresh review requires cancellation to fail on watchdog expiry and cleanup to
  retain process identity rather than kill a reused numeric PID. The repair's
  negative controls now reject omitted abort/shutdown and confirm pidfd cleanup.
  Repair commit `0a7d611cb7c06dd6415cbef6ff2d20b25e1220b7` removes child self-expiry
  and numeric-PID cleanup. Actual pnpm-installed SDK checks pass 3/3; both omitted
  cleanup negative controls fail with watchdog receipts and bound-identity cleanup.
  The focused check's kernel peak is 285,429,760 bytes under a 512 MiB cap. The
  owned-service causal proof peaks at 122,200,064 bytes with zero OOM events.
  All six pi packages resolve to 0.99.1. Fresh review accepts those causal fixes
  but finds a remaining startup-cleanup gap: ownership is armed after dispatch,
  and cleanup clears its watchdog before awaiting potentially hanging SDK shutdown.
  The coordinator verified the control flow. A focused second repair must acquire
  process ownership before startup and prove bounded startup-failure cleanup.
- Memory commit `6cc8c7a80e5ffdaf2fd826fa962217099cf428c6` passed fresh review as
  a preparatory source-briefing consumer change, with 9/9 tests. The remote corpus
  completed all eight sources/searches: qualified source recall 1.0 versus FTS
  5/7, 10 LLM attempts, 34 embedding requests, and approximately 131 MiB peak RSS.
  Raw superseded hits, invented wording, and duplicate native writes remain
  visible. Review rejected reconciliation that acknowledges any matching record
  as complete. The focused repair has crashed real multi-observation extraction
  between native writes and recovered only the missing original UUID. Repair
  commit `66e8f1c2539de8e74bea46e355190596631a1a89` passes 11/11 focused tests.
  Actual two-observation ingestion crashes after one native point, reopens pending
  at 1/2, and restores the missing original UUID without another model call. A
  separate actual embedding transport timeout leaves 0/2 pending; recovery reuses
  the durable extraction and verifies both native records before completion.
  Receipt replay performs no new request or write. Aggregate counters are 12 LLM
  attempts and 40 embedding attempts; peak RSS is 132.719 MiB under pre-import
  resource bounds. Native Mem0 history rows skipped by the crash remain empty;
  source/extraction records and complete-set manifests persist. This is derived
  index recovery evidence, not a claim to recover every SDK internal transaction.
  Fresh xhigh selection/recovery review approves this slice and independently
  verifies both original UUID sets, payloads, and vectors, all 74 artifact hashes,
  and unchanged prior budget counters. Mem0 2.2.1 is selected as a derived dense-only
  index behind T3's authoritative source/extraction ledger. Its configuration uses
  CommandCode Ling free extraction and remote OpenRouter NVIDIA 2048-dimensional
  embeddings with provider fallback disabled. Production must preserve complete
  expected-set manifests, exhaustive reconciliation beyond this prototype's
  100-point listing, source/tombstone fencing, explicit valid no-facts outcomes,
  and T3-owned audit/context. It must not present native history as complete.
  Historical Graphiti fails conflict preservation on the same fixtures, but
  different models prevent a matched provider-cost conclusion. NVIDIA reports
  zero cost; CommandCode dollar cost is unreported. No P10 integration or AC
  completion is claimed.
- New text-tool and parent-auth fixtures passed their actual native consumers.
  Fresh review then found implicit append-prompt/file discovery and character
  counts used as byte limits. One focused text repair excludes those discovery
  paths, constructs the read tool before the session, and checks bytes before
  accumulation. Both copied-runtime and actual ASAR consumers passed. Fresh xhigh
  re-review approves Linux text-profile isolation/auth feasibility and confirms
  the discovery, Git authority, framing, and stderr findings resolved in their
  stated scopes. The auth stderr correction is source-only offline
  evidence; it does not retroactively certify the earlier live broker source.
  Fresh packaging review approves enabled native write/edit/read/bash consumers
  in actual npm-packed/extracted, Electron 44.1.0 ASAR, and minified SEA layouts.
  All 108 artifact hashes match; package resources match byte for byte across
  layouts. The standalone executable embeds its JS and runs without SDK source
  or node_modules mounts. Its build peaks at 1,239,146,496 bytes under the user's
  authorized 2 GiB cap, with all captured processes exited. The prior unminified
  1 GiB OOM remains recorded. Node 26.8.1 differs from the repository's SEA pin
  26.8.2; exact full-application packaging remains a P7/P14 obligation. The read
  guard validates one buffer after reading, so it is not a hard 64 KiB allocation
  bound. Linux bubblewrap prerequisites and disabled execution on unproved hosts
  remain explicit. This approval covers the bounded packaging proof, not all P1.

Coordinator-owned dependency commit `81ee24e3d` is isolated on
`pi-teams/p1-dependencies`, based on
`e346e4055af964c72bfff98f225180204ed33761`. It adds the exact SDK test dependency,
116 new package/snapshot pairs, and eight exact release-age exceptions. Existing
importers, packages, snapshots, overrides, and patches are preserved. The frozen
lockfile/supply-chain check passed all 2,297 entries with a 512 MiB cap; the earlier
256 MiB failure remains recorded. A standalone install of the exact pinned
dependency graph passed under a 1 GiB cap with scripts disabled. Scoped format
and whitespace checks passed. Fresh xhigh dependency review approves the pin,
closed graph, integrity hashes, preserved prior entries, and frozen checks; this
commit is now integrated only into the wave branch described below.

The coordinator advanced `pi-teams/wave1` to the main record commit
`7e7d7101e` without rewriting history, then merged only approved parts:
dependency merge `62a9d6f2a` and memory merge `f3cb1bc98`. Their scopes do not overlap;
main advances since their bases are record-only. Whitespace checks and clean
worktree checks pass. The runtime part is still excluded pending startup-cleanup
repair/review. Combined V1 and fresh wave review remain pending; the wave has not
landed on this main worktree.

The NVIDIA publisher's fixed model card revision
`c0c9fea93ea424587517f2c59e20db9f1d6bf615` identifies OpenMDW 1.1. Only metadata
and Markdown were fetched; no weights were downloaded. Evidence and SHA-256
values are in the coordinator's external cache. The exact OpenRouter serving
variant remains unpinned. See the
[publisher model card](https://huggingface.co/nvidia/Nemotron-3-Embed-1B-BF16/blob/c0c9fea93ea424587517f2c59e20db9f1d6bf615/README.md)
and [OpenRouter terms](https://openrouter.ai/terms), dated 2026-08-31.

All part repairs, combined P1 validation, and the fresh wave review must pass
before P1 is checked or P2 starts. No pushes, PRs, browsers, devices, or live T3
database writes have occurred.
