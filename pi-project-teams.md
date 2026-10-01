Github Tracked: false
Status: in_progress
Github Issue: none
Plan review: READY_WITH_EXPLICIT_GATES

# Pi project teams

## Progress dashboard

Last updated: 2026-10-01 08:24 UTC. Implementation is running. **P1–P4 are finished on main. P5 durable integration and P7 runtime integration are next.** Ten subagent seats plus the coordinator are available. Reviewed preparatory slices do not complete their parent phases.

| Tally                       | Done | Active | Left | Total |
| --------------------------- | ---- | ------ | ---- | ----- |
| Implementation steps        | 4    | 7      | 3    | 14    |
| Product acceptance criteria | 0    | 0      | 19   | 19    |
| Final independent audits    | 0    | 0      | 2    | 2     |

- **Finished on main:** P1 dependency proofs; P2 durable foundation; P3 current managed identity/authorization; P4 guided lifecycle, approvals, investigation, bounded repairs and evidence metadata. Latest product merge: `30ca5e52883619da4d338666dcbe64bca39d09f0`.
- **P4 evidence:** combined 656/656 tests across 25 files, zero skips; normal strict/Effect compiler across 42 roots; exact-path lint/format/Knip. Sole fresh wave reviewer APPROVES `25f7bd6ae` after 16 independent causal groups. Root verifies all 155 review artifacts and all 50 reviewed product files on main. Producer/review audits confirm 172 units, 460 captured PIDs and 168 cgroups drained. Plan-only main advances were preserved.
- **P5:** the atomic seam `8e6a8c69c` passed its original review, but the new caller's review exposes an additional two-SQL-client composition defect. Shared state `7d912a096` receives REQUEST_CHANGES: valid cross-key JSON can redirect repository/account authority, binding can revive an authentication-failed epoch, and a retained repository can let prepared writes escape receipt rollback. Root verifies all 47 review artifacts and independently reproduces all three with actual SQLite; 15 candidate cases and nine other independent safety groups pass. Central repair `c4cbe0a1d` passes 74/74 affected cases and normal strict compilation; its same reviewer is rechecking. State repair `e82464038` passes 19/19 cases and normal strict compilation, with one fixture-only lint warning/zero errors; its same reviewer is rechecking. Migration/lifecycle work waits for these corrected interfaces. Legacy import, exact cache/intake, human refinement/rebind, scheduling, wiring and real GitHub gates remain open.
- **P7:** held SDK-parent, observer, event mapper, private port/extension and driver remain approved. Native reader `25373590b` is approved (48 tests plus 22 independent groups); root verifies all 40 review artifacts. Adapter repair `3b8b71202` receives APPROVE after 68 fresh cases, including actual shared SQL ingestion and actual-broker synthetic transport; root verifies all 43 repair-review artifacts. Usage emission is proved; durable usage/client display remains open. Host `2051a2797` receives APPROVE after 184 tests and 32 independent probes, resolving HOST-R1–R6; root verifies 44 producer and 23 review artifacts. The 39 unrelated Linux-process skips remain explicit. Native configuration review finds two real file substitution races; root verifies all 48 review artifacts and independently replays both. Repair `54ea6f5d4` passes 23 filesystem cases, normal strict compilation and actual Effect diagnostics; root inspects the full diff and verifies all 92 artifacts before its same reviewer rechecks. The same reviewer now APPROVES `54ea6f5d4` after 23 candidate tests and 10 independent groups; root verifies all 44 repair-review artifacts. All 16 captured units and 35 PIDs drained. Linux-only availability is explicit. A Sol-high worker now owns only three new stdio bridge/real-child fixture files on approved host base `2051a2797`. Production SQL/accounting, entry/registration and package/platform gates remain open.
- **P6/P8:** human-workflow and dispatch/recovery interfaces prepared. An independent P6 draft/submission helper starts on `f0412ccfd` in its own worktree; it uses settled P4 intents and does not complete P6 or depend on unfinished P5 APIs. Full dependent implementation awaits P5/P7 gates.
- **P9:** mailbox policy `e44766aac` receives APPROVE after 80 producer cases, 12 independent groups/240 assertions and three broken controls. Root verifies all 136 producer and 67 review artifacts. Durable target persistence, consumption, delivery/wake and full P9 remain dependent on P8.
- **P10:** native Mem0 adapter `2a88e791` remains approved. Hit policy `22374d1c4` receives APPROVE after 71 cases, 18 independent groups, 240 seeded snapshots and eight broken controls; root verifies all 103 review artifacts. Extraction, current SQL hydration, deletion, fallback and context integration remain open.
- **P11:** evidence policy `090589f4` approved; full delivery integration remains dependent work.
- **Not started:** P12, P13 and P14. All 19 product criteria and both final audits remain open.

Prioritize Pi, OpenCode, Claude and Codex. Shared contracts, migrations, wiring and dependencies retain one owner. Repair limits are waived. No local models, Ollama/llama inference, OpenAI runtime/proof calls, push or PR creation. P1's eight-call proof budget remains closed. Required browser/device permission and disposable GitHub fixture-write permission are outstanding.

### Live agent slots

Each row is one subagent seat. Finished agents release their seat. Worktrees and evidence live under `/home/user/.cache/pi-project-teams-11b7e351/`.

| Slot | Agent                                      | State                             | Assignment / exact base             | Next gate                                                        |
| ---- | ------------------------------------------ | --------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| 1    | — (last: `review_p9_mailbox_policy`)       | Available; mailbox APPROVE        | Exact `e44766aac`                   | Root verifies 67 artifacts; durable integration awaits P8        |
| 2    | `p4_guided_core_high`                      | Active P6 draft helper            | Base `f0412ccfd`                    | Two exclusive new web files; focused transitions and checks      |
| 3    | — (last: `review_p10_memory_hit_policy`)   | Available; memory policy APPROVE  | Exact `22374d1c4`                   | Root verifies 103 artifacts; full P10 awaits P8–P9               |
| 4    | — (last: `review_p7_native_configuration`) | Available; configuration APPROVE  | Exact `54ea6f5d4`, base `70b37856b` | Root verifies 44 artifacts; production integration remains open  |
| 5    | `p7_driver_adapter_interfaces`             | Active stdio bridge               | Base `2051a2797`                    | Three exclusive new files; actual captured Node pipe tests       |
| 6    | `review_p5_atomic_work`                    | Active same-reviewer repair check | Exact `c4cbe0a1d`, base `8e6a8c69c` | Actual SQL A/B, same/absent context, rollback and authorization  |
| 7    | — (last: `review_p7_driver`)               | Available; driver APPROVE         | Exact `4d642070d`                   | Root verifies 79 review artifacts; held                          |
| 8    | — (last: `review_p7_adapter`)              | Available; adapter APPROVE        | Exact `3b8b71202`                   | Root verifies 43 review artifacts; durable usage remains open    |
| 9    | — (last: `review_p7_worker_host`)          | Available; host APPROVE           | Exact `2051a2797`                   | Root verifies 23 review artifacts; production stdio gate remains |
| 10   | `review_p5_repository_state`               | Active same-reviewer repair check | Exact `e82464038`, base `11791c0a2` | Three authority fixes, positive recovery and atomic caller tests |

Coordinator: owns P5 migration/lifecycle/authority interfaces and P7 production wiring. Reviewed candidates remain frozen in their own worktrees. Seats remain available where shared interfaces or required prerequisites are unfinished; adding workers to those files would conflict with their sole owner. Held slices require combined validation and the sole fresh wave review before main integration. Only the coordinator performs integrated client verification after permission.

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

| Area           | Decision                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Execution      | Pi runs the initial custom team. Roles and workflow are independent of the runtime.                                                                                                        |
| Provider focus | Prioritize Pi, OpenCode, Claude and Codex. Other providers receive shared-boundary compatibility checks; avoid substantial provider-specific work unless required for a shared regression. |
| Environment    | One T3 environment serves multiple projects, accessible remotely.                                                                                                                          |
| Coordination   | One coordinator per project; the user sets cross-project priorities.                                                                                                                       |
| Autonomy       | Guided: human approval of specification, plan, and merge.                                                                                                                                  |
| Communication  | Workers communicate directly through durable, task-linked messages.                                                                                                                        |
| Intake         | Issues from connected GitHub repositories automatically appear in T3.                                                                                                                      |
| Starting work  | The user explicitly starts investigation or execution. Capture and synchronization never dispatch agents.                                                                                  |
| Internal work  | Research subtasks, conversations, attempts, and working notes stay in T3.                                                                                                                  |
| Memory         | Agents automatically capture sourced observations; accepted decisions remain protected.                                                                                                    |
| Deployment     | An established self-hosted memory engine may run alongside T3.                                                                                                                             |
| Authority      | T3 owns workflow state, decisions, and approvals. GitHub owns its issues, PRs, reviews, and checks.                                                                                        |

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
obligations are recorded under Implementation progress. The P1 exit gate has passed; production memory integration remains P10 work.

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
owner at a time. GPT-6.1-Sol xhigh reviews implementation candidates read-only.

### Parallel-agent execution strategy

Implementation staffing is unlimited at the plan level: use one GPT-6.1-Sol high
lead/integrator and as many GPT-6.1-Sol high implementation subagents as can work
independently without disrupting another agent's work or creating unnecessary
conflicts. Optimize for finishing the plan quickly and correctly. The user owns
priorities and product decisions;
the lead owns assignments, dependencies, and integration. Assign one worker per
exclusive writable scope. Split work only when interfaces and dependencies are
settled and the split avoids conflicting edits or unnecessary integration work.
Leave slots idle when dependencies or shared ownership prevent useful parallelism.

Prioritize implementation and meaningful compatibility coverage for Pi, OpenCode, Claude and Codex. Preserve ordinary shared behavior for other providers, but do not spend substantial effort on their provider-specific support unless this plan causes a concrete shared regression. The custom team remains Pi-only initially.

There is no fixed worker count or cumulative limit on implementation subagents.
Use all available slots for ready, independent scopes and dispatch more work as
slots become available. Respect the harness's actual active-agent limit, including
the lead and reviewers; unlimited staffing does not override that limit. Free an
implementation slot before starting a reviewer when needed. The user authorizes
raising the Codex harness configuration to 10 subagents; the resumed session
confirms eleven active agents including the coordinator. Maintain the live slot table
above as assignments change. Do not change the product's runtime concurrency policy. The stage assignments below
identify dependency groups, not fixed seats; split each group into additional
independent slices only after agreeing explicit scopes, interfaces, and checks.

Safe parallelism may span multiple phases or independent parts of phases; waves
do not require unrelated ready work to wait for every earlier assignment. Start
a complete step only after its listed prerequisites pass. A bounded preparatory
slice may overlap other phases when its own dependencies and interfaces are
settled; record the slice and its limits before dispatch, and keep its parent
step incomplete until all parent prerequisites, checks, and integration gates
pass. Reassess available independent work whenever a dependency or review gate
clears. Preserve one writable owner for shared boundaries, exclusive scopes,
explicit base commits, and review before integration across every overlap.
This rule is part of the coordinator's standing instructions and must appear in
each worker brief. It applies throughout this implementation, including while
another piece is being reviewed or repaired. Workers do not delegate.

| Stage                                | Concurrent assignments                                                                                                                                                                                        | Exit gate                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1. Dependency proofs, P1             | Parallel scopes prove pi sessions/tools/cancellation, isolation/packaging, and memory engines against agreed fixtures. Further independent proof slices may overlap. The lead settles integration boundaries. | Required runtime and memory behaviors have concrete evidence; unresolved P1 constraints block dependent work. |
| 2. Foundation, P2–P3                 | One owner implements contracts, persistence, and authorization. Other workers may finish isolated probes and prepare fixtures without changing shared contracts.                                              | Stable interfaces and passing persistence/authorization checks.                                               |
| 3. Runtime and lifecycle             | P7 pi integration runs alongside P4 guided lifecycle, then P5 GitHub intake. Each may use additional independent slices against settled interfaces. The lead owns shared wiring.                              | Runtime and lifecycle slices integrated and tested against the foundation.                                    |
| 4. Supervised execution              | P8 scheduler/recovery runs alongside P6 initial human workflow and a bounded selected P10 memory backend adapter. Split independent scopes further only against agreed interfaces.                            | Durable dispatch/recovery and usable human approval controls.                                                 |
| 5. Coordination and delivery         | Complete P9 mailboxes, then P10 context/memory integration, then P11 review/PR delivery. Independent adapter work may overlap where contracts and writable scopes are settled.                                | A guided task reaches a reviewable PR with recorded evidence.                                                 |
| 6. Client supervision and validation | After backend and shared client APIs are stable, P12 web and P13 mobile presentation work may overlap. The lead performs final integration and P14 checks.                                                    | Integrated client behavior, failure recovery, and required real-workflow evidence.                            |

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
- Review agent: GPT-6.1-Sol xhigh, read-only adversarial review, with findings tied
  to acceptance criteria and reproducible failure cases. Assign at most one
  review agent to each task or piece of work, including each combined wave.

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
Parallel work: <other phase/slice assignments and shared-interface owners>
Completion boundary: <slice acceptance; unfinished parent prerequisites/gates>
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

For each task or piece of work, assign one independent GPT-6.1-Sol xhigh reviewer
in a fresh session without the implementer's conversation history. Reuse that
same review agent for findings and repair rechecks; do not spawn additional
review agents for that work. The lead inspects the diff and evidence, verifies
findings, and ensures affected checks and review pass before wave integration.
Each combined wave is a separate piece of work with one review agent and checks
before main integration. Review duplicate dispatch, stale approvals, surviving
workers/setup processes, recovery, uncertain external effects, memory isolation
and deletion, duplicate messages, stale evidence, PR head changes, and client
compatibility. Separate branches passing independently do not establish that
their boundaries agree. Repair-count limits remain waived for this plan.

After all waves land, assign exactly two fresh GPT-6.1-Sol xhigh final reviewers:
one verifier checks all 19 acceptance criteria and required evidence; one
validator audits the complete implementation against the specification. Both
inspect the same exact main commit, work read-only, and do not delegate. Fix
verified findings through the scoped branch, review, and integration process,
then have these same final reviewers recheck the resulting exact commit.

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

- [x] **P1 — Prove dependency boundaries and select one memory engine.**
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

- [x] **P2 — Extend contracts and persistence additively.**
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

- [x] **P3 — Bind team authority to authenticated sessions.**
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

- [x] **P4 — Implement guided lifecycle and real investigation before approval.**
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
node apps/server/src/provider/pi/fixtures/p1-runtime-linux-proof.mjs
```

The deterministic cases cover protocol validation; P1 also records exact
version-pinned disposable probe commands and results in this record before P7 or
P10 proceeds. Live dependency probes must fail clearly rather than pass as skipped
when the required engine/runtime is absent. No product dependency is installed as
part of this planning task.
Ordinary test discovery runs portable actual-SDK consumers. The separately invoked
Linux runner is a required P1 ownership proof, requiring the pinned SDK, a functional
systemd user manager, cgroup v2, and Python pidfd support. Missing prerequisites are
hard failures. This separation preserves the process proof without imposing Linux
service management on ordinary server tests.

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

### Preserved pause checkpoint (2026-09-30; subsequently resumed)

This records the pause before P3's independent review and wave integration.
The user subsequently requested resumption; the progress dashboard above is
current. The frozen pause evidence below remains unchanged.

- Main worktree before this documentation checkpoint:
  `f2514af881393f52e1610058af95bfa2ba7f9a32` on
  `t3code/implement-pi-project-teams`. P2/P3 code has not landed here.
- Wave integration: `pi-teams/wave2` at
  `8e44ffe67516decfd19df454382848ea029c8738`, in
  `/home/user/.cache/pi-project-teams-11b7e351/wave2`. Reviewed P2 candidate
  `6d19799a6861090f67960e31da3adc2ae8c461d8` is integrated only there; its fresh
  review approved P2 only. The combined wave gate remains open.
- P3 checkpoint: `pi-teams/p3-authorization`, worktree
  `/home/user/.cache/pi-project-teams-11b7e351/p3-authorization`, exact HEAD/base
  `c3ed6d3d4c606f66b9c07000246f16682df035af`. Its 32 assigned changed paths
  (28 tracked and four new files) are preserved as uncommitted WIP. The index is
  empty. No P3 commit, independent review, or integration has occurred.

P3's final focused checks passed 250 tests: exact V3 66, affected authorization
and MCP proxy 51, host/runtime/export 39, exact V2 contracts 65, and exact V2
storage 29. The normal contracts compiler, scoped lint and format, and
`git diff --check` passed. The normal server-entry compiler failed with three
unresolved issues, producing five diagnostics:

1. `ProjectWorkGateway.test.ts:1587` repeats `gateId` in the reordered retry test
   (`TS2783`).
2. `ProjectWorkRuntime.test.ts:252` hides the required Authorization service in
   the test layer's output (`TS2375` and `TS377004`).
3. `server.ts:605` passes a production layer to `ProjectWorkRuntime.withCore`
   whose parameter fixes its error/context types too narrowly (`TS2379` and
   `TS377034`).

The compiler ran under a verified 4 GiB limit, zero swap, `GOMEMLIMIT=3GiB`, and
a 180-second timeout; peak memory was 3,478,720,512 bytes with zero cgroup OOM
events. Five unchanged `ProjectLifecycle.test.ts` baseline lint errors remain
failed evidence. No repair was started after the requested pause boundary.
Backend tests exercise actual SQL, authorization helpers, toolkits, services,
and stream publication. They do not establish WebSocket transport, browser,
desktop, or mobile compatibility.

Frozen P3 evidence is in
`/home/user/.cache/pi-project-teams-11b7e351/p3-authorization-evidence/`.
`final-commands.json` and `final-results.json` retain exact commands and results;
`checkpoint.json`, `source-hashes.json`, `source-snapshot.tar.gz`, and
`full-diff.binary.patch` preserve the checkpoint. The 95-artifact manifest's
SHA256 is `0b737421d7e1939ff9081b30f0869f41d38e1b8c1392c8454ea47ad015bbb204`;
the full patch's SHA256 is
`eaa2aea7cf82b2145259e177f5f569ce093cca351352a5e78a17577988bdb014`.
The coordinator verified all 95 artifacts, all 32 current source hashes and
archive files, the tracked patch, the empty index, and all 38 captured scopes
drained. This inspection is recorded in
`/home/user/.cache/pi-project-teams-11b7e351/root-pause-verification/p3-checkpoint-inspection.json`.
Failed intermediate checks and deliberate negative controls remain preserved.

On resumption, repair the three compiler issues in the same isolated P3 scope,
run focused regressions and affected gates including the normal compiler, then
make a scoped commit. Inspect it and assign P3's one independent xhigh reviewer
before merging to wave2; reuse that reviewer for any repair rechecks. Run combined
V2/V3 and affected compatibility checks, obtain the wave's one independent review,
reconcile the advanced main worktree, and repeat affected
checks before the local main merge. Start P7 alongside P4 followed by P5 only
after that merge. P2/P3 completion boxes remain unchecked until their combined
main integration gate passes. P4–P14, all 19 acceptance criteria, and both final
independent audits remain open.

Regenerated bounded P1 runtime, isolation/packaging, and memory evidence received
fresh approvals as recorded below; these do not certify later runtime or
platform gates. The eight-call live P1 ledger is exhausted and must not be reused.
Repair limits remain waived when work resumes. No local model work, additional
model calls, dev servers, browser/device use, live T3 state writes, push, or PR
creation was performed for this pause. Browser/device permission remains
outstanding for eventual integrated client verification. This checkpoint commits
only this record; the P3 WIP and wave branches remain preserved without further
integration during the pause.

Implementation began on 2026-09-29 in branch
`t3code/implement-pi-project-teams`. The worktree was clean at
`91b7c87b4656dbe467a7043bab1e91045311d4da`; it was fast-forwarded to the saved-plan
commit `6cc1a0ffad2f61a707a4b18971e187ea216f6f17`, whose only change is this record.
The complete 969-line specification/plan was read before assignments.

The user's updated execution instructions select GPT-6.1-Sol high for coordination
and all implementation workers. Use as many independent workers as available
slots safely support, rather than a fixed three-worker team. Assign at most one
GPT-6.1-Sol xhigh review agent per task or piece of work, reusing it for repairs,
and two fresh xhigh final reviewers after implementation is complete. These rules
supersede the earlier medium-worker and repeated fresh-review assignments recorded
below; historical evidence and verdicts remain unchanged. The user subsequently
requested resumption and a continuously maintained progress dashboard at the top.
Workers do not delegate. Each has a separate branch/worktree and an explicit base.
The coordinator may assign safe independent work across multiple phases or parts
of phases simultaneously. Each brief records its settled dependencies and parent
completion limits; overlapping preparation does not close an unfinished phase.
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

Each part requires coordinator inspection and its one independent read-only
adversarial review before merge to its wave branch. Each combined wave requires
checks and its one independent review before landing here. Repair rechecks use
the same assigned review agent. The two final reviewers inspect the same exact
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
At that initial stage, P1 and all 19 acceptance criteria remained unchecked.

### P1 earlier probes and superseded blockers

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
  Second repair `c5b511efe2579539a8132456b1a3ebf4fe2cf093` changes exactly four
  assigned files. Seven actual SDK tests pass in 15.46 seconds, including six
  original success cases and six failure controls. Each fixture's uniquely owned
  service exists before SDK import; actual cgroup limits and control-group cleanup
  are verified. MCP initialization stall, shell pre-receipt stall, and hanging
  abort/shutdown fail with causal receipts; all seven service cgroups are removed.
  Positive SDK cleanup leaves only the fixture PID before external service drain.
  Per-service peaks are 79,069,184–96,120,832 bytes under a 512 MiB cap. Scoped
  lint, format, whitespace, clean-tree checks, and all 15 manifest hashes pass.
  Native MCP shutdown still leaves an opening child alive; the independently
  owned service terminates it. Production must own the entire worker tree before
  startup. A functional Linux systemd user manager is this proof harness's
  prerequisite, not a new production dependency; CI manager availability is
  unchecked. Fresh xhigh review approves this exact commit, verifies the causal
  controls and source hashes, and finds no blocking runtime-slice finding.
  Combined P1 validation and review are still required.
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
worktree checks pass. The approved runtime part is merged at `8679c7fc7` after
reconciling the main record advance `a0621857e` into the wave. Combined V1 and
fresh wave review remain pending; the wave has not landed on this main worktree.

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

### Combined P1 candidate and portable-test repair

Combined candidate `e208851025244081870c0e0859f426874b2ef7a3` passed the original
18/18 V1 tests. Its fresh xhigh wave reviewer found one integration blocker:
ordinary test discovery unconditionally required Linux systemd user services.
CI does not provision or verify that prerequisite; actual CI manager availability
remains unchecked. The coordinator verified the finding against the source.

One scoped repair was assigned from that exact base to a medium worker on
`pi-teams/p1-portable-contracts`, in
`/home/user/.cache/pi-project-teams-11b7e351/portable-contracts`. Commit
`723f3996bd793c763d109ddccbded7ebd4d9fdf8` changes only the runtime test and SDK
fixture, and adds the explicit Linux proof runner. Four actual SDK semantic cases
run with empty PATH; process controls and ownership fallback are rejected before
startup, and missing SDK remains a hard error. The Linux runner retains six
positive cases and six causal failure controls, including the native opening MCP
child surviving SDK cleanup before the independently owned service drains it.
Portable output is bounded in bytes before retention, and cleanup uses captured
process handles. Fresh xhigh part review approves the exact commit and independently
verifies all 47 artifact hashes and five source hashes.

The approved repair is integrated into wave commit
`bbe8cba1e352a4c6b9cd065fe356d38829218b5f`. Coordinator commands from the wave
worktree, with `PI_RUNTIME_CONTRACT_SDK_ROOT` pointing to the installed pinned SDK
under `/home/user/.cache/pi-project-teams-11b7e351/sdk-lock-proof/node_modules/`:

```sh
vp test run apps/server/src/provider/pi/PiRuntimeContract.test.ts apps/server/src/projectWork/memory/MemoryBackendContract.test.ts
node --max-old-space-size=128 apps/server/src/provider/pi/fixtures/p1-runtime-linux-proof.mjs
```

The combined tests pass 21/21 in 1.458 seconds, with a verified 1 GiB cgroup cap,
128 MiB Node heap cap, 526,860,288-byte kernel peak, and zero OOM events. The Linux
runner passes all seven outcomes in 17.624 seconds; each owned fixture service has
a verified 512 MiB cap, causal exit status, and removed cgroup. Service peaks are
76,918,784–100,294,656 bytes. The runner's separate outer scope peaks at 30,113,792
bytes and does not include those sibling service cgroups. Both checks make zero
model calls. Logs, exact command arrays, resource counters, seven outcome records,
and eleven combined source hashes are retained at
`/home/user/.cache/pi-project-teams-11b7e351/wave1-validation/`, with suffix
`bbe8cba1`. The worker's scoped lint, format, syntax, and whitespace checks pass at the
same source hashes. Its original narrow TypeScript result used a private Vitest
alias and is superseded by the normal compiler proof below. Initial launcher failures and
compiler diagnostics remain separate from passing evidence. The worker's unnecessary
environment dump displayed secret values in tool output; no values were copied
into evidence, and subsequent manager checks use selected properties only.

The fresh combined-wave review is pending. P1 remains unchecked, the wave has not
landed on this main worktree, and P2–P14 remain gated. Previously reviewed live
runtime, memory, isolation, and packaging evidence is unchanged. Linux prerequisites,
unproved-host disablement, buffered auth-broker streaming, exact full-application
packaging, bounded production reads, and complete memory reconciliation remain
explicit P3/P7/P8/P10/P14 obligations. No product acceptance criterion is complete.

### Combined P1 normal compiler repair

Fresh xhigh combined review of `f9363d1641c76a5b64529354b3fd9181a0243359`
found that the runtime test imported undeclared `vitest`. A private alias in the
worker's narrow compiler config masked the normal server error. The coordinator
reproduced TS2307 and TS7006 with the unchanged server compiler and no aliases.
The same compiler applied to the promoted memory test revealed TS1543 for the
JSON import and TS377064 for its intentional measurement log. These changes form
the second and final combined-candidate repair round.

Runtime repair `92e01515af286f6b1ba27554d82bcc4151322193` changes only the import
to the repository's `vite-plus/test`. Memory repair
`9058f2b43042bf65900126112e5002987c43fa7f` adds the NodeNext JSON import attribute
and a justified next-line Effect console diagnostic directive. Separate fresh
xhigh part reviewers approve both exact commits. The memory reviewer verified
source/diff hashes directly; that part has no artifact manifest. Both parts retain
all assertions and test bodies, and the history fixture is byte-identical.

The approved parts are integrated at
`2de52a213ca7e35f20ac594d91e4a647452bfbd2`. The coordinator reran:

```sh
vp test run apps/server/src/provider/pi/PiRuntimeContract.test.ts apps/server/src/projectWork/memory/MemoryBackendContract.test.ts
node_modules/.bin/tsc --noEmit --project /home/user/.cache/pi-project-teams-11b7e351/wave1-validation/tsconfig.p1-promoted-no-alias.json
```

Tests pass 21/21 in 1.842 seconds, with a verified 1 GiB cap, 421,871,616-byte
kernel peak, and zero OOM events. Strict compilation passes in 1.169 seconds,
with a verified 1 GiB cap, 568,504,320-byte peak, and zero OOM events. The external
compiler config extends the unchanged normal server configuration, restricts
files to the two promoted tests, and supplies cached Node type roots. It has no
aliases, substitute declarations, or disabled compiler plugins. Both checks use
a 128 MiB Node heap setting, zero swap, and zero model calls. Exact commands, logs,
counters, and source hashes are retained in `wave1-validation/` with suffix
`2de52a21`. All four Linux ownership fixture source hashes are unchanged from
`bbe8cba1`; its seven real Linux outcomes remain applicable and were not replayed.

The final fresh combined review remains pending. P1 is unchecked and P2 has not
started. Normal build/test memory limits may increase when measured need justifies
it; the user's prohibition concerns all local model loading, hosting, and inference.
No Ollama, llama, local model, model weight download, push, or PR is authorized.

### P1 CI blocker and superseded repair pause

Fresh xhigh final wave review of
`7af9ed41a9cda1fb4335d6449c9779466b9c554d` returns **REQUEST_CHANGES** for one
verified high-priority CI finding. The reviewer ran this focused read-only check:

```sh
node --max-old-space-size=512 node_modules/knip/bin/knip.js --workspace apps/server --include files,dependencies --no-config-hints --reporter json
```

It exits 1 and identifies only the new `p1-runtime-descendants.mjs`,
`p1-runtime-linux-proof.mjs`, and `p1-runtime-mcp.mjs` as unused. Their consumers
launch by dynamic paths or explicit runner invocation; `knip.jsonc` registers the
older `src/provider/testFixtures/*.mjs` entry but omits these files. CI runs this
files/dependencies gate. The coordinator inspected the source and captured result
and verified both evidence digests at
`/home/user/.cache/pi-project-teams-11b7e351/final-review-7af9ed41/`.

The reviewer reports no other verified finding. It independently verifies the
combined source hashes, recorded 21/21 tests, normal strict compiler pass, unchanged
Linux proof source hashes, all selected manifests including 74 memory and 108
packaging artifacts, and both original native UUID/vector/payload recovery sets.
These findings support P1 feasibility with its documented production obligations;
the outstanding CI finding prevents approval, landing, or marking P1 complete.
The reviewer did not replay tests, remote calls, or Linux proofs.

The prepared repair adds one explanatory comment and three exact fixture entries
to `knip.jsonc`. It is retained outside the worktree at
`/home/user/.cache/pi-project-teams-11b7e351/wave1-validation/proposed-knip-entry-repair.patch`;
`git apply --check` passes. It has not been applied. The shared delivery contract
at `/home/user/.agents/skills/delivery-core/CONTRACT.md` limits automatic repairs
to two and says, "Stop after the second repair attempt or the final permitted
full-validation failure." Both combined-candidate rounds are consumed. The
coordinator requested explicit authorization for this additional scoped repair,
focused Knip check, and fresh review; dependent implementation remains gated.

The wave stays clean at `7af9ed41a9cda1fb4335d6449c9779466b9c554d`; it has not
merged into this main worktree. This main advance updates only this progress
record and must be reconciled into the wave before a later authorized merge.
P1–P14 and all 19 acceptance criteria remain unchecked. Normal build/test memory
caps may increase as needed; local model loading, inference, hosting, and downloads
remain prohibited. No push, PR, browser/device use, or live T3 database write occurred.

### Authorized P1 repair and plan-wide execution policy

On 2026-09-30 the user authorized the prepared Knip repair, then explicitly
instructed: "Ignore repair limits for this entire plan implementation, go until
completion." Automatic repair-count limits no longer stop this plan. Dependency
gates, independent part/wave reviews, focused checks, real evidence requirements,
process ownership, and the prohibition on local models remain in effect.

The main record advance `063de7584956fb711b40fb80ccc137823d523da9` is reconciled
into the wave at `d41fa29cff0b06b7e49152d9e18370d8c358b1e0`. Its progress-file
conflict was resolved to the complete main record; all eleven tested code/dependency
hashes remain unchanged. The isolated medium worker's exact repair commit
`ab0b874873daa65fdd5f33d2c228279ef0a02027` changes only four lines in `knip.jsonc`.
The required server-scoped files/dependencies audit reports `{"issues":[]}` and
exits 0 in 2.471 seconds, with a 2 GiB cap, 477,777,920-byte peak, and zero OOM
events. Scoped format and whitespace checks pass. Tested source/diff hashes match
the clean commit, and the coordinator verifies all 21 artifact hashes at
`/home/user/.cache/pi-project-teams-11b7e351/knip-entry-repair-evidence/`.

An additional server-scoped export check initially could not load the declared
TypeScript 6.0.3 alias because ignored `scripts/node_modules` was omitted from
worktree setup. Copying the existing declared links fixes resolution without an
install or tracked dependency change. The 512 MiB and 1 GiB heaps then exhausted;
these failures remain preserved. At a 4 GiB Node heap under a 6 GiB cap, analysis
completes in 14.832 seconds with a 2,893,524,992-byte peak and zero kernel OOM
events. It exits 1 with 58 export findings and three duplicate groups across
34 existing server files, none in the new pi/memory fixture scopes.

The coordinator runs the identical scoped export command on the clean main base
`063de7584956fb711b40fb80ccc137823d523da9`, before P1 source/configuration changes.
That control exits 1 in 15.585 seconds, peaks at 2,814,910,464 bytes under the same
heap/cgroup limits, and has zero OOM events. All 34 full file-keyed issue payloads
match exactly; only outer array order differs, and all 34 file hashes are unchanged.
Evidence is `wave1-validation/knip-exports-main-control{.log,-result.json}` and
`knip-exports-baseline-comparison.json`. This establishes the scoped findings as
baseline findings; it does not claim the full multi-workspace CI export gate passed.
No unrelated source cleanup or repository-wide check was performed.

Fresh xhigh part review approves exact `ab0b874873daa65fdd5f33d2c228279ef0a02027`
and independently verifies the four-line scope, passing audit, all manifest
hashes, and matched export control. The final combined wave gate remains pending.
Runtime, memory,
Linux ownership, and packaging proof sources are unchanged; their reviewed evidence
is retained. No additional runtime/model/API calls, local model work, browser/device
use, push, PR, or live T3 database write occurred. P1 remains unchecked until the
wave's required checks and fresh review pass and it lands on this main worktree.

### P1 landed; foundation wave starts

Fresh GPT-6.1-Sol xhigh final wave review approves exact
`a7ec65f70ba94f071dc8db860a7c2a365daf066d` against the reconciled main
`063de7584956fb711b40fb80ccc137823d523da9`, with no remaining blocking finding or
unchecked P1 feasibility item. It independently verifies 420 artifact digests
across 16 manifests, thirteen candidate hashes, the closed 146-node SDK graph,
seven causal Linux cleanup outcomes, both exact native memory recovery sets, and
npm/ASAR/SEA enabled-resource/tool outcomes.

The coordinator's combined scoped Knip audit at that exact candidate exits 0 with
`{"issues":[]}` in 2.212 seconds, under a verified 2 GiB cap, 402,673,664-byte
peak, and zero OOM events. `wave1-validation/manifest-final-knip.sha256` retains
six combined/baseline artifacts. All eleven V1/compiler code/dependency hashes
and the four real Linux fixture hashes are unchanged; their passing reviewed
evidence remains applicable. Full multi-workspace CI exports were not run, and
the matched scoped baseline findings remain explicit.

Main was clean and had not advanced. The approved wave lands by ordinary local
merge `1825ba53f902fe498bb2cdd299b3cf157fd872a7`, preserving history and unrelated
work. P1 is complete. This record-only completion commit is the base for wave 2,
P2–P3. One medium foundation owner receives contracts, persistence, migrations,
and then authorization; other implementation slots remain idle until those
interfaces are stable. Each part is independently reviewed before wave integration.

P2–P14 and all 19 product acceptance criteria remain incomplete. The documented
production runtime, isolation, memory, packaging, and client gates still apply.
The user removed development repair-count limits for this entire implementation;
product teams retain the specification's configured repair allowances. No push
or PR has occurred, and no local model has been loaded or hosted.

### Foundation progress and resumed proof evidence

P2 is isolated on `pi-teams/p2-foundation` in
`/home/user/.cache/pi-project-teams-11b7e351/p2-foundation`, based on main
`5ac775af2f1118396294db8020224838b6e7cd82`. One medium foundation owner holds
contracts, migration 019, existing Project Work persistence, bounded reads, and
export adaptations. P3 remains gated on P2 checks, coordinator inspection, and
fresh independent part review. This describes the earlier draft; committed and
reviewed repair candidates are recorded below. No P2 candidate has entered wave 2.

Draft checks recorded 193 contracts, 22 persistence, and 19 gateway/export/stream
passes. These are interim results; changed source requires final checks and
matching source/diff hashes before review. A missing ignored dependency link
prevented the patched Effect test package from resolving the already-installed
Vite+ package; restoring that link allowed the normal contracts compiler to pass.
No dependency declaration, substitute type declaration, or compiler alias changed.

After the user requested continuation, the prior worker was no longer active. A
replacement medium worker resumes the preserved draft under the same exclusive
assignment. Disposable `/tmp/pi-project-teams-11b7e351/` worktrees and probe files
are now absent. Their committed source and historical review verdicts remain;
durable integration logs and manifests under the home cache survive. Several raw
runtime/isolation/packaging and memory artifacts from the P1 review are unavailable
for a new independent inspection. The earlier 420-digest verdict records what was
verified then; it does not establish those files are retained now.

Two independent medium workers inventory and recover or regenerate missing
evidence in persistent home-cache directories. Their separate branches/worktrees
start at the same `5ac775af2` base: `pi-teams/p1-runtime-evidence-recovery` and
`pi-teams/p1-memory-evidence-recovery`. Their writable scopes are external evidence
and disposable probes only; repository source stays read-only unless separately
assigned. They do not delegate, launch clients, or merge. The pinned SDK remains
available. The runtime worker may run the committed offline portable and Linux
proofs with owned processes; fresh native isolation/packaging and remote memory
proofs first require concrete bounded configurations. Missing historical files
will not be reconstructed with invented original hashes. New proof source,
commands, versions, limits, and results stay distinct from historical evidence.

Runtime/memory rollout and final closure require inspectable retained evidence
and fresh review of regenerated proofs. P2 can finish its isolated storage work;
no product acceptance criterion is complete. Normal tool memory caps may increase
when needed; all local model loading, hosting, inference, and weight downloads
remain prohibited. No push, PR, browser/device use, or live T3 database write has
occurred. Development repair-count limits remain waived for the entire plan.

### P2 independent findings and scoped repair

The initial P2 candidate is committed at
`ee5be040c0c5b1f82fbb30d708712af5eeebd88a`, with 28 assigned files. Final focused
checks pass 193 contract tests, 23 storage tests, and 40 affected server tests;
normal contracts and narrow server compilation, scoped lint/format, and whitespace
checks pass. The coordinator verifies all 80 retained artifact hashes, 40 tested
source hashes, and the exact tested diff in `p2-foundation-evidence/` under
`/home/user/.cache/pi-project-teams-11b7e351/`.

Fresh GPT-6.1-Sol xhigh review returns **REQUEST_CHANGES** for four independently
reproduced SQLite/Gateway defects: mutable effect/message deduplication identities
and uncertainty retry fences; mutable frozen memory provenance/payloads; removal
of legitimate numeric token budgets from public reads; and foundation records
surviving permanent project deletion. The coordinator inspects the causal source
and reproduction results and accepts these findings. Review evidence is retained
in `review-p2-foundation/`; the candidate has not merged into wave 2 or main.

A medium worker repairs this candidate on `pi-teams/p2-foundation-repair1`, based
on exact `ee5be040`, in the matching home-cache worktree. Its exclusive scope is
the initial P2 files plus `ProjectLifecycle.ts` and its focused tests for local
foundation cleanup. It must preserve a shared repository cursor for a verified
surviving project binding without changing its GitHub account or dispatching work.
Focused causal regression checks precede final checks and a fresh independent
review. P3 remains gated on approved P2 integration; development repair limits
remain waived. Root main advances since the P2 base affect this record only and
must be reconciled before wave integration.

Fresh runtime/isolation/packaging and remote-only memory proof collection is
underway in persistent `runtime-evidence-recovery-artifacts/` and
`memory-evidence-recovery-artifacts/`. New artifacts do not replace lost historical
hashes or certify a completed production runtime. They require coordinator
inspection and fresh review before dependent rollout. P2–P14 and all 19 product
acceptance criteria remain incomplete. No push, PR, browser/device use, live T3
database write, or local model work has occurred.

### Regenerated proof reviews and P2 continuation

The first P2 repair is committed at
`68ee4ae8b487eb403dc66522fd8344d96d10e3d8`. Final evidence records 193 contract,
25 storage, and 51 affected-server passes; normal contracts and narrow server
compilation, scoped formatting, and whitespace pass. The coordinator verifies
all 65 repair artifacts, 42 tested source hashes, and the exact full diff against
`5ac775af2`; its SHA-256 is
`767f5c8feeabfd9b6b43310d00b9dc656e6e414061ac6dfadbe7d20a596231e2`.
Scoped lint exits 1 with five unchanged `ProjectLifecycle.test.ts` baseline
errors, verified against the pre-repair source; it is not a green lint result.

Fresh xhigh review resolves the original four findings but returns
**REQUEST_CHANGES** for two additional storage defects. Existing issue/cursor
updates can retarget canonical identity or silently change the cursor account.
Permanent deletion transfers a shared cursor SQL row without transferring its
authoritative event/reducer history: a normal next revision fails, while a
revision-zero replacement resets progress. The coordinator reproduces both with
actual migrated SQLite and repository/lifecycle services. Exact command and
results are retained in `root-p2-review-verification/`; peak memory is
147,910,656 bytes under a 1 GiB, zero-swap scope with zero OOM events. Review and
causal probes are in `review-p2-foundation-repaired/`.

A new medium foundation owner repairs these findings in
`pi-teams/p2-foundation-repair2`, based on exact `68ee4ae8`, in the matching
home-cache worktree. Ordinary canonical identity/account updates must reject;
legitimate content and cursor progress changes must remain valid. Cursor transfer
must atomically preserve record revision/generation, account and progress in
survivor event authority, public reads, restart and rebuild. The owner retains
the existing P2 scope and may extract a minimal internal event reader into
`ProjectWorkEventStore.ts` to avoid a repository/persistence import cycle. No
public generic foundation mutation, execution enablement or external dispatch is
authorized by this repair. Focused causal gates, final affected checks, and a
fresh independent review precede integration. P3 remains gated.

The regenerated remote memory proof is independently **APPROVED** within P1's
bounded proof scope. All 168 artifact hashes match; manifest SHA-256 is
`fd225cea84edeec171a4fa6f8d9cf751a21f9cce7f94a5ade1e0de9083a5eeab`.
Fresh review in `review-p1-memory-recovery-fresh/` verifies exact native
UUID/payload/float32 recovery sets, request budgets, copied-store native search,
SQLite FTS fallback, and 11 causal rejection controls. Actual calls are 10
CommandCode Ling extraction attempts and 31 OpenRouter NVIDIA embedding attempts;
charged usage is 87,895 input and 2,791 output tokens, retaining unknown-failure
reservations. The largest verified probe peak is 163,708,928 bytes, with no OOM
or surviving owned cgroup. Qualified source recall is 1.0 versus FTS 5/7;
macro source precision is about 0.383. Native correctness/selectivity, positive
sharing/revocation, exhaustive production reconciliation and P10/P14 completion
remain unproved. Historical missing evidence is not recertified. An earlier
standalone fresh review stopped on model capacity without a verdict; its partial
checks were not accepted as approval.

Regenerated offline runtime/isolation/packaging evidence contains 257 verified
artifacts, manifest SHA-256
`97c23ec7fc10955cdc9c743c0be528f96f8060fbccabdf0a7484677c946b137d`.
It includes actual pinned-SDK portable/Linux consumers, privilege controls,
setup/descendant cleanup, and npm/Electron-ASAR/ESM-SEA probes. Fresh xhigh
review independently **APPROVES** this frozen offline scope.
The reviewer verifies all 257 artifacts, 2,222 bundled inputs and eight copied
consumer/control replays; all owned cgroups drain with zero OOM. Its 563-file
manifest SHA-256 is
`043f319347561f245c14c1ccfb6a637aaa58af35234fe2e0ceaeb21e45a7f43f`.
This excludes lost historical live evidence and the new live proof. Full T3
packaging and supported-client verification remain later gates.

The new live preparation passes 22 guard and 25 owned broker controls, including
actual compiled SDK synthetic fresh-session/compaction/reopen/resume consumers.
All 567 preparation artifacts match manifest SHA-256
`c90b57a86e9c856e1d5e3eb56f819580edc3649ba1d373b0f689e77641b288b8`.
After source/budget/isolation inspection, the coordinator authorizes one concrete
bounded invocation against the existing CommandCode Ling free route. It fails
on its first HTTP 200 response before accepting native model/usage evidence.
The failed raw stream was removed by the prepared failure policy; exact cause is
unavailable. No automatic retry occurs. Full reservations remain charged at
20,000 input and 512 output; SDK error usage zeros are not provider usage.
The 512 MiB, zero-swap owned cgroup peaks at 162,750,464 bytes with zero OOM and
fully drains. The failed-attempt manifest has 15 new files and SHA-256
`49571a40336f4106cb99c31615b8097c657025a33c8627b32160793f0c889e99`.
The coordinator inspects a separate safe diagnostic patch and authorizes
preparation on copies for one isolated SDK completion, carrying the charged
ledger. No further remote call is authorized yet, and no live
streaming/compaction proof pass is claimed.

All paths above are below `/home/user/.cache/pi-project-teams-11b7e351/`.
P2–P14 and all 19 product acceptance criteria remain incomplete. Development
repair-count limits remain waived. No push, PR, browser/device use, live T3
state write, local model loading/hosting/inference or weight download occurred.

### P2 second repair candidate and live frame diagnosis

P2 second repair candidate is `163bc0650595b0672e623dd8c444d1d846459448`,
clean on `pi-teams/p2-foundation-repair2`, with 32 authorized paths. The
coordinator verifies all 125 artifacts, 45 tested source hashes, and the exact
full candidate diff, SHA-256
`7b82cc81735c142f36cfd8801d886749ccb09b5452b3df062bacf4bbd0ecb3d2`.
Canonical issue/cursor identity and account remain immutable; cursor deletion
transfer preserves survivor event authority, restart/rebuild progress and normal
next revisions. A discriminating rollback/retry/duplicate test also finds and
fixes retained publication state when executing the same deletion Effect again.
The final affected gate passes 45 tests. Normal server-entry compilation passes
in a 4 GiB zero-swap scope with `GOMEMLIMIT=3GiB`, peak 3,830,841,344 bytes and
zero OOM. Format and whitespace pass; scoped lint retains exactly five verified
baseline errors. Earlier native-Go compiler OOM receipts remain retained.
Fresh xhigh review in `review-p2-foundation-repair2-fresh/` returns
**REQUEST_CHANGES** for one new receipt collision, P2-R7; R1–R6 pass within P2.
Its 21-file manifest SHA-256 is
`3432b4079b5fc198ca2a928dca8f617aef78b4257e235fa5bd32950ea2ddf03a`.
An internal cursor-transfer event has no bound command receipt: a public caller
reusing its ID receives accepted status without a created task. A caller claiming
the future transfer ID first also causes two operations to share one receipt.
The coordinator independently reproduces both through migrated SQLite and the
public Gateway; the latter peaks at 145,035,264 bytes under a 1 GiB zero-swap
scope with zero OOM. Exact commands and results are in
`root-p2-review-verification/`. A medium owner repairs only the assigned
foundation scope in `pi-teams/p2-foundation-repair3`, based on exact `163bc065`,
with transactional transfer-ID collision checks and bound receipts. Focused causal
checks and another fresh independent review precede integration. No P2
implementation has merged into wave 2 or main. P3 remains gated.

Three additional isolated real pi requests reach HTTP 200 but fail native
frame checks. Attempt 2 shows plain `inclusionai/ling-3.1-flash` in content
frames; attempt 3 shows that name followed by requested free-model identity.
Attempt 4 disproves the prepared empty-choice terminal hypothesis: after 93
matching plain-model frames, a free-model usage-bearing frame has one choice.
No successful completion/compaction/resume pass is claimed. Four failed requests
retain full charges of 80,000 input and 2,048 output tokens; all owned 512 MiB
zero-swap cgroups drain with zero OOM. The exact outgoing route remains
`inclusionai/ling-3.1-flash:free` on CommandCode. Primary catalog/page snapshots
in `root-commandcode-route-metadata/` confirm that route and context size;
published free pricing, SDK estimates and unreported per-request billing remain
distinct. Separate copied diagnostic sources and preparation/failure manifests
preserve every earlier artifact and reservation. A fifth isolated request
recognizes the one-choice stop frame but rejects a subsequent usage-only frame.
The first reports zero token usage; the later frame has empty choices and its
usage values remain unaccepted. Five failed requests now retain 100,000 input
and 2,560 output reservations. The 13-file attempt-5 manifest SHA-256 is
`f5c77064dd7342e042844d1a5fc92e990244d42d31f3e06ec145cc2bf40f7741`.
A copied first-completion-only guard is being prepared to distinguish the
preliminary zero-usage stop envelope from final native usage. No further call
is authorized yet and no completion pass is claimed.

All evidence paths above are below
`/home/user/.cache/pi-project-teams-11b7e351/`. Development repair limits remain
waived. No local models, weight downloads, browser/device use, live T3 writes,
push or PR occurred. P2–P14 and all 19 product acceptance criteria remain open.

P2-R7 repair is committed at `6d19799a6861090f67960e31da3adc2ae8c461d8`,
clean in `pi-teams/p2-foundation-repair3`. It changes only lifecycle, lifecycle
tests and Gateway tests. The coordinator verifies all 44 retained artifacts,
45 tested source hashes and byte-exact full/repair diffs. The full 32-path
candidate SHA-256 is
`afe2bff7b00ac8a99285569a4676f48bc4c3df1e68d79c20711bd85bf085a732`;
manifest SHA-256 is
`0acc8e5c95ccae26655c0763e32e686b8a6d4bc67f4ab246b47ab52e821ef80a`.
Focused 39, V2 contracts 64, V2 storage 27 and affected-server 189 tests pass.
Contracts and normal server-entry compilation pass; server peak is 3,818,319,872
bytes under 4 GiB zero swap with `GOMEMLIMIT=3GiB` and zero OOM. Formatting and
whitespace pass; exactly five verified baseline lint errors remain. Fresh
xhigh review in `review-p2-foundation-repair3-fresh/` **APPROVES P2 only**.
The coordinator verifies its 55-file manifest with SHA-256
`de742b0d2a2cf3d6182747b1881309c2f371a7e3884fa1cf2e962e728ff9a583`.
Seven independent positive SQLite/Gateway probes pass under 1 GiB zero swap,
including collision, rollback, file-backed restart, competing capacity and
bounded export. The same collision consumer fails on unrepaired `163bc065`.
Peak is 250,114,048 bytes; all owned cgroups drain with zero OOM. Three retained
scratch-harness failures remain identified as failures.

The coordinator merges reviewed `6d19799` only into `pi-teams/wave2` at
`c3ed6d3d4c606f66b9c07000246f16682df035af`; all 32 approved files are
byte-identical after the merge. The sole foundation owner starts P3 from that
exact base in `pi-teams/p3-authorization`, with exclusive auth/MCP/ProjectWork
boundaries, additive typed intents and narrow production authorization-layer
registration. Migrations, dependencies and other wiring remain coordinator-owned.
P3 interfaces are approved before contract edits. P2/P3 completion still requires
combined V2/V3 checks and fresh wave review before this main worktree receives
implementation. No product acceptance criterion is checked.

### Native pi streaming and continuation progress

Actual ordinal 6 passes native SDK streaming through the CommandCode Ling free
route. Its 17-artifact manifest SHA-256 is
`7381d0a992d883100904aa56ca24ae3b27c3459d27a015c586195b54e07a1658`.
The coordinator verifies every artifact. Native session SHA-256 is
`00a8c2293d2d8bd62898d81c01327ca9a14d71a7461b2b9698afda0de28d1dbe`.
The response confirms plain-model content, a free-model preliminary zero-usage
stop envelope and a separate free-model final accounting frame. Native usage is
219 input, 376 output, 595 total, including 192 cached input tokens. The SDK emits
11 text deltas, successful native assistant stop and `agent_settled`.
The owned 512 MiB zero-swap cgroup peaks at 132,354,048 bytes and drains with
zero OOM. Actual dollar billing is unreported; published free prices and SDK
zero-cost estimates do not establish actual billing. Five earlier failed calls
retain full charges; reservations remain 120,000 input and 3,072 output.

A separately frozen continuation opens that exact native file, without another
fresh completion. Preparation passes 59 guard controls and 45 owned controls,
including actual SDK compaction/reopen/resume under synthetic transport. The
633-artifact manifest SHA-256 is
`41b29b4961d9e786bedb637d3d255b6607d5c7328efb64fe9154a56be4709a66`.
The coordinator verifies all artifacts and exact unchanged guard/source/carry
boundaries, then authorizes one invocation with ordinal 7 compaction capped at
2,048 output and ordinal 8 resume capped at 512 output. The request byte bound
stays 12,288; aggregate ceilings stay eight calls, 160,000 reserved input and
5,632 reserved output. Earlier ledger entries remain unchanged.

Ordinal 7's real stream completes with 1,978 input and 622 output tokens. The
retained native session contains a real compaction entry and reopened recent
context preserves all four complete assignment/decision/question/limit facts.
The worker then receives SIGKILL before ordinal 8 is reserved or sent. The owned
cgroup drains with zero OOM; peak is 133,562,368 bytes. Full continuation is not
passing. Retained artifacts suggest a response-drain/next-request race; exact
rejection cause is unavailable. Separate local exact-SSE replay demonstrates
that native completion can precede the parent end receipt: delayed-end and
coalesced controls fail before the next reservation, while split-final succeeds.
Its 75-artifact manifest SHA-256 is
`22602f0f51813cefc8bdd3e0fd73d654053e01a40e1197f1b0960db6aff800be`.
The coalesced race is timing-sensitive; these controls do not reconstruct the
original missing IPC trace.

A separately prepared worker adds a bounded per-request parent end/error receipt
barrier before the next dispatch and final success. Strict concurrency and the
native accounting guard remain unchanged. Preparation manifest SHA-256 is
`b2480b25f2e33c6d75ec3513bf8e4bbafdfbe0ddc7c78be1dfe4969cc0ecfb69`
for 872 artifacts; 59 guard, 46 owned and three repaired causal controls pass.
A separate exact 60-second missing-parent-receipt control fails safely without
success, another request or surviving process. Its 31-artifact manifest is
`b96470fe5663f1b2629a9e026556237ba97629d98b51fe673f9f190a00958dec`.

After exact source, budget, native-prefix and control inspection, the coordinator
authorizes only ordinal 8: one resume capped at 512 output, no fresh completion,
recompaction, retry or fallback. It **PASSES**. The actual 20-artifact manifest is
`28a590d042c93ac5ab40d368ab689df13ebf63b66a11f69d889d97e13950b4be`.
The coordinator verifies each hash and the native chain directly. The final
session preserves the exact 25 prior entries, pending user ID once, one distinct
recovery prompt and a native stopped assistant. All four complete facts survive
reopen. Pi emits 19 text deltas and `agent_settled`; final worker success waits
for the parent receipt and drain. Usage is 1,007 input and 483 output. Peak is
127,180,800 bytes under 512 MiB zero swap, zero OOM and fully drained.

Fresh xhigh review in `review-p1-live-recovery-fresh/` **APPROVES this bounded P1
live proof**, verifying 2,414 selected manifest entries and the three native
bundle closures before and after seven copied actual-SDK probes. Delayed-end
reproduces the old race; repaired delayed/coalesced consumers and final resume
pass. The review's coalesced old consumer happens to pass, with premature worker
`done` still visible; it remains a recorded timing-sensitive result. Invalid
native usage fails with full reservation and no success. All owned review
cgroups drain with zero OOM. The 195-artifact review manifest is
`249f4fe943f3187c32658e8be1654b579d8bc6aee468559dd7dca6bb7ef23045`.
The coordinator independently verifies that manifest and the complete report.
Ordinal 7 remains a failed partial invocation. Reservations now exhaust the
original eight-call ceilings at 160,000 input and 5,632 output; charged totals
are 103,204 input and 4,041 output, retaining five failed full charges and known
6/7/8 usage. No further remote proof call is authorized. Actual billing and
hidden upstream routing remain unproved. P7, P14 and product acceptance remain
separate gates.

Evidence is below `/home/user/.cache/pi-project-teams-11b7e351/`. Development
repair limits remain waived. No local model, weight download, browser/device,
live T3 write, push or PR occurs. P2–P14 and all 19 acceptance criteria remain
open.

### Resumed P3 candidate and independent review

The user requested continuation, continuous progress updates, and a top-level
tally. Implementation resumed with one Sol high P3 owner; other implementation
slots wait for the foundation dependency gate. The main documentation commits
`0e40a230a2560e79da3baf06f2a1154175d0b910` and
`41ebb90db4d82fcad97dec1d3aec0b51e531b869` change staffing and progress only.

P3 candidate `c6a38aaaba0278c71c8c764748aed51855ae626c` is clean on
`pi-teams/p3-authorization`, based on
`c3ed6d3d4c606f66b9c07000246f16682df035af`, with exactly 32 assigned paths.
Only `ProjectWorkGateway.test.ts` and `ProjectWorkRuntime.ts` differ from the
frozen pause source. Removing the duplicated retry payload key and preserving
the supplied layer's actual output/error/context types fix all three compiler
issues without casts, compiler substitutions, or production wiring changes.

Fresh checks pass 28 focused Gateway/Runtime regressions, V3 66 tests, affected
authorization/proxy 51, host/runtime/export 39, V2 contracts 65, and V2 storage 29.
The unchanged normal server-entry compiler changes from five diagnostics to
exit 0 in 22.389 seconds, peak 3,522,576,384 bytes under a verified 4 GiB cap and
zero swap/OOM. The normal contracts compiler and 32-path lint/format/diff checks
pass. Exactly five unchanged Lifecycle baseline lint failures remain recorded.
Actual WebSocket transport and integrated clients remain unproved.

Evidence is `p3-resume-high-evidence/` below
`/home/user/.cache/pi-project-teams-11b7e351/`; `exact-commands.json`,
`fresh-final-results.json`, source hashes, the complete patch, archive, and
handoff retain the exact tested candidate. The 58-artifact manifest SHA256 is
`56b2b3d4495c9447c8852ede2666bd68b72502f18258a78002baed608f6f5d82`;
full candidate diff SHA256 is
`e18ce9c774c83be8e1e480fe5408c6691f1bace6dc5634516e76a0a19e07cfba`.
The coordinator verifies all 58 artifacts, all 32 source paths against the clean
commit, the full diff, matching check source hashes, and all 14 owned scopes
drained, recorded in `root-p3-resume-inspection/inspection.json`.
The one independent reviewer, `review_p3_authority`, examines this exact commit
read-only without implementer conversation history; it will handle any repair
rechecks itself. No P3 or combined wave approval or main code merge is claimed.

The coordinator additionally runs server-scoped Knip on exact `c6a38aa`:
`node --max-old-space-size=512 node_modules/knip/bin/knip.js --workspace apps/server --include files,dependencies --no-config-hints --reporter json`.
It returns `{"issues":[]}`, exit 0 in 2.891 seconds, peak 489,689,088 bytes under
2 GiB zero swap/OOM. Exact receipt and log are in `root-p3-resume-inspection/`
with prefix `p3-candidate-knip-files-deps`; no repository-wide or export audit ran.

### Safe cross-phase preparatory assignment

The user permits safe simultaneous work across phases and phase slices. The
coordinator applies this to a bounded P5 transport slice while P3 is under review
and repair. Its dependency is the existing GitHubCli/pinned-credential/rate-limit
interface already in main; it does not depend on unfinished team lifecycle or
authorization contracts. The worker first proposes its server-local typed page
interface to the coordinator. Shared contracts, persistence, runtime wiring,
dependencies, and the plan stay coordinator-owned.

The slice branch is `pi-teams/p5-intake-transport`, worktree
`/home/user/.cache/pi-project-teams-11b7e351/p5-intake-transport`, explicit base
`4003588f6` (the complete hash is recorded in its assignment). Exclusive writable
scope: new `apps/server/src/projectWork/github/GitHubIssueClient.ts` and
`GitHubIssueClient.test.ts`. Acceptance is bounded authenticated read transport,
repository identity/account checks, issues/comments pages, conditional reads,
PR filtering, and rate-limit/error behavior. No synchronization, human actions,
model dispatch, or completion of P5 is claimed. Review and integration wait for
its own checks and the applicable parent dependency gates. Future P5 workers
must consume this interface and leave these two paths to this owner.

### P3 independent findings verified before repair

The coordinator independently reproduces three defects on clean candidate
`c6a38aaaba0278c71c8c764748aed51855ae626c`, using copied review probes outside
the worktree. An MCP-only managed issuance leaves a preceding WebSocket session
unrevoked in SQL: it is denied during management and after purge by the retained
auth service, but a fresh service with the same signing key permits the original
bearer and guarded terminal side effect. A retained production catalog's private
proxy lease executes after complete binding/event/checkpoint purge even though
the old raw MCP token remains revoked. A depth-two descendant with a frozen
depth-eight profile can enqueue third-level delegation despite its root's frozen
depth-two limit; a depth-two leaf profile correctly denies the same request.

The root reproductions pass as defect controls, not product acceptance. Exact
commands, observations, source hashes, and receipts are in
`root-p3-review-verification/` below the external evidence root. They take 2.983,
3.066, and 3.507 seconds respectively, peak 569,716,736 / 554,508,288 /
429,121,536 bytes under 2 GiB zero swap/OOM, with all owned scopes drained.
Initial copied-probe runs fail module resolution and remain preserved; correcting
only the external dependency link enables the causal runs. No actual WebSocket
socket or external MCP transport proof is claimed; the proxy case exercises the
retained service consumer with a synthetic upstream. Delegation creates only a
message and no execution effect. P3 remains unapproved pending scoped repair
and recheck by its same independent reviewer.

### P3 repair and GitHub transport prerequisite

P3's one independent reviewer returns **REQUEST_CHANGES** with the same three
root-reproduced findings. It independently passes 66 V3 tests, 55 focused
compatibility tests and four causal probes, preserving all 11 drained scopes.
The coordinator verifies its 62-artifact manifest, SHA256
`91efde0b2afaa3c8d43886a19e36ea015be8ac2b6bd2e00262f001d39ddabbea`.
The same Sol high owner repairs on base `c6a38aa` in the existing P3 worktree;
the same reviewer will recheck. No approval or code merge has occurred.

The P5 leaf owner discovers that actual `gh api --include` emits HTTP 304 headers
but exits nonzero, while the existing GitHubCli wrapper loses that stdout.
Official gh v2.99.0 source confirms this behavior:
[processResponse](https://github.com/cli/cli/blob/v2.99.0/pkg/cmd/api/api.go#L433).
The coordinator owns a minimal shared-helper part on branch
`pi-teams/p5-github-http-output`, worktree
`/home/user/.cache/pi-project-teams-11b7e351/p5-github-http-output`, base
`19335d47743d92fe0f7ea0b0bcb61f84df59a299`, candidate
`05172c635ea8636bffc99d9745adf596dd3a2454`. Its exact two paths are
`sourceControl/GitHubCli.ts` and `GitHubCli.test.ts` under server `src/`. The
optional server-local `allowNonZeroExit` forwards to the existing VcsProcess
option; default and explicit-false callers retain existing error behavior.
Callers opting in must validate returned HTTP and process statuses.

A controlled ProcessRunner response through actual VcsProcess/GitHubCli fails
before the patch and retains the conditional headers plus exit 1 afterward.
All 28 GitHubCli/VcsProcess tests pass. The normal unchanged server-config
focused compiler passes in 1.252 seconds, peak 614,342,656 bytes; exact-path
lint, format and diff pass. Initial wrong compiler command and missing plugin
dependency fail and remain recorded; correcting only tool/worktree setup gives
the final checks. No actual GitHub response or full P5 completion is claimed.
Evidence is `p5-github-http-output-evidence/`, 27-artifact manifest SHA256
`5f0fa9e5826af9b28906cc50de7e3534f86c635da361b48c0622d4b7ad33ce61`.
Fresh helper review must pass before the leaf consumes this commit. A reviewer
launch encounters the harness thread limit; the waiting P5 worker checkpoints
to free its slot. This does not waive the review gate.

### Assigned independent P7 skill-delivery slice

A separate P7 skill slice can consume the existing ProviderSkillAdapter and owned
SkillMaterializationService interfaces without unfinished team contracts. The
coordinator prepares branch `pi-teams/p7-skills-slice`, worktree
`/home/user/.cache/pi-project-teams-11b7e351/p7-skills-slice`, base
`e18528baf66d38ed53c697d8b175ae95857fc0f7`. Its two exclusive writable paths
are `apps/server/src/skills/ProviderSkillAdapters.ts` and
`ProviderSkillAdapters.test.ts`, adding only the pi factory and its checks.
The factory requires a server-owned authorization callback returning the allowed
skill keys for the request. It validates identity/keys, uses existing owned
materialization, and returns explicit managed skill paths with no implicit native
sources or live application. The future PiDriver must bind the callback to current
run authority and frozen role/configuration; that wiring remains an unfinished
full P7 gate. Real worker mounts, extensions, provider registration, native session
behavior, and packaging are outside this slice. The runtime worker's prepared
scope reserves these paths if this assignment starts; no two workers own them.
Sol high owner `p7_skills_slice_high` is dispatched after the earlier worker slot
was freed. P7 skill preparation is active; full P7 remains incomplete.
The agreed local payload carries only root and explicit keyed skill paths;
authorization is required before and after copying. The future runtime owner
must consume this factory and leave these two paths to this owner.

The GitHub helper's one fresh xhigh review **APPROVES** exact `05172c6`, replaying
28 tests and 14 independent behavioral checks with a copied-old-wrapper failure.
The coordinator verifies all 12 review artifacts, manifest SHA256
`e768105f31e3a3b1405079388733b1df28883dfabf071942b4b3e1fb6c915ec4`.
Three fresh scopes drain under 2 GiB zero swap/OOM. Approval covers the shared
helper only. The coordinator advances the P5 leaf branch from `4003588f6` to
this reviewed prerequisite, proving the two uncommitted leaf files are unchanged
byte-for-byte. The same high leaf owner resumes focused verification from exact
`05172c635ea8636bffc99d9745adf596dd3a2454`. Neither helper nor P5/P7 leaf code
has landed in the main worktree. Three implementation owners now work in
exclusive P3, P5-transport and P7-skill scopes within the harness limit; a slot
will be freed before review.

### Committed independent slices and P3 repair recheck

The coordinator's standing policy and every new worker brief permit safe work
across multiple phases or independent phase parts simultaneously. The saved
strategy and assignment template now state the required slice dependencies,
exclusive owner, base commit and parent completion boundary. The deferred full P7
brief excludes the two skill-adapter paths now assigned to the skill-slice owner.

P5 transport commits `567978db2aea46f833523c61add9059f8bf64fab` from approved
helper base `05172c6`. Its 58 affected tests include 34 leaf cases. The normal
two-file compiler, exact-path lint, format and diff pass. The coordinator verifies
the clean commit, two source hashes/archive entries, full binary patch, all 46
candidate artifacts and 12 drained scopes. Manifest SHA256:
`f3fb376da075af8d9810cfbb72311b0da8c11ee8be32b852f09804c728bc9660`.
Fresh xhigh reviewer `review_p5_intake_transport` is active. This proves a synthetic
bounded transport consumer; real GitHub synchronization and full P5 remain open.

P7 skills commit `43d6c69db26a2a310bb8bc6989ab8845b99489cb` from base `e18528b`.
Its 45 affected tests, normal two-file compiler, exact-path lint, format and diff
pass. Six negative controls and an actual pinned-SDK dry skill loader check are
retained. The coordinator verifies the clean two-path diff, 12 current committed
source/archive hashes, full binary patch, all 81 artifacts and 23 drained scopes.
Manifest SHA256:
`68657e5736302ca84bd70211e66c72a2e241438f447e0e34596e8b42fd10d993`.
Fresh xhigh reviewer `review_p7_skills_slice` is active. Required trusted authority
binding and full runtime/isolation/packaging gates remain open. Neither slice
has been integrated or counted as a completed parent step.

P3 repair candidate `838e46623e88b1be04cd25c87b77bc692e685f88` passes 269
affected tests and the unchanged normal server-entry compiler (25.909 seconds,
peak 4,016,193,536 bytes under 4 GiB, zero swap/OOM). The coordinator verifies all
156 repair artifacts, 32 current committed/archive source hashes, both binary
patches, final-check source stamps and 34 drained scopes. Manifest SHA256:
`5d705f773acde1ae13813f464631b83b8058bd34a359164269304eb13230bcd5`.
Its same independent reviewer rechecks the candidate: 119 candidate tests, four
original denial probes and two stricter issuance controls. It returns
**REQUEST_CHANGES**: successful trusted issuance withdraws the old bearer, but
failed issuance after frozen-role retirement leaves it unrevoked. After full
managed-history purge and a fresh auth service, that bearer revives. The new
48-artifact review manifest is verified, SHA256
`580242f34b0c871089b6535cad491af0fe324dcdb539c9536a9523e6c1cdcefb`.
The coordinator reproduces both strict controls on `838e466`: successful issuance
denies after purge/restart with zero callbacks; failed issuance revives the bearer
and permits one guarded callback. The paired run takes 2.149 seconds, peak
677,781,504 bytes under 2 GiB, zero swap/OOM; all three owned scopes drain.
Two external-fixture setup failures remain preserved, followed by the completed
fixture run. No production source changes are used to reproduce the defect.
Commands, observations and 32 committed source-hash checks are retained in
`root-p3-failed-issuance-verification/root-verification.json`.
The same high owner resumes on exact `838e466`, with fresh repair evidence in
`p3-withdrawal-repair-evidence/`; the same xhigh reviewer will recheck.
P3 remains unapproved.

The first P3 reviewer recheck launch was rejected by the runner for a possible
cybersecurity risk. Retrying the same agent with a concise benign local read-only
review request succeeded; this was a runner rejection, not a review verdict or
a waived gate. No replacement reviewer was created.

Wave2 reconciles main documentation through `3f42e53` at commit
`5fa23d306dc3a83140a8452c772fe7bf318b9127`, with all 196 captured foundation
source hashes unchanged. Combined checks/review and main integration still wait
for P3 approval. No model calls, local model work, browser/device interaction,
live T3 writes, push or PR occurs during this continuation.

### Independent review repairs running across phases

P3 commits withdrawal repair `614329d713b952ac88d71c4b3297c31f17d9fb57` from
`838e466`, changing three existing P3 paths. Strict real-SQL/MCP cases first fail
on the prior source for retired-role, settled-binding and ambiguous-binding
issuance, while the successful control passes. The final focused gate passes
five cases; 272 unfiltered affected tests pass on the same source. Normal
server-entry compilation passes in 26.062 seconds, peak 4,053,917,696 bytes under
4 GiB, zero swap/OOM. Exact three-path lint, format and diff pass; the five
unchanged Lifecycle lint failures remain recorded. The coordinator verifies all
93 artifacts, 32 current committed/archive source hashes, repair/full patches
and 18 drained scopes. New manifest SHA256:
`49aa112f2b5271ef143e4618b9441d4be0d01803a4ac6cace11f3be2a867e987`.
Coordinator server-scoped Knip files/dependencies passes with `{"issues":[]}`
in 3.631 seconds, peak 467,750,912 bytes under 2 GiB zero swap/OOM. The same P3
reviewer is active on this exact candidate. It has not merged.

P5's one xhigh reviewer returns **REQUEST_CHANGES** on `567978d` after 58
candidate tests and 19 independent controls. Its three findings are documented
numeric repository pagination being rejected, malformed 403 bodies preventing
authoritative quota headers from pausing the host, and a 30-second headerless
secondary-limit fallback where GitHub specifies at least 60 seconds. The
coordinator inspects the current primary
[pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
and [rate-limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
guidance and reproduces all 19 controls in 0.444 seconds, peak 144,896,000 bytes,
2 GiB zero swap/OOM with the scope drained. The reviewer explicitly treats
modeled conditional-read identity changes and sequential snapshot uncertainty
as limitations, not additional verified GitHub failures. All 27 review artifacts
are verified, manifest SHA256
`7c19d23a922eaa495c321528bc8855c7263d9cbbba70f569f9486494c48c9cad`.
The same owner repairs the same two leaf files from `567978d`; verified numeric
REST identity stays private and shared rate-limit defaults stay unchanged. New
evidence is `p5-transport-repair-evidence/`; the same reviewer will recheck.

P7's one xhigh reviewer returns **REQUEST_CHANGES** on `43d6c69`: materialization
interruption can leave a copied pending directory or a published generation.
It passes 45 affected tests plus normal-completion/post-copy interruption
controls, while three acquisition/handoff and two raw materializer probes
expose the leak. All 10 reviewer scopes drain with zero swap/OOM; its 37-artifact
manifest is verified, SHA256
`20462cbe8be40f207e7028e0f9060b2634cc4341d13ce5595d89045dbdebb77a`.
The coordinator reproduces the exact copy, rename and post-return cases: all
three fail the cleanup assertions in 0.445 / 0.429 / 0.442 seconds, peak
160,428,032 / 143,482,880 / 160,346,112 bytes under 2 GiB zero swap/OOM, drained.
The unchanged shared materializer is the acquisition boundary the new pi
factory depends on. The same owner exclusively adds
`skills/SkillMaterializationService.ts` and its test to the two adapter paths.
Only ownership-safe cancellation/staging/publication/handoff cleanup and its
checks are authorized; service inputs/results and public contracts remain
unchanged. A small private cleanup boundary is approved to carry owned cleanup
from acquisition through plan return. Copying and held filesystem receipts must
remain interruptible, and foreign paths/inodes/markers and other generations
must remain protected. New evidence is `p7-skills-repair-evidence/`; the same
reviewer will recheck. Ordinary factories and full P7 integration remain separate
compatibility/runtime gates.

This concurrent P3 review, P5 transport repair and P7 skill repair applies the
updated cross-phase strategy within the actual four-agent harness limit. No
parent dependency or required integration gate is counted complete early.

The P3 reviewer then observes a remaining concurrency case on `614329d`: when a
binding is committed between the completed withdrawal statement and discovery,
issuance succeeds while the preceding legacy bearer remains unrevoked. The
coordinator copies the exact SQL-receipt/Deferred-controlled probe and reproduces
both timings in 1.782 seconds, peak 578,789,376 bytes under 2 GiB zero swap/OOM,
drained. A binding present before withdrawal denies the old bearer after purge
and restart with zero callbacks; the between-statements case permits one callback.
The wrapper executes actual SQL unchanged and only delays its completed receipt;
there is no sleep, fabricated SQL result or replacement authority service.
Evidence is `root-p3-binding-race-verification/root-verification.json`.
The reviewer turn encounters another runner rejection for possible cybersecurity
risk. The same agent is retried with a narrower local source/test reporting
request succeeds. It returns REQUEST_CHANGES, preserves two drained scopes and
six earlier passing denial probes, and produces a verified 41-artifact manifest,
SHA256 `77a26dcd92e8478e4926eb065ff08b966ddb2692597a9d3fc459560c0a775b80`.
No replacement reviewer or approval is inferred. The same P3 owner resumes from
`614329d` in its existing scope; new evidence goes to
`p3-binding-race-repair-evidence/`. P3 still blocks wave2 integration while
independent P5/P7 repairs continue.

### Committed cross-phase repairs awaiting review

The coordinator inspects P5 repair `7d9a345fa84c71bd16ec9d724dea3be89ce16273`
from `567978db` and P7 repair `a38c13ac7b8a1098755fd2cde926c75458d0a63a`
from `43d6c69`. Both worktrees are clean and remain isolated. Their same sole
xhigh reviewers are assigned read-only rechecks; neither repair is approved or
merged yet. This applies the standing cross-phase parallel rule while P3's
foundation repair continues. Root, one P3 owner and the two reviewers use the
four available harness slots. Workers do not delegate.

P5 changes only its two assigned client paths. It accepts numeric pagination
only for the verified repository's REST ID, records decisive quota headers before
optional body parsing, and preserves exponential backoff while imposing a
one-minute fallback. All 66 affected tests and the normal two-file compiler pass;
exact-path lint, format and diff checks pass. The 53-artifact manifest SHA256 is
`54456ffd357c4761938e8b9a28b74af67660e4ac76e09f5a6a7259d9e499724e` in
`/home/user/.cache/pi-project-teams-11b7e351/p5-transport-repair-evidence/`.
The coordinator verifies seven current, committed and archived source hashes,
five final check stamps, both exact patch and retained RED archive against its
own RED hashes, and 13 drained scopes. An initial compiler fixture error remains
preserved; final tests and checks ran after its correction. Transport evidence is
synthetic; real GitHub sync and snapshot guarantees remain unproved.

P7 changes exactly the four approved adapter/materializer source and test paths.
A private cleanup owner retains the created inode through held success receipts;
copy and publication remain interruptible. All 63 affected tests, normal four-file
compiler and exact-path checks pass. The byte-identical reviewer probes for copy,
rename and post-return cancellation now drain without releasing the held receipt.
Four causal mutations discriminate missing cleanup, publication tracking, handoff
ownership and inode guards. The 65-artifact JSON manifest SHA256 is
`e6b7cc92aa90e7afbc8f1b94dc16703390cf88908440349acf69d48c27901c88` in
`/home/user/.cache/pi-project-teams-11b7e351/p7-skills-repair-evidence/`.
The coordinator verifies every artifact, 14 current/committed/archive source
hashes, the exact four-file patch and 21 drained scopes. Ordinary factory bodies
and the public materialization service shape are unchanged. Real filesystem proof
supports this leaf; it does not establish full pi runtime or caller authorization.

P3's competing-binding probe motivates a short withdrawal/discovery transaction.
That variant passes the creation-race controls but cancellation after UPDATE rolls
back withdrawal: after purge and fresh same-key Auth, both the raw bearer and held
privileged guard succeed. Capturing the local batch Exit still exhibits the same
failure. Both failed controls remain recorded. The coordinator approves a small
private alternative: one exact provider/thread observation governs withdrawal;
nonempty observed rows trigger committed exact-subject revocation before binding
interpretation or later denial, with no enclosing rollback transaction. The public
one-argument discover interface remains unchanged. Actual observation-timing and
post-UPDATE cancellation controls must pass before the same P3 reviewer rechecks.
No P3 approval or integration is inferred from passing earlier cases.

### Restart checkpoint, 2026-09-30

The user asks to pause immediately and checkpoint everything for a Codex restart.
The coordinator interrupts the active P3 owner and P11 evidence-policy owner;
P5 review has completed and P7 review finishes with its formal verdict. There are
no worker-owned servers or model processes to stop. All 49 captured current task
scopes are checked drained, and no known task scope is running. No implementation
continues during the checkpoint. Preserve every branch, commit and unfinished file.

| Worktree under `/home/user/.cache/pi-project-teams-11b7e351/` | Exact HEAD                                 | State                                                 |
| ------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `wave2`                                                       | `26934dd5eea672be47ee7f537d210d30723f4464` | Clean, P2 only; combined gate waits for P3            |
| `p3-authorization`                                            | `2d3a4481b0d34c2f057ae833b40e8ca7de9b5e2b` | Clean, valid later failure blocks approval            |
| `p5-intake-transport`                                         | `7d9a345fa84c71bd16ec9d724dea3be89ce16273` | Clean, leaf review APPROVE; unmerged                  |
| `p7-skills-slice`                                             | `a38c13ac7b8a1098755fd2cde926c75458d0a63a` | Clean, leaf review REQUEST_CHANGES; unmerged          |
| `p11-evidence-leaf`                                           | `5fa23d306dc3a83140a8452c772fe7bf318b9127` | Two untracked assigned files; no checks/commit/review |

P5's same-reviewer repair report is
`review-p5-intake-transport/repair-7d9a345f/review.md`: 20-artifact manifest SHA256
`d84a7a1a7749782a4cf363946de1bd65f427f377950b07ef886a6375f5fc8689`.
It independently reruns 66 affected tests and seven full-consumer probe groups;
matching normal compiler evidence is inspected and reused. Approval covers the
bounded leaf only. It does not establish real GitHub snapshot/API behavior.

P7's same-reviewer repair report is
`review-p7-skills-slice/repair-a38c13ac/review.md`: 30-artifact JSON manifest SHA256
`6e07ba67bffbf1568f7c7323e3d07fa158ae5406f7a6770336587cc0abeb6e96`.
R1 passes; R2 remains: malformed custom output rejects before fallback ownership
is pinned, leaving its real matching-marker owned root behind. Root's exact replay
and revocation control are in `root-p7-custom-verification/`; no repair is started.
The same worker and reviewer must continue this piece when work resumes.

P3's clean new candidate passes the earlier observation-race and completed-UPDATE
cancellation controls, but the coordinator asks for the distinct interval between
nonempty SELECT observation and UPDATE acquiring the connection. The owner proves
it unsafe using the actual SQL client: a competing transaction owns the permit,
issuance requests UPDATE then is interrupted, and after owner release/purge/fresh
same-key Auth the raw bearer and held guard both succeed, with one callback.
`p3-binding-race-repair-evidence/observed-binding-queued-update-observations.json`
and the external probe/results retain this failure. The owner's narrow critical
section proposal is pending coordinator assessment, not an approved fix. Earlier
failed transaction variants and successful checks remain intact. No review approval
or combined-wave run is claimed for this candidate.

P11's independent slice has settled P2 schema prerequisites only; full P11 retains
P4–P5/P8–P10 dependencies. Exclusive scope is the two new evidence-policy files,
base `5fa23d3`, branch `pi-teams/p11-evidence-leaf`. Its self-contained brief is
`p11-evidence-leaf-preparation.txt`. The worker formerly assigned P5 implements
this new leaf only; completed P5 paths are no longer writable. Source is unverified.

The external `pause-20260930/` checkpoint records all five worktrees, their heads
and status, scope checks, and restart instructions. It archives and hashes both
untracked P11 source files. It also snapshots 136 files (790,022 bytes) of the
unsealed P3 repair evidence, with an inventory; this snapshot is preservation,
not a passing final evidence manifest. Existing reviewed evidence is left unchanged.
The main checkpoint commit covers only this record. No reset, history rewrite,
source integration, push, PR, browser/device use or live-state write occurs.

On resumption: read the complete current record and shared delivery contract first;
retain the user's waived development repair limits and safe cross-phase staffing
instructions. Verify the new session's actual concurrency. Inspect the saved P3
failure and assess its pending proposal before editing. Resume the P7 fallback
ordering repair and P11 leaf within their exclusive scopes when slots allow.
Reuse each existing piece's reviewer after repairs. Root must inspect complete
candidate evidence and check findings before merging. P3 approval precedes the
combined P2/P3 gate; reconcile any main advancement before local integration.
Real-runtime/platform/client gates and all 19 acceptance criteria remain open.

### Resumed candidate and review evidence (2026-10-01)

The dashboard reports current assignments; these records retain exact evidence
for approved leaves and repairs awaiting integration. No parent-step completion
or product acceptance is inferred from these bounded leaves.

- P3 root migration `7fd54f99de09d9d8c4fc0d88caa6717ea6f45fea` adds the retained,
  denial-only provider/thread fence. The final owner gate has 293 passing cases
  and normal server-entry compilation: 22.912 s, peak 3,986,886,656 bytes,
  4 GiB cap, zero swap/OOM. Repair `81a0ccf1643564a886e75dc44ba66ca3b4bf3b40`
  is sealed with 273 coordinator-verified artifacts, manifest
  `60f2fbed91ebcd734b698801dffb46a0569d12f22f15c2eae16201f1f05d7179`,
  34 exact source/archive matches and three exact patches. Same-reviewer recheck
  is running; earlier
  failed typing, causal and harness receipts remain distinct from passing gates.
- P5 repair `42663135fb672504f3a961b1cdfff232e927329d`: 58 producer artifacts,
  manifest `ee836a0705ef55dc0445b9d83f891cc2daeca91d8dcb9e13dc6f80db7d0ed1a2`.
  Same-reviewer APPROVE: 26 verified review artifacts, manifest
  `b2b4dd619d31ba09262d23ef4918d153530ff71f1fb5558ceb80edf87c5bf8ec`;
  79 tests, 17 original probes and six fresh boundary groups pass.
- P7 protocol `df620a4a106ce1bf3bd42e0c3417988ef6300ab6`: 83 verified producer
  artifacts, manifest `914d994278b9cfc6b70fd0632fb3af29ae88690e5ac3d90caf718a14a9c409e1`.
  Same-reviewer APPROVE: ten verified repair-review artifacts, manifest
  `f7cdb6e0ec0043336c088f2d055aae6249ec9e327bb36f618bd6fd28b148b464`;
  51 tests and 14 independent wire groups pass.
- P7 skills `4168f7896e3bb202c9d7e695480137a11b02168b`: 121 producer artifacts,
  manifest `0e7ade3fbf0e908027fc996c2f18482b394a4227a916e50ae82fa53c6b18cd7c`.
  Coordinator verifies 14 committed/current/archive matches and exact patch;
  46 focused/85 affected tests, original R1–R4 probes and final normal compiler
  pass. Same-reviewer APPROVE has 47 coordinator-verified artifacts, manifest
  `7e17703dfebc520d1b74021a78542c3580e06f1390f539150b0295592de5dc06`;
  85 affected tests, original probes and 22 independent boundary cases pass.
  Eight earlier bundles remain unchanged.
- P7 Linux process `7db547c7043a7c71bc5c7557c4fe73a0cd75c8bc`: 235 verified
  artifacts, seal `4b5ad7a509d1fe5c8d8ef98ba183d27a6aa31af0e957f7e3876b647fa707213e`;
  all three committed/current snapshots match. 19 portable/six actual Linux
  cases and two actual EOF proofs pass. Review is pending: accepted durations
  at least 60 seconds fail formatted-property comparison; a service-local
  PYTHONPATH control executes workspace startup code before ownership/START.
  Concurrent 1 MiB output and sixteen valid input chunks also deadlock in actual
  pipe writes, while receipt-ordered and small-output controls pass.
  No main merge or whole-runtime/packaging approval is claimed.
- P10 native adapter `2a88e791802fea4244e3368ae0ee67b3519b62b0`: 30 producer
  artifacts, manifest `02d3ca657c2485d4f9e505801ee6ce97efa8cf59b5c1d2460d862934792c6ea3`.
  Same-reviewer APPROVE: 34 verified artifacts, manifest
  `030f146ec88cb29f71916e9675e73beb283aefd31fee5cc6187e6d0e29e751ac`.
  18 actual Python/15 explicitly selected TS-contract cases pass. Ordinary
  no-Python discovery passes 14 cases and never counts as native proof;
  selected missing/wrong pins fail. All original seals remain unchanged.
- P4 read-only interface proposal: SHA
  `650e14f157d7b9aa7a17f83ebb7b02983e11e072d05bb108af509a3d8b7c6faa`.
  It changes no repository source and completes no dependency or acceptance gate.

### P3 approval and process review transition (2026-10-01)

P3 exact `81a0ccf1643564a886e75dc44ba66ca3b4bf3b40` receives APPROVE. Root independently verifies all 58 review artifacts against manifest `08d2431f742b1087028367e7fccfb6633b706c70a0e0c979bc1d9404bf530fbe`. Five review scopes and 47 producer scopes drain; 154 candidate checks and ten external causal/regression cases pass. Compiler is inspected rather than rerun. Real transports/clients and combined integration remain open.

P7 process exact `7db547c70` receives REQUEST_CHANGES for numeric duration normalization, ambient Python startup and blocking full-duplex input. Root verifies all 166 review artifacts against manifest `7233b51d6446e11f8009b5d5ff1e85e9efd1615d6c06a417cb9bdda962fe71b0`; root replay and three-file owner repairs remain next. The P5 read-only authority proposal is complete; no dependent implementation or parent completion is claimed.

### Combined wave2 gate in progress (2026-10-01)

Root merges approved P3 `81a0ccf16` into wave2 without conflicts. All four planned combined test groups pass. The first V3 run fails with JavaScript heap exhaustion at the wrapper default 128 MiB; the exact source is unchanged and the explicitly scoped 512 MiB heap rerun passes under 2 GiB and zero swap. That failed run is retained. Compilation and scoped formatting/lint/Knip follow; no main product merge or step completion is claimed.

Root independently replays all three P7 process findings using byte-identical external candidate copies: duration controls, synthetic protected-file bootstrap before START and simultaneous 1 MiB output/input deadlock all reproduce, with documented passing controls. All three captured outer units drain with zero OOM/swap. The existing process owner receives only the three-path repair scope; root compiler reservation remains exclusive.

### Foundation wave review starts (2026-10-01)

Combined candidate `8defdcf1241caf9c3276528e07da076573aa2673` reconciles saved main `59e8ae6c5`; only the plan changes after tested source `94d51f67`. Root seals 47 artifacts, manifest `e4e01165b6a3991c43c04f0b80ee0d7c8ebd369c52b038c9277029c20ddc8d37`: 65 contract, 34 storage, 80 authority and 115 affected cases pass; contracts/client-runtime/normal server compilation, formatting, diff and scoped Knip pass. Other changed-path lint passes; all-path lint retains five baseline failures. Root verifies the baseline error contexts byte-for-byte with the 604-line insertion offset. All 15 scopes drain. Both failed 128 MiB heap runs remain separately retained.

One fresh `review_wave2_foundation` xhigh reviewer checks this exact candidate read-only, with no implementer conversation. Independent P6 UI and P8 dispatch preparation owners inspect committed source only; both depend on unfinished phases and receive no implementation authorization. No browser/device or model proof runs.

### Catalog selection correction (2026-10-01)

The fourth combined test command selects a nonexistent catalog path under `mcp/toolkits/catalog/`; Vite silently ignores it. Its 115-test/ten-file PASS remains valid but excludes catalog. Root runs the actual `apps/server/src/mcp/McpCatalogGateway.test.ts` separately on unchanged `8defdcf12`: seven tests pass, bringing distinct combined coverage to 301. Evidence is retained separately in `wave2-catalog-supplement`; the original 47-entry wave manifest is immutable. No source change or compiler rerun.

### P6 preparation completes (2026-10-01)

The read-only P6 proposal is complete (`p6-human-workflow-preparation-evidence/interface-proposal.md`, SHA256 `4f25f69eeade4d5a56691ec325ab6e82589560a662d6041273dfd15ad49455d9`). The inferred client write already accepts the team RPC union; only its exported target alias needs alignment, not another transport. Required seams are cursor-preserving intake, coherent guided detail, approved intent builders, typed conflict/denial/unavailable/uncertain outcomes and draft retention. No implementation or client check is claimed. Its seat is released.

### P8 preparation and P7 repair checks complete (2026-10-01)

Read-only P8 proposal is complete (`p8-dispatch-preparation-evidence/interface-proposal.md`, SHA256 `fd3a6044a7bbe561b91c8f517f6c9486acc8a305292b2cc84b6d3c5be95c851a`). It identifies existing primitives and required durable stage/owner/drain/usage contracts; ordinary ambient Git and setup cannot be reused unchanged for managed execution. Root must settle controlled parent Git versus private metadata, preallocated ownership and restart reconciliation, setup policy and cumulative budget before dependent launch code. No implementation/proof is claimed; the seat is released.

P7 process owner reports 36 focused cases (19 portable, 17 actual Linux), three actual parent-EOF gates, seven discriminating causal controls, scoped lint/format and final normal compiler PASS. Ordinary discovery skips the 17 Linux cases and is not relabeled real proof. Compiler reservation is released; source freezes for the three-path commit/seal, root inspection and the same reviewer. These results do not complete P7.

### Combined foundation review approves (2026-10-01)

Fresh wave reviewer independently approves exact `8defdcf1241caf9c3276528e07da076573aa2673`, with no verified P2/P3 finding. Three new actual-SQL probes exercise post-fence binding conflict rollback, claimed outbox preservation through rebuild and typed gate receipt rollback/retry. Root verifies all 15 sealed review artifacts against manifest `b706091b73056223bad620d43e27dcccc36a6437fe43b835256b63112d8ef165`, all 56 reviewed source hashes and documentation-only main advancement. Review/proof scopes drain; 301 producer cases plus three independent probes pass. Baseline lint and all later runtime/client/product gates remain explicit. Root will reconcile latest saved documentation without source changes, then merge locally; no push/PR.

### P2/P3 land locally on main (2026-10-01)

Root reconciles saved main `580dd3b6c` into wave2 `04001e7578cf26a19842f400fa3be44f67b71cc8` with documentation-only changes; all 56 reviewed source hashes remain exact. No source/config/test/dependency/acceptance change requires repeated checks. Root locally merges wave2 into the main worktree at `1346f50af6f1361b0942fe1d42e636804e1ba9a0`; all 56 hashes match after landing and the tree is clean. P2 and P3 are now checked complete for their phase boundaries. Managed execution remains disabled; all 19 product acceptance criteria and later runtime/client/GitHub/platform gates remain open. No push or PR.

P7 process repair `f746e690371995e20c97fd31b4992fa912b987dc` is committed on exact `7db547c70`, three assigned paths, 263 sealed artifacts (`9d811744d6b6697b6833c54dc6c564957ce726e1e2ca68f884bfd10163811cda`). Root inspection and the same process reviewer are next. Full P4/P7 implementation branches will start from this resulting main product commit once root-owned interfaces/scopes are fixed.

### Wave3 begins after P2/P3 landing (2026-10-01)

Base main `1346f50af6f1361b0942fe1d42e636804e1ba9a0`. Root merges only approved
P4 policy, P7 protocol, P7 skills and repaired Linux process leaves into isolated
`pi-teams/wave3`, resulting in `6bb8db00947b59d8c9e5ef05f10c90074a35b20e`.
Root verifies all 231 final process-review artifacts, manifest
`90d54646ba65d034df367d8da929d10198118e07939928c68cc65e874e206753`, final seal
`0710c171a8b0ba1a1400d1d4ac47068015244f6aefa0194bb22cb9984fe3963e`.
The same reviewer approves exact `f746e690`; 54 independent tests, three actual
parent-EOF proofs, forced partial writes, two causal controls and 49 captured
review drains are recorded. Root previously verifies all 263 producer artifacts
and 47 inner drains. Full SDK/runtime, durable recovery and platforms remain open.

Root shared interface candidate `17871202a` passes 33 focused contract/persistence
tests, the normal contracts compiler, exact-path lint, format and whitespace.
Candidate public guided wiring is now being implemented alongside the core;
main still contains only the completed P1/P2/P3 source. P4 core and independent P7 protocol/process extensions
start in exclusive worktrees from exact `6bb8db009`, with Sol high owners, no
delegation, one owner per scope and focused measured checks. P4 owner requests
private claim/failure/repair transitions and non-code output applicability; root
retains those shared contract changes. No phase completion or live-client proof
is claimed by these preparatory integration merges.

### Active P4/P7 integration and verified runtime finding (2026-10-01)

Root contracts `eb71cf2b12ebf99f33bee19fad80615f2b50df46` pass 36 focused
contract/persistence cases, normal contracts compilation and exact-path lint and
formatting. Bounded report outputs, Human reminders, private repair claims and
immutable repair authorization provenance are included. P4 core tests currently
pass 112 applicable pure/lease cases and two new actual-SQL cases. Five older
repository cases fail because their shared fixture attempts the now-prohibited
raw managed claim; two receipt barriers time out. Root upgrades that fixture to
real guided approvals and the private typed claim, preserving those failures and
the duplicate/rollback protections. No full P4 gate or phase completion is claimed.

Fresh process-extension reviewer requests changes on exact `4d70b500`. Root
verifies all 154 review artifacts against manifest
`836a785ddeedafe07453cd0268d8d426ef968dc680bcc1b655f9fd992eb2a1f2` and confirms
P7-RUNTIME-R1: failed acquisition can stop an existing same-unit service before
capturing its InvocationID, using only its matching Description. The actual
Linux consumer fails one of two cases; the isolated omission control passes
both. The independent 57-case gate passes; all 41 review units drain, with zero
OOM/swap. The original owner repairs only its three files; the same reviewer
will recheck. This candidate remains outside wave3.

Protocol extension passes 90 focused tests, 13 independent byte-consumer groups
and 11 causal controls; its final normal compiler is queued first. Broker passes
118 affected tests, including 67 broker cases and a pinned-SDK synthetic native
two-call tool turn. These checks use no remote model call and do not satisfy
the required bounded real-runtime proof. Main product commit remains `1346f50af`;
no push or PR.

Protocol `644f8f51def4c5b5d98bacf9674515ac68657e22` and broker
`fe2ba479ed4fa7f34aef31f28c205b201ec2bcc0` are committed in clean exclusive
worktrees. Root verifies all 299 protocol and 155 broker artifacts and current
source against their exact commits. Manifest hashes are
`758b6256c9b2c5fd14b75cef5ffb469afca85066e86f2bc59252cd3eca7d74ee` and
`7cdd986c669bd7ef7770c564016e3d10b565e10e49e7e55ebbd16f624ca788a3`.
One fresh xhigh reviewer starts for each piece after both implementers release
their seats. Neither candidate is merged into wave3 before review passes.

P4's first full server-config compiler is killed at its 4 GiB cap, with no
diagnostics and a recorded OOM failure. The owner switches to the required
focused configuration extending the same normal server config, retaining strict
settings and plugins. This failed check is preserved and is not a passing gate.

### Next independent P7 slice: pinned-SDK child worker

Root allocates `pi-teams/p7-sdk-worker` from exact protocol candidate
`644f8f51def4c5b5d98bacf9674515ac68657e22`, in its own worktree. Its exclusive
scope is new `provider/pi/PiWorker.ts`, `PiWorker.test.ts` and narrowly named
`fixtures/p7-sdk-worker-*` fixtures. The settled private protocol is the interface;
its independent review remains open. This is a bounded P7 producer slice, not
completion of the protocol gate or full P7. Root retains parent process/broker
wiring, package/CLI exports, contracts, dependencies and durable callbacks.

Acceptance: actual pinned SDK initialization, prompt/tool/control/compaction and
resume receipts; exact bounded operation/protocol identities; no ambient
resources/extensions/credentials/network discovery; captured persistence and idle
barriers before success; no success after cancellation or failed accounting.
Use synthetic parent transport with the actual SDK, never a remote or local
model. Real network proof remains a separately bounded coordinator gate. One
Sol high worker implements without delegation, requests interface changes,
commits only assigned files and receives one independent review before integration.

### P4 combined candidate and runtime repair checks

Root creates isolated `pi-teams/p4-guided-candidate` from `eb71cf2b1`, applies
the core candidate as `b8b08c532`, and transfers only its own authenticated
wiring and shared fixture changes through retained scoped stash
`b01cba686ca7e1416dd9fcec6c9c9d90632dfca9`. Wave3 stays clean; the unreviewed
core is not merged into the integration wave. Two actual-SQL guided Gateway
cases pass. The first shared authorization fixture check fails before tests on
a missing ignored workspace dependency link; copying existing links, without an
install or source change, produces a passing focused authorization case.
Remaining affected suites, compiler and the sole full-P4 review still follow.

Process repair `3093c81dd27562f33ae8aa54e587749ddcfb06d7` changes only its two
assigned TS files. Root inspects the diff and verifies all 228 repair artifacts
against manifest `bfd5dde147f5757af9e5f9f9b9884ced9bff34db993c7562bd8f975d1fad3c1f`.
The owner records 60 passing Linux cases (38 actual), three actual EOF proofs,
normal focused compiler and scoped checks, with all 60 recorded units drained.
The same reviewer rechecks it; no approval or wave merge is inferred.

Protocol review on `644f8f51d` returns REQUEST_CHANGES. Root verifies 27 review
artifacts, manifest `6fd99dc60545f03e4f3ef228bcc0fbf66a74341528bdf5d039d4c7420ebee4a2`,
and both checked-byte traces: model requests bypass the active-tool restriction,
and a second native lifecycle can reuse the first lifecycle’s leaf. Positive
controls pass and the 90-case suite passes, so its missing cases are explicit.
The original owner repairs the same two-file scope; its same reviewer remains.

The actual pinned-SDK child worker proceeds independently. Root links existing
pinned SDK/pi-ai packages into ignored module resolution, with no install or
local model. Production runtime dependency registration and packaging remain
root-owned and unproved until their later checks. Full P4/P7 and all product
acceptance criteria remain open.

### Resume progress — P4 integration and P7 repair rechecks (2026-10-01)

P3 remains DONE on main `1346f50af`; no new P3 blocker. Root integrated core into an isolated P4 candidate, not the wave integration branch before review. Root authenticated wiring `f2f0d488e` passes all 21 authorization, five stream and two guided gateway tests (28/28); measured 2 GiB cap/zero swap, 1,063,325,696-byte peak, no OOM, captured check cgroup removed. Fixture extensions `dd26b819d` pass the same 28 cases with 871,546,880-byte peak and preserve historical read fixtures as read-only authorization evidence, never process-drain proof. Approval regression `d2b6c64a6` passes all three real-SQL guided gateway cases, including specification revision 2 approval after plan revision 1, rejected old specification/plan receipt replays without mutation, and one receipt on exact retry. Check peak 518,078,464 bytes, 2 GiB/zero swap, no OOM.

The first normal combined P4 compiler has no TypeScript errors but exits 1 on two Effect lifecycle diagnostics in Repository tests. Their independent owner combines provider layers correctly without suppressions; its focused normal compiler now passes. Root will repeat the affected combined check after test commits land in the isolated candidate. Gateway and Repository tests have distinct worker branches/worktrees at explicit base `f2f0d488e`; only their assigned test files are writable. Root shared fixture extension is an authorized dependency cherry-pick. This splits independent fixture adaptation without shared production edits.

P7 protocol `4e590177` has same-reviewer APPROVE and is merged into wave3 `90681d354`. Root inspected process repair `3215d26e` and verified all 190 repair artifacts against manifest SHA-256 `713e3b9aafa71420c405138403e560eb56379ceaec2c8b8c62b86880b21deef1`; original reviewer is rechecking startup interruption cleanup before scoped transport teardown. Root inspected broker repair `44166a927` and verified all 81 repair artifacts against manifest SHA-256 `f9f575505817167b41fe982d46267cc1c8b8a1d522cae8bf15a6985385142692`; original reviewer rechecks retained actual-stream compatibility and finish/accounting ordering. Neither repair is merged before APPROVE.

SDK owner found pinned 0.99.1 settings require `cacheWarming: "off"` and `images: { blockImages: true }`; the old synthetic example spellings do not establish dormant cache/image policy. Production worker uses the effective names; broker reviewer has this observation. Previously retained synthetic loopback checks remain brokerage evidence, not proof of those settings. No new model calls, local inference, browser/device use, push or PR creation.

### Combined P4 review starts (2026-10-01)

Candidate `0cabe9d411e47410f8759966c1c196d0fe9ed86e`, explicit base `eb71cf2b12ebf99f33bee19fad80615f2b50df46`, has 17 changed source/test files. Exact required V4 plus owned tests passed 200/200 across 11 files; final private-helper/import cleanup passed 45/45 affected cases. The final normal compiler passed with strict settings and Effect plugins retained, 4 GiB/zero swap, peak 2,208,014,336 bytes. Final scoped Knip files/dependencies passed (2 GiB/zero swap, peak 407,322,624 bytes), scoped lint/format passed; original baseline warnings remain, no suppressions. The earlier default-category Knip check found unrelated categories and an absent ignored web link setup; links were copied from the existing wave2 dependency setup. Its failed output is preserved and is not a passing check. Two final tool invocations lost completion receipts across input steering; inactive owned scopes and logs are retained as unconfirmed, and the normal compiler was repeated once with a captured successful receipt. All claimed final checks have source hashes matching the candidate and removed captured cgroups.

Root sealed 78 artifacts at `p4-guided-root-evidence/manifest-final.json`, manifest SHA-256 `d23250a6a98dfb8ec671901898d19d4284ea5dd2c43b398e243b832203b4dfa2`. Repository worker test commit `e37360598` and gateway worker test commit `09b76713b` are integrated only into this unreviewed candidate; their 37 and 30 artifacts are independently hash-verified. A first root verification parser incorrectly treated `{sha256, bytes}` records as plain hashes; corrected verification proves the original seals unchanged. No source/evidence was overwritten and no checks were rerun for that parser mistake. Sole fresh reviewer `review_p4_guided_combined` reads the full specification, shared contracts and combined source without implementer conversation history; independent failure/source/behavior checks remain pending.

Process reviewer independently APPROVED `3215d26e` after 61/61 actual Linux-gated cases and three original collision/cancellation controls, with all 41 review units and 91 captured PIDs drained. Root verified 137 review artifacts against manifest SHA-256 `b76780a98e8a4108bcc99a7664eeb4bd7920ac65d36d2d255c2ba0bff7d4ed09`. Full durable SQL activation/journal, SDK dispatch, runtime/platform and P8 gates remain open.

### Review findings and concurrent repairs (2026-10-01 03:30 UTC)

The full P4 reviewer reproduces public excess-authority stripping through both actual RPC payload and MCP parameter schemas, then real SQLite gateway mutation (revision 1 to 9). Clean decoded controls and direct gateway rejection pass. This is a missing rejection before mutation, not a Human privilege escalation or live transport proof. Resume and reassignment failures use trusted settled pure fixtures, not actual process-drain evidence. The stale-artifact report failure uses actual SQLite. Source inspection confirms the missing inherited planner/reviewer route in P4; implementation remains incomplete. The original source and sealed 78-artifact candidate evidence remain unchanged. Repairs start in a separate worktree at exact `0cabe9d411e47410f8759966c1c196d0fe9ed86e`, with one lifecycle owner and coordinator-owned contracts/authority.

Broker reviewer APPROVES exact `44166a92723dfd4990674e4c59e454ac6a943fd1`; coordinator verifies its 82 review artifacts, manifest SHA-256 `bf5a5ff1080c3da8ab22efc9f0fce2676af2e23d51837ade0c826788c636d284`. Process and broker repairs land only in wave3, now `23ee43812b3e8fe7a121ed6ede1872fbc6f97afe`. Main product remains `1346f50af`; the combined wave gate has not passed.

SDK child candidate `340c90e8b21e4dee1d488150410375f69714fc20` has 205 coordinator-verified artifacts, manifest SHA-256 `150ee502f6814924db4280ff6af08d60ed2a5ca1b38048dd4e2654bbf6d0d82e`. Its actual synthetic SDK proof makes zero API calls. Fresh review independently reproduces a local tool invocation after cancellation during asynchronous tool-start emission, and rejection of two distinct allowed tools because the pinned SDK defaults to parallel execution while the protocol permits one active tool. Formal review and causal controls precede owner repairs; no SDK approval or integration is claimed.

Independent parent-session runtime starts from exact wave3 `23ee43812`, exclusively owning new `PiSessionRuntime.ts`, its test and narrowly named fixtures. Mandatory current-authority, process ownership, native/control/terminal persistence and accounting callbacks remain parent-owned; durable SQL integration is still P8 work. Actual Linux byte-child fixtures are permitted, SDK child dependency is withheld until review approval, and no external model call is authorized.

### SDK approval and P4 repair boundaries (2026-10-01 03:58 UTC)

Same SDK reviewer APPROVES exact `4b16a6ed92cb7f3ab9d8745566669e54cff400d1`. Coordinator verifies all 85 repair artifacts (manifest SHA-256 `38afca3006c8ab5b9a29206dfea037ed74eeb5c17bf0c0a5f4cae5ab2331eb84`), four owned committed/current source hashes, and all 26 recheck artifacts (manifest SHA-256 `fc835342b2b2fb212910d8ebf0aff66f7590464719cf97a53081aac603aa5dcb`). Original probes pass with zero callbacks after accepted cancellation and two sequential exact native tool IDs; the reviewer independently replays six affected native scenarios. Twelve producer and three recheck scopes drain with zero swap/OOM. Root merges this approved slice only into wave3 `720cbb44bfbfeb95a8fa46c2c3a10e2df5853658`. Full P7 remains open.

P4 same reviewer formally requests five repairs; coordinator verifies all 30 review artifacts against immutable manifest SHA-256 `f053c5606c98a7c88045d8b2ad6b888879a7b61ccd80b87da57e29f96a5f0064`. A verification script initially mistook manifest metadata for artifact paths; correcting its parser verifies all artifacts without changing source or original seals. Root boundary branch `pi-teams/p4-guided-boundaries` starts at exact `0cabe9d41`. Commit `b44e3d87774cd62ac584c06d9d429e3ecc64a3ee` rejects excess authority at default guided/team codec boundaries while preserving legitimate legacy attribution. Focused contract checks pass 27 cases and actual schema-to-SQL/authorization checks pass 26; final hoisted decoder cleanup passes five gateway cases, normal server compilation and exact lint/format. Initial compiler test typing and ignored lint-plugin setup failures remain retained.

Inherited assignment contracts `bac0c9cd9d149b0da50b1d618bac963146b67317` and current-parent authority `7a07f28ca` are committed after focused checks. Final authority gate passes 119 cases, normal strict server compilation, lint, format and diff under measured caps with zero swap/OOM. Planning has one actual proposed-plan output; review requires the exact approved parent plan. Parent dependencies, controls, specification/plan hashes and approvals are rechecked. Derived repair assignments retain exact inherited metadata and canonical debits. These contracts permit core implementation but do not certify the missing complete path until its combined checks and same-reviewer gate pass.

Core repair passes 44 focused cases and continues its final compiler/V4 checks. Independent report-test worker owns only new `ProjectTeamGuidedReports.test.ts` on a separate explicit `0cabe9d41` base: 12 actual-SQL regression cases retain seven passes/five expected failures on the old implementation, with a sealed 27-artifact failing-proof manifest. Normalized evidence rows currently omit scope/link metadata; root is repairing additive migration/read/write handling before green report validation. Parent runtime passes 36 cases (31 actual Linux) and the final unchanged-config compiler; causal controls, commit and one fresh review follow. No new remote model calls, browser/device use, live-state writes, push or PR.

### Resume progress — report persistence and semantic repair (2026-10-01 04:16 UTC)

Root commits six-file evidence metadata repair `4a6019130a47085b1d07d7001e8d15bbde3bfbb8`: additive fork migration 021 backfills exact project/evidence event metadata; validated reads and writes retain scope hashes and output artifact links. Legacy rows retain optional absence. Upgrade, repeated migration, normalized rebuild, unchanged event log, scoped writes, empty links, duplicate receipts and corrupt-read denial pass; 99 affected tests and normal strict compiler pass with zero swap/OOM. Initial test fixture omissions and duplicate-response expectations were corrected; failed logs are retained. Scoped lint passes with one unchanged baseline Query warning. Independent report worker now passes all 12 real-SQL cases, including retained linkage after file-backed restart, plus 108 affected cases; final legal-request fixture cleanup and compiler reseal follow.

Core candidate `110d0f21d095d0766e83550ec17f17a97a5c7d6f` passes 140 affected cases and exact-byte normal compilation. Owner identifies and coordinator verifies a further canonical semantic-repair bypass through ordinary resume grants. Shared optional pending state distinguishes new transport-only history from pending semantic failures; legacy ambiguity fails closed for ordinary semantic work. Human resume must preserve the consumed grant and permit only the exact repair successor, with no counter reset. This repair remains active and is not approved.

Parent runtime `fa9fc693aa97b0d906c2f35caa1ac5391bb4203c` retains 566 hash-verified artifacts, manifest SHA-256 `448cf8d9c8ec70aa53354e17a727ec6da6f4d79de1f57a47f36e5813af0de9da`, three exact committed source hashes and sealed archive SHA-256 `26b05c1a776f08902a912f3a22fa8b3d440ae877afa73bc05730cb70f8cb0caa`. Sole fresh reviewer independently passes the same 36 cases and normal compiler, then reproduces terminal success while concurrent unresolved-control persistence remains active, with both honored and ignored cancellation. Formal REQUEST_CHANGES has one high-severity finding; all 160 review artifacts retain immutable manifest SHA-256 `552c13d400cac8d074946ea973b3b91d65a3921b3fda51bc8c719a9d5bad6b1f`. Root verifies source and observation. Repair moved to separate `pi-teams/p7-session-runtime-repair`, explicit base `fa9fc693a`; original worktree is restored and clean with exact original hashes. Root authorized repairs before the original review seal completed, briefly exposing WIP in that worktree; the move preserves all bytes and separates original evidence from repaired source. Reviewer records the mismatch explicitly and will recheck one exact new commit. No model calls, local inference, client automation, push or PR.

Bounded parallel P7 test assignment: `p7_sdk_worker_high` owns only new `PiSdkSessionRuntime.integration.test.ts` and `fixtures/p7-sdk-session-runtime-*`, on separate `pi-teams/p7-sdk-parent-tests`, explicit wave3 base `720cbb44b`. Approved SDK `4b16a6ed9` is available. Private parent `fa9fc693a` may be a provisional dependency only in this isolated test branch; its repaired exact commit and review must pass before test-slice integration. The slice must prove the actual pinned SDK subprocess composed with real Linux ownership, parent broker, native references, sequential tools, controls/accounting and drains using zero remote model calls. It owns no production entry, shared contracts, dependency, SQL or server wiring. This preparation neither completes P7 nor bypasses its pending parent review. Root retains production/package entry and integrated platform proof ownership.

Additional bounded P7 adapter slice: one exclusive owner may implement new `provider/pi/PiRuntimeEvents.ts` and its focused test, using approved worker protocol/SDK envelopes and existing provider event contracts. It translates bounded SDK message/delta/tool events into deterministic T3 IDs; it must not infer turn success, settlement, usage or approval from an SDK callback. Root retains final runtime receipts, durable usage, driver/adapter registration and all shared contracts. Fresh review and actual SDK-to-parent integration remain required before this leaf lands.

Report test `25becdf704d23125b28f744b4e8931be609925bb` is committed and all 73 GREEN artifacts verified against manifest SHA-256 `dab9e3d664c52c0c88c346a4d71c8367cfb4529c67985609169e8a3cbda6c952`. Root combines reviewed-source repair dependencies and reports only in isolated `pi-teams/p4-guided-final-candidate`; the original candidate remains untouched and no P4 merge is approved yet. Core semantic repair now passes 50 owned cases, including an exact Human exception debit beyond the automatic allowance, and final normal compiler; final affected checks and commit follow. Root shared exact exception helper `d163d86fef5a054407fac648d2a79a297602c06d` preserves only the exact frozen consumed exception's debited episode; other pending/exhausted history still denies semantic work. Its 104 affected cases, normal strict compiler and scoped checks pass; initial missing compiler argument was corrected and failed log retained.

Parent control repair `b5a3c3469a8e9cd388b752730a8af76fe2188b83` passes 41 cases, normal compiler and scoped checks. Coordinator verifies all 216 repair artifacts, manifest SHA-256 `023e3657c1ed6391aae68395143d6fdf1319b577c03fd8c7f8a3eee65d8c2fb9`, and all three current/committed source hashes. Same original reviewer independently rechecks this exact new commit; no approval or wave merge yet. New SDK-parent test and event-translation slices have distinct explicit wave3 bases, exclusive new files, and no shared production edits.

Same parent-runtime reviewer APPROVES exact `b5a3c3469a8e9cd388b752730a8af76fe2188b83`; coordinator verifies all 170 recheck artifacts, manifest SHA-256 `3554f3b4902bfd54bd79803f4fff0ad1953562840a23267a54f84a4ff4f68e74`. Independent 41-case suite, three original control probes and two added admission cases pass; all 44 review units, 126 PIDs and 44 cgroups drain. Matching strict compiler is inspected and reused because reviewed bytes are unchanged. Root merges only this approved private leaf into wave3 `61d90ac214cb982194eccd623c6a0ccc2e2db21d`, preserving the uncommitted root dependency changes. Actual SDK-parent integration, production entry/driver, durable P8 callbacks and package/platform gates remain open.

P4 core followup `b56d5fc3d399017f686ea7ac46a9548976074541` commits exactly the four assigned files. Coordinator inspects the two production diffs and verifies all four exact current/Git-object source hashes against all final compiler/test/lint/format captures. Final 207 affected tests and normal strict compiler pass; 33 captured scopes are inactive. Combined candidate `b34b59d8342c3a551774e7b007d4f6fe2dc065f2` has 28 changed files relative to original explicit `eb71cf2b1` base; complete affected tests, compiler and scoped checks are running. Original candidate, review and evidence remain untouched. P4 approval and wave merge are still pending.

P4 combined candidate `8c4450b4aef2ad5c1b786e7f27937fbeaccd9e45` passes 279/279 across 17 explicit affected files. First combined run passed 278/279; its sole failure expected only migration 20 in a production-upgrade receipt, while the new additive migration correctly also returned 21. Root changes that exact expectation without removing withdrawal/restart assertions; focused repository/migration checks pass 20/20, then all 279 pass. Original failed log remains. Final scoped style passes; normal strict compiler and scoped Knip seals follow on these exact bytes. No P4 review approval or main merge yet.

Final combined P4 evidence seals 39 artifacts and 28 exact committed/current source hashes at `p4-guided-final-evidence/manifest-final.json`, SHA-256 `46467c4e1a7add5446780f74078369e6d1a7fe0a13061fb8eec257fc1f8db6a5`. Final normal actual-server compiler retains strict/plugins, passes at 4 GiB/zero swap with 2,332,151,808-byte peak and no OOM. All 279 tests, exact-path lint/format/diff and scoped Knip files/dependencies pass; all captured check cgroups are removed. Same original P4 reviewer rechecks exact `8c4450b4a` independently, including all original findings and additional semantic-debit/Human-exception controls. No full-P4 approval or wave/main merge inferred.

### Bounded P7 event translator ready for review

Scoped candidate `a9298c20e2c00ca2e00815d619215769a58a4b86`, exact base `720cbb44bfbfeb95a8fa46c2c3a10e2df5853658`, changes only `PiRuntimeEvents.ts` and its test. Coordinator inspects source and verifies all 107 sealed artifacts (manifest SHA-256 `cc228aa8929951f6718f3b0346367cb318ef549e0adc3f2e5f8984b018bfa503`) and both current/Git-object hashes. Final 22 cases include the actual pinned SDK two-tool/text stream; normal strict compiler, exact-path lint with zero warnings, format and diff pass. All 16 captured scopes drain with zero OOM/swap. Initial failed checks and the mistaken 21-case test registration remain distinct. The sole fresh `review_p7_runtime_events` examines replay, lifecycle, failure and client compatibility independently. Root must feed all worker frames from sequence zero; current SDK-event-only callbacks are insufficient. Synthetic SDK message IDs do not establish native transcript history. No P7 completion or wave integration is claimed.

### Additional independent P7 implementation scopes

Approved explicit base `61d90ac214cb982194eccd623c6a0ccc2e2db21d` starts two separate worktrees. The former P4 core owner now exclusively owns new `PiWorkerHost.ts` and its test on `pi-teams/p7-worker-host`: bounded full-duplex SDK transport, backpressure, EOF/errors/cancellation and cleanup. Root retains trusted tool selection, npm/executable entry, packaging and server wiring. The parent-runtime owner exclusively extends `PiSessionRuntime.ts` and its test on `pi-teams/p7-session-observations`: an optional tracked `onWorkerFrame` callback after valid protocol acceptance, before dispatch, supplies the complete sequence-zero stream. Observers must not wait for later frames or the current HTTP request; callback failure or incomplete cancellation cannot produce success. Both scopes require focused checks and their prescribed independent review before integration. Original reviewed worktrees and seals remain unchanged.

The event reviewer independently reports likely transcript identity/order defects. Root replays the exact candidate against a byte-identical shared client consumer: repeated synthetic native IDs collapse two operations to one row, and raw JSON numeric order keys sort sequence 11 before 3/7. Error/aborted messages also show completed status, while active cancellation leaves no item terminal. Corrected external module links give a passing defect probe under 2 GiB/zero swap; its owned kernel scope drains. The initial link failure is retained. Candidate source stays frozen until the reviewer finishes actual SDK controls and seals formal findings. This is defect evidence, not a product pass.

### P4 approval and bounded wave completion

Same P4 reviewer APPROVES exact `8c4450b4aef2ad5c1b786e7f27937fbeaccd9e45`; coordinator verifies all 34 recheck artifacts, SHA-256 `a889328d405b3c9c820a5712e50b8366d829995a194db130951124e34d30cbd1`. All 26 independent original/new checks pass, including public nested codecs, inherited planner authorization, semantic/exception controls, stale replay, rollback and actual file-backed upgrade/two reopens/corrupt metadata denial. Five scopes drain with zero OOM/swap. Approved P4 merges into wave3 `4366093ea4cb807cb38d84bf2d0eef81864e58e7`, preserving the two root dependency edits. Main remains P1–P3.

To release P5 without waiting for full P7, the next bounded integration gate covers complete P4 and already approved private P7 leaves. Full P7 remains active, with actual driver/adapter, production entry, durable callbacks and packaging/platform gates unclaimed. Combined checks and one fresh wave reviewer must pass before this bounded wave lands on main. The next dependent implementation starts from that resulting main commit. This splits the existing runtime/lifecycle wave into reviewable milestones; it changes no phase dependencies or acceptance requirements.

Root runtime dependency candidate `a55cc0cc582baf7807ac044ca98cbcd984359a71`, clean isolated branch `pi-teams/p7-runtime-dependencies`, base `61d90ac21`, owns only server package, lock and Knip config. Both SDK packages are runtime-pinned 0.99.1 using existing snapshots; complete semantic YAML/JSON validation proves every other importer/package/snapshot unchanged. Filename-launched SDK fixtures are registered. Scoped Knip, format and diff pass; all owned scopes drain. All 31 artifacts are sealed, SHA-256 `871e48075f841d8ee2088b59470b0673ce88cf0b29cbd36a29055e896d7951ee`; sole fresh dependency reviewer is active. Npm/executable worker entry and real packaging remain open.

SDK-parent candidate `d5a9f44d25d65c0afd618399688b220dad5bbaab` owns only one new test and two fixtures, with approved b5 parent copied as a private dependency. Root verifies all 236 artifacts and three current/Git-object hashes; manifest `3cbcb59e8aabcc0658a261c4d1b26c766d8392950b78fd4ddc39787840495154`. Required Linux gate executes all 11 cases with zero skips: 22 actual native operations, 22 removed kernel cgroups and 66 absent captured PIDs, plus descendant drain. Portable/affected 108 cases and normal strict compiler/style pass. Interrupt 101 remains explicitly unresolved under held ACK; no native success or SQL claim. Its sole fresh review is active.

Observer extension `91b11091b70bbaf61deeb71bb9ec808e4979dc09` changes only two existing parent files; root verifies all 435 artifacts and both current/Git-object hashes, manifest `a2fc13e40f23ab5f172cfd73175d77de88691dd5c6b8079d218cbe3e7c1c5dd8`. The runtime adds five lines; 61 cases and normal strict/compiler/style pass. All 130 captured units, 376 PIDs and 130 cgroups drain. Same parent reviewer checks the extension; original fa9/b5 seals stay unchanged.

Event repair starts in separate `pi-teams/p7-runtime-events-repair` at frozen `a9298c20e`, owning the same two translator files. Root verifies all 106 reviewer artifacts (SHA-256 `a197f513b182f63ffd7b9db325b77832af40c8cb8a96b4e1bb06cd6de0a4e0fd`) and independently verifies causal client behavior before authorizing four repairs. Unsupported synthetic native IDs are omitted. Stable item order uses a required private, safe-integer operation ordinal allocated durably by root per provider/thread/agent, plus padded item-start sequence; actual allocator/wiring remain root integration prerequisites. Assistant completion waits for SDK stop reason; error/aborted and started-item cancellation remain visibly failed with bounded cancellation provenance. Turn/accounting/drain authority stays parent-owned. Same reviewer rechecks the exact repair; original source and seals remain frozen.

### Bounded wave gate and provider priority (2026-10-01)

Clean wave `25f7bd6ae67d627ef8b16faff7e4c8ce9ee1d373` includes complete reviewed P4 and approved private Pi protocol/process/broker/SDK/parent/skills/runtime-dependency leaves. Exact combined gate: 656/656 tests across 25 files, zero skips; normal strict server compiler with Effect plugins, 42 roots, 4 GiB/zero swap, peak 2,817,794,048 bytes; exact 50-path format and scoped Knip files/dependencies pass. Scoped lint passes with 14 retained baseline warnings and zero errors. Root verifies all 50 current/Git-object hashes and all 28 P4 approved source hashes. Captured drain audit checks 149 owned units, 394 PIDs and 145 cgroups, all drained. Evidence is in `wave3-bounded-final-evidence`; fresh wave review remains mandatory before main integration.

Retained failed compiler output traces missing ignored dependency links, repaired by linking existing ignored dependencies without source/config changes. Initial test selection accidentally requested an invalid filename and omitted the policy test; it is explicitly incomplete (578 passes) and superseded by the corrected 656-case gate. Neither failed/incomplete run is counted as final proof.

Root verifies all 135 event repair artifacts, 281 observer review artifacts, 98 SDK-parent review artifacts plus its sealed drain-status supplement, and 17 host review artifacts. Event same-reviewer recheck is active. Observer and SDK-parent are APPROVED, held outside the frozen bounded wave; root-owned Knip registration of the two new SDK-parent fixtures remains required. Root independently reproduces host R1 premature-success close, R2 undestroyed owned output and R3 mutable operation alias with actual pinned SDK and paired controls, zero model calls. Its owner repairs only two assigned files from frozen `49037a489` in a separate branch; the same reviewer will recheck.

User priority: focus on Pi, OpenCode, Claude and Codex. Avoid substantial work specific to other providers unless necessary to preserve a shared path changed by this implementation. No ordinary-provider removal or silent team fallback is authorized.

### Private Pi interfaces and parallel driver/adapter work

Root candidate `46e4ebbcb8d5592c0a6a91c10d2588e7425a2513`, base bounded wave `25f7bd6ae`, adds only `PiManagedRuntime.ts` and its test. Four strict-config cases, normal strict/Effect-plugin compiler and exact lint/format pass. The private per-instance service has no production Layer or activation; missing durable producers still block before acquisition. Configuration accepts only optional parent-owned agent directory, with no secret, model or approval fields. Its 56 artifacts are sealed at `p7-runtime-port-evidence/manifest.json`, SHA-256 `77d5b3a9c15e7e6b8c538653573c0c1c3664a4de2c2a97bd6b9ca1bb8fcc9387`; sole fresh review is active.

Independent Sol-high workers own only `Drivers/PiDriver.ts/.test.ts` and `Layers/PiAdapter.ts/.test.ts` in separate worktrees at exact `46e4ebbcb`. Frozen adapter factory consumes `{instanceId, runtime}`. Driver factory injects that adapter factory, allowing isolated compilation without importing the other worker's unfinished file. Root later registers the composed factory. Adapter alone owns stopAll finalization; driver does not duplicate it. Runtime-mode input will be added by root as an exact-match assertion against the frozen SQL intent before effects, through the same-port-reviewer extension. Explicit approval/sandbox overrides are unsupported. Start/resume initialization remains correlated to durable root intent; a failed read never permits a reset. These mapping tests use explicit private-port fakes and cannot satisfy the actual runtime/SQL/package gate.

Event same reviewer APPROVES `082405770`; root verifies all 65 recheck artifacts, SHA-256 `e55e263427dba29cefac861166610210dddcea184f9d96d52779e669246caa34`. Root inspects host repair `59b549fa6`, verifies all 41 artifacts (`f56b7e82…`) and starts its same-reviewer recheck. Bounded wave `25f7bd6ae` stays frozen; its fresh reviewer verifies all 489 artifacts and 50 current/Git-object source hashes and independently checks combined behavior.

### P4 main integration and parallel Pi checks (2026-10-01)

Fresh bounded-wave reviewer APPROVES exact `25f7bd6ae67d627ef8b16faff7e4c8ce9ee1d373`. Root verifies all 155 sealed review artifacts, manifest SHA-256 `004e1c2ddfa7199c5a27a17e05240c1858306a376adf81f7241e94e4a0e14028`. Independent actual SQLite authority/replay, paused result authorization, omission control, Linux ownership/callback drains, repair provenance and ordinary Claude/Codex/OpenCode materialization total 16 distinct causal groups. Matching combined 656-case, strict compiler, style and Knip seals remain applicable. All producer/review captured units, PIDs and cgroups drain. Root reconciles plan-only main advances and merges locally at `30ca5e52883619da4d338666dcbe64bca39d09f0`; all 50 reviewed product files match and the prior plan is preserved exactly. P4 is complete; all product acceptance criteria remain open.

Root verifies all 117 original driver, 78 canonical-identity repair, 135 adapter and 32 private-port assertion review artifacts. Driver `4d642070dbb8e245c67987e9e33550f4a34d18c6` has 22 passing cases and strict compilation; adapter `430cee8d8b2d80ea418f6e4f64ed1648ecfb3fa6` has 18. Each receives its sole fresh xhigh reviewer. Host R4 is independently reproduced: valid `emitClose:false` resources finish destruction while cleanup waits forever for an event they intentionally omit. The original owner proposes a supported-stream repair; frozen source/evidence remain unchanged. Native-session reader owns only two new files at approved port `713ad91f5`; its Linux descriptor-bound reads cannot replace root current authorization or committed-leaf authority. Native configuration inspection finds saved CommandCode auth metadata but no current catalogue and a Cursor default; no model/API call or credential value is collected. Trusted route resolution remains explicit P7 work.

### Additional bounded parallel policies and current route metadata

Two Sol-high workers start from main `0d23a9d840753dc6d9b86df3ca040c58fa66e406` with exclusive new two-file scopes: P9 `ProjectTeamMailboxPolicy.ts/.test.ts` and P10 `memory/ProjectMemoryHitPolicy.ts/.test.ts`. They implement bounded private record policies only. Root retains SQL, authentication, durable target/extraction receipts, wakes, migrations and wiring. P8/P9 prerequisites and actual memory integration remain open; these leaves cannot complete P9/P10. Native configuration uses another exclusive two-file worktree on that same base.

Root obtains current public CommandCode catalogue metadata under a 256 MiB, zero-swap owned check. Python's request receives HTTP 403; one retry using the official extension's Node fetch path receives HTTP 200. Selected Ling Flash advertises context 262144 and chat-completions routing, with no advertised price, output ceiling or reasoning fields. Evidence is in `p7-current-catalogue-evidence`; public catalogue SHA-256 `2948c5de5abd9d92a54e20c02660d9f359f4487df9112f461585d3d764bbd81a`. Two metadata GETs, zero credential reads or inference calls; both captured scopes drain. Managed output budget remains an explicit policy limit, not invented catalogue metadata or a zero-cost claim. No native settings/defaults are changed.

### 2026-10-01 08:09 UTC — P5 review repairs and independent P6 work

The sole state reviewer rejects unchanged `7d912a096` on P5-STATE-R1–R3. Root verifies its 47-artifact manifest `7ba084adf2c33259e5c6fe3a50cce0f635e24b78719091d32dfe09052f246484` and copies its probes to a separate root evidence directory. All 12 groups replay against the unchanged candidate with actual SQLite: nine safety controls and three reproduced defects. The copied check drains its captured unit/three PIDs, zero OOM/swap. Original source and seals remain untouched. Root owns the central SQL identity repair based `8e6a8c69c`; the original atomic reviewer remains the same reviewer. Root then repairs the two state invariants and returns to the existing state reviewer. Migration work does not advance on unsafe interfaces.

Native configuration repair `54ea6f5d4` is APPROVED by its same reviewer. Root verifies all 44 recheck artifacts, manifest `8f3859c0e9fe673b9cb5113833ee69090470fc8860d588f822677c82c437f611`. Its old precompiler test snapshot is explicitly superseded; final compiler/style evidence matches final source chronology, and the fresh final suite passes. This certifies the private Linux helper only.

To use independent capacity while root repairs shared SQL authority, Sol-high `p4_guided_core_high` implements only new `guidedTaskDraft.ts` and its test in `pi-teams/p6-guided-draft-policy`, exact base `f0412ccfd`. The helper preserves scoped drafts, exact uncertain submissions and revision comparison through settled P4 command shapes. No future P5 interfaces, browser run or full P6 completion is claimed. Root retains all shared contracts, client APIs, migrations, dependencies and server wiring.

### 2026-10-01 08:24 UTC — P5 repairs frozen for same-reviewer checks

Root commits central repair `c4cbe0a1de2fb9c448bccc3a8acf894a86e4d555` on base `8e6a8c69c`: ambient SQL identity mismatch is rejected before preparation. Its actual two-client regression is red before repair and green afterward; 74/74 affected cases and normal strict/Effect compiler pass. The existing repository lint warning is retained. Sixty artifacts are sealed at `b0edbf219f0c9c4da5c0bdea58a77861bb2efa0d55637339e97a7d7a8eef7943`; seven captured units/21 PIDs drain. The same atomic reviewer is rechecking.

Root state repair `e8246403821cdd815f5f6c8915279882167bac33` follows an isolated copy of that prerequisite as `11791c0a2`. Only two state files change: immutable SQL-key match, failed-epoch binding denial and supplied-client transaction presence inside preparation. Three actual SQLite regressions and the existing cases pass, 19/19 zero skips. Final installed-version Effect encoder, normal strict/Effect compiler, lint and format pass; compiler peak 775,671,808 bytes. One fixture-only inline encoder warning and zero lint errors are the actual result; a separate external clarification corrects the sealed handoff's erroneous 0/0 wording without rewriting it. Older test-fixture/compiler/format-instrument failures remain explicitly superseded. The 133-artifact seal is `5141c279de73f4e585f8e22f7e89576baf1c953fae0879d0e9092110182c5fc7`; its same state reviewer is active. Nothing is merged into a wave/main before review.

Independent Sol-high stdio owner `p7_driver_adapter_interfaces` starts `pi-teams/p7-worker-stdio` at approved host `2051a2797`, owning only new `PiWorkerStdio.ts`, its test and `fixtures/p7-worker-stdio-child.mjs`. The borrowed process stdio globals require native owned wrapper close/cleanup receipts; actual Node stdout reports emitClose false. Root retains CLI entries, trusted SDK metadata, registration, packaging/dependencies and Knip registration. Captured actual child/pipe proofs must remain distinct from synthetic controls. P6 draft work continues separately.
