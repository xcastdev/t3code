Github Tracked: false
Status: completed
Github Issue: none

# Durable project work and knowledge

## Goal

Give each environment-local project durable tasks and knowledge that survive threads,
providers, worktrees, and path moves. The server remains the authoritative writer;
web/desktop and MCP use the same intent commands; structured briefings and full-text
search give new sessions bounded current context without making generated prose
authoritative.

## Scope

- In: opt-in project records for tasks, attempts, checkpoints, criteria, evidence,
  comments, knowledge, relationships, attention, briefings, FTS5 search, MCP, web/
  desktop Work, exports, relocation, archive, and confirmed permanent deletion.
- In: provider session envelopes, derived narratives, best-effort notifications,
  projection rebuilding, bounded websocket deltas, and mobile protocol compatibility.
- Out: mobile editing UI, GitHub sync or writes, semantic search, offline writes,
  automatic ingestion or claiming, parallel attempts, per-record ACLs, cloud sync,
  general import, resource reservations, and deferred record types.

## Lifecycle decisions

- A protected specification changes only through an approved protected-revision
  intent. It carries the new specification, the affected result IDs, actor/source
  attribution, and a bound human approval. The resulting revision explicitly
  invalidates those results, then derives the task back to Specified or Ready.
- Resolving a failure records its reason and evidence, closes the failed attempt,
  clears the active failure, and returns the task to its policy-derived state.
  Recoverable and lease-expired failures may return automatically; manual-triage
  failures require an authorized human resolution.

## Acceptance criteria

- [x] AC-1: A title-only Draft can be created and later refined without a thread or provider.
- [x] AC-2: A task cannot become Specified without all required specification fields and criteria.
- [x] AC-3: A task cannot become Ready while required preparation or dependencies remain unresolved.
- [x] AC-4: Claiming an eligible task creates one leased attempt and derives In progress.
- [x] AC-5: A second active claim is rejected unless an authorized takeover occurs.
- [x] AC-6: Lease expiry retains checkpoints and leaves a Failed, reclaimable task.
- [x] AC-7: Recoverable failures can be reclaimed; manual-triage failures cannot.
- [x] AC-8: Blocking records a structured reason, resolver, attention, and references.
- [x] AC-9: Resolving a blocker or failure returns the task to its policy-derived state.
- [x] AC-10: Completion rejects unsatisfied required criterion IDs.
- [x] AC-11: An authorized waiver records actor, reason, time, evidence, and spec revision.
- [x] AC-12: Protected specification revision is explicit and invalidates affected results.
- [x] AC-13: Reopening a completed task retains completion history and chooses an eligible state.
- [x] AC-14: A canceled task cannot reopen; continuation needs a linked new task.
- [x] AC-15: Blocking cycles are rejected with the discovered cycle path.
- [x] AC-16: Canceling an unresolved dependency blocks, rather than satisfies, dependents.
- [x] AC-17: Knowledge survives deletion of its source thread, session, worktree, or attempt.
- [x] AC-18: Accepted decisions cannot be edited in place and are replaced only by attributed supersession.
- [x] AC-19: Promotion to knowledge is explicit and preserves its source.
- [x] AC-20: Compact, standard, and detailed briefings obey bounds and report omissions.
- [x] AC-21: Structured briefing works when narrative generation is absent, stale, disabled, or timed out.
- [x] AC-22: Narratives are derived, source-cited, and record model, time, and source revision.
- [x] AC-23: FTS search supports filters and returns bounded snippets, provenance, revisions, and IDs.
- [x] AC-24: Activity is excluded from ordinary search unless requested.
- [x] AC-25: UI and MCP mutations use equivalent commands, events, and receipts.
- [x] AC-26: Reusing an idempotency key does not duplicate an effect.
- [x] AC-27: Stale writes return current revision and changed fields without overwriting data.
- [x] AC-28: Agents need required authority for cancel, takeover, protected revisions, decisions, and external writes.
- [x] AC-29: Discovered work is an unclaimed linked Draft and does not alter active-task scope.
- [x] AC-30: Web and desktop Work support the first-release workflow.
- [x] AC-31: Mobile safely handles projects with work records without unsupported controls.
- [x] AC-32: Needs-you remains durable until its reason resolves, regardless of notification state.
- [x] AC-33: Disconnected clients show stale cached reads and cannot queue authoritative writes.
- [x] AC-34: Project moves preserve identity and records; relinking is explicit.
- [x] AC-35: High-confidence secrets are rejected and redacted consistently.
- [x] AC-36: Disabling preserves records while hiding mutations and envelopes; re-enabling restores access.
- [x] AC-37: JSON export preserves version, identity, revisions, relationships, provenance, selected history, and redaction.
- [x] AC-38: Markdown export is non-authoritative and cannot be imported as state.
- [x] AC-39: Projections and FTS rebuild from events without changing IDs or revisions.
- [x] AC-40: Representative scale meets search, briefing, and ordinary-operation latency targets.
- [x] AC-41: Websocket updates are bounded deltas, never full project collections.
- [x] AC-42: Older compatible clients preserve or safely render additive kinds, reasons, states, and fields.
- [x] AC-43: External adapters can only create attributed observations and policy-permitted commands.
- [x] AC-44: Permanent deletion is explicitly confirmed and never deletes linked external data.

## Plan

- [x] P1: `packages/contracts/src/projectWork.ts`, `packages/contracts/src/orchestration.ts`,
      `packages/contracts/src/settings.ts`, and `packages/contracts/src/externalNotifications.ts`:
      define IDs, forward-compatible read records, closed write intents, actor/source
      attribution, lifecycle values, deltas, export schemas, and the opt-in setting.
- [x] P2: `apps/server/src/persistence/Migrations/fork/009_ProjectWork.ts`,
      `apps/server/src/persistence/Migrations.ts`, event-store layers, and command receipts:
      add normalized work projections, FTS5, one-active-attempt indexing, receipt
      fingerprints/actors/results, rebuild support, and filtered aggregate event reads.
- [x] P3: `apps/server/src/projectWork/ProjectWorkDecider.ts` and
      `ProjectWorkPolicy.ts`: implement explicit task, relationship, criterion, evidence,
      duplicate, approval, assignment, watcher, and protected-specification commands;
      derive readiness, action availability, attention, and claimability server-side.
- [x] P4: `apps/server/src/projectWork/ProjectWorkLeaseReactor.ts`,
      `ProjectWorkProjection.ts`, and `ProjectWorkQuery.ts`: add fenced attempts,
      leases, checkpoints, expiry/reclaim/takeover, stable activity, comments, knowledge
      lifecycles, decision acceptance/rejection/supersession, and explicit promotion.
- [x] P5: `apps/server/src/projectWork/ProjectWorkSearch.ts`, `ProjectWorkBriefing.ts`,
      and `ProjectWorkNarrative.ts`: implement bounded FTS5 search, relationship
      traversal, deterministic compact/standard/detailed briefings, cached asynchronous
      narratives, invalidation, pagination, and scale fixtures.
- [x] P6: `apps/server/src/auth/RpcAuthorization.ts`, `EnvironmentAuth.ts`, and
      `apps/server/src/mcp/toolkits/projectWork/`: derive durable user/agent identities,
      bind single-use human approvals to protected agent intents, and expose every
      read/write intent through shared RPC and MCP handlers.
- [x] P7: `apps/server/src/provider/Services/ProviderService.ts`, provider adapters,
      `RuntimeInstructions.ts`, and `apps/server/src/textGeneration/`: inject a bounded
      workspace envelope at session start and generate derived narratives through the
      configured text-generation fallback without delaying structured reads.
- [x] P8: `apps/server/src/projectWork/ProjectWorkAttentionReactor.ts`,
      `ProjectWorkContentGuard.ts`, `ProjectWorkExport.ts`, and notification dispatch:
      persist attention/seen state, emit best-effort deduplicated notifications, reject
      and redact secrets, scrub derived caches after a newly known secret, and export
      versioned JSON or visibly non-authoritative Markdown.
- [x] P9: `packages/client-runtime/src/project-work/`,
      `apps/web/src/routes/work.$environmentId.$projectId.tsx`, and
      `apps/web/src/components/work/`: add Overview, Tasks, and Knowledge with bounded
      subscriptions, virtualized/paginated lists, progressive lifecycle forms, stale
      disconnected reads, and disabled authoritative writes.
- [x] P10: `apps/web/src/components/Sidebar.tsx`, command palette, keybindings, and
      `settings.projects.tsx`: add Work entry points, opt-in, relink, archive, export,
      and permanent-delete confirmation. Update mobile orchestration compatibility only;
      do not expose mobile management controls.
- [x] P11: `apps/server/src/orchestration/`, deletion services, and project settings:
      isolate work events from legacy subscriptions, add capability-negotiated work
      streams with cursor-safe skipped-event replay, explicit archive/restore, project
      tombstones, permanent local deletion, relocation checks, backup/rebuild coverage,
      rollout behavior, and focused user documentation.

## Validation

- [x] `vp test run packages/contracts/src/projectWork.test.ts packages/contracts/src/orchestration.test.ts packages/contracts/src/settings.test.ts` (197 tests passed; no `externalNotifications.test.ts` exists)
- [x] `vp run --filter @t3tools/contracts typecheck` (exit 0; existing TS3770xx suggestions only)
- [x] `vp run --filter t3 typecheck` (exit 0; existing TS3770xx suggestions only)
- [x] `git diff --check` (passed)
- [x] Contract validation completed through the final scoped contract suite (no `externalNotifications.test.ts` exists).
- [x] `vp test run apps/server/src/persistence/Migrations/fork/009_ProjectWork.test.ts apps/server/src/persistence/Migrations.forkSequence.test.ts` (both focused files passed; 2 tests passed)
- [x] `vp test run apps/server/src/persistence/Layers/OrchestrationCommandReceipts.test.ts apps/server/src/persistence/Layers/OrchestrationEventStore.test.ts` (9 tests passed)
- [x] `vp run --filter t3 typecheck` (exit 0; existing TS3770xx suggestion diagnostics only)
- [x] `git diff --check` (passed)
- [x] Final core project-work/client-runtime suite passed (86 tests).
- [x] Final web workflows/contracts/MCP/mobile compatibility suite passed (194 tests).
- [x] Explicit repository/runtime/lease/stream/gateway/export/decider regression gate passed (45 tests).
- [x] Auth/provider/legacy orchestration regression suite passed (226 tests).
- [x] Migrations/receipts/event store/settings/notifications suite passed (26 tests).
- [x] Lifecycle/MCP HTTP/contracts/settings suite passed (210 tests).
- [x] Corrected web Work suite command, run from the repository root without the invalid `--project unit` flag, passed.
- [x] Representative benchmark passed with 2,000 tasks, 8,000 knowledge records, and 10,000 initial events: warm p95 search 15.82 ms, detailed briefing 27.30 ms, ordinary repository write 70.81 ms.
- [x] Contracts, server, client-runtime, web, and mobile typechecks exited 0.
- [x] Final `git diff --check` passed.

## Final outcome

P1-P11 and AC-1 through AC-44 are complete. The final independent validation found
no remaining related implementation issues. Durable project work now uses one
authoritative event log with transactional normalized and FTS projections, bounded
cursor-safe clients, production lease expiry, shared RPC/MCP/provider policy,
revision-consistent redacted exports, and first-release web/desktop workflows with
mobile compatibility. Full rebuild remains the projection oracle, and representative
search, detailed briefing, and ordinary-write latency remain below their required
100/50/100 ms warm-p95 limits.

No browser validation was run because repository policy requires explicit approval.
No commit or pull request was created.

## Implementation history

Implemented P1's contract layer in `packages/contracts/src/projectWork.ts`, including
branded IDs, strict write schemas, forward-compatible read variants that preserve
unknown discriminator strings and nested attribution, bounded deltas, validated JSON
export collections, explicitly non-authoritative Markdown export, and closed write
intent schemas. Exported the contracts, kept project-work commands out of the legacy
orchestration unions, retained the server-local `projectWorkEnabled` opt-in, and added
forward-compatible durable-work context to external notifications. Added focused
contract and legacy-union tests in `packages/contracts/src/projectWork.test.ts` and
`packages/contracts/src/orchestration.test.ts`.

Changed files: `packages/contracts/src/projectWork.ts`,
`packages/contracts/src/projectWork.test.ts`, `packages/contracts/src/orchestration.test.ts`,
`packages/contracts/src/settings.ts`, `packages/contracts/src/externalNotifications.ts`,
`packages/contracts/src/index.ts`, and this plan record. `orchestration.ts` has no net
diff because its legacy unions correctly exclude project-work commands.

Exact results: the focused contract command passed 197 tests; contracts typecheck and
server typecheck both exited 0 with only existing TS3770xx suggestion diagnostics;
`git diff --check` passed.

P2 is complete; P3-P11 remain unimplemented. The saved plan still requires server
deciders/reactors, authorization, MCP, providers, web/mobile compatibility, deletion
behavior, and broader validation before durable project work is usable.

P2 implementation adds fork migration 009 and registers it as the next independent
fork sequence entry. It creates normalized task, attempt, criterion, evidence,
relationship, blocker, knowledge, decision, comment, attention, and rebuild-cursor
projections; a project-scoped FTS5 table; supporting lookup indexes; and a partial
unique index that permits only one leased/running attempt per task. The same migration
adds nullable receipt fingerprint, actor/source, and structured result columns for
backward-compatible upgrades. Receipt persistence round-trips the new fields while
omitting null legacy values. Receipt reads keep SQL NULL distinct from a JSON `null`
result, decode non-null JSON strings effectfully, and map malformed JSON through the
typed persistence SQL error. Aggregate replay now accepts an optional event-type
filter, applying it in both event and replay-stats queries before payload decoding.

Changed files for P2: `apps/server/src/persistence/Migrations/fork/009_ProjectWork.ts`,
`apps/server/src/persistence/Migrations/fork/009_ProjectWork.test.ts`,
`apps/server/src/persistence/Migrations.ts`,
`apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts`,
`apps/server/src/persistence/Layers/OrchestrationCommandReceipts.test.ts`,
`apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts`,
`apps/server/src/persistence/Layers/OrchestrationEventStore.ts`,
`apps/server/src/persistence/Layers/OrchestrationEventStore.test.ts`, and
`apps/server/src/persistence/Services/OrchestrationEventStore.ts`.

Exact P2 results: the migration and fork-sequence plus receipt/event-store grouped
command passed (13 tests), including receipt cases for SQL NULL, JSON `null`, object,
and malformed JSON typed failure; server typecheck exited 0 with only existing
TS3770xx suggestions, and `git diff --check` passed. P2 does not add project-
work event decoding or projector command flows; those remain scoped to later plan
items. The rebuild cursor schema is intentionally storage-only until the P4 projector
owns replay and row materialization.

P3 is complete in `apps/server/src/projectWork/ProjectWorkDecider.ts` and
`ProjectWorkPolicy.ts`. The pure decider covers task lifecycle, relationships and
cycle paths, criteria, evidence, duplicates, approvals, assignment, watchers,
protected specifications, and explicit typed rejection of deferred failure,
knowledge, decision, comment, and attention commands. The reducer uses
command-supplied timestamps, deep-copies mutable records, preserves existing event
history, and records typed result invalidations for protected specification
revisions. Protected revisions carry a closed additive command contract with a
server-recomputed canonical full-payload fingerprint bound to the specification,
criterion snapshots, result IDs, approval, and request actor/source; P6 identity and
single-use approval checks remain outside this slice. Protected criterion mutation,
foreign aggregate ownership, duplicate IDs, stale specification revisions, and
direct protected specification writes are rejected. Policy availability is derived
from current state rather than client hints, including deferred failure and
lease-expired claimability.

Changed files for P3: `apps/server/src/projectWork/ProjectWorkDecider.ts`,
`apps/server/src/projectWork/ProjectWorkPolicy.ts`,
`apps/server/src/projectWork/ProjectWorkDecider.test.ts`,
`packages/contracts/src/projectWork.ts`, `packages/contracts/src/projectWork.test.ts`,
and this plan record.

Exact P3 results: `vp test run apps/server/src/projectWork/ProjectWorkDecider.test.ts
packages/contracts/src/projectWork.test.ts packages/contracts/src/orchestration.test.ts
packages/contracts/src/settings.test.ts` passed (211 tests); `vp fmt --check
apps/server/src/projectWork/ProjectWorkDecider.ts apps/server/src/projectWork/ProjectWorkPolicy.ts
apps/server/src/projectWork/ProjectWorkDecider.test.ts packages/contracts/src/projectWork.ts
packages/contracts/src/projectWork.test.ts` passed; `vp run --filter
@t3tools/contracts typecheck` and `vp run --filter t3 typecheck` exited 0 with only
existing TS3770xx suggestion diagnostics; and `git diff --check` passed.
`vp run --filter @t3tools/contracts typecheck` exited 0;
`vp run --filter t3 typecheck` exited 0; and `git diff --check` passed. P4 is
validated below; P5-P11 remain intentionally unimplemented.

P4 repair validation: `vp test run apps/server/src/projectWork/*.test.ts
apps/server/src/persistence/Migrations/fork/009_ProjectWork.test.ts` passed (24 tests).
The tests cover the authoritative event log, idempotent command replay, transaction
rollback when projection persistence fails, worker lease fencing, durable failure
resolution and retained attempt history, relationship unlink/rebuild, and end-to-end
knowledge, decision, comment, and attention intents. `vp run --filter t3 typecheck`
exited 0; `vp run --filter @t3tools/contracts typecheck` exited 0 with only the
repository's existing suggestion diagnostics; `vp fmt --check` passed for the 14
changed P4 files; and `git diff --check` passed. P4 now uses migration 009's
`project_work_events` as the sole append-only project-work log, with one decider
reducer and a repository transaction that replays uncapped history, appends ordered
events, projects normalized rows, and exposes results only after commit. Lease
operations are repository-backed when durable services are provided, and active-attempt
queries filter project/task/state before applying their limit. P5-P11 remain
unimplemented.

P4 second-repair validation: the production `ProjectWorkProjection` surface now
contains only read state and `rebuild(projectId)`. Rebuild reads and decodes the
authoritative `project_work_events` rows inside one transaction, validates payload and
stored aggregate metadata, reduces normalized rows, and updates the sequence cursor and
generation without appending to or clearing the event log. Pure projection reducer
helpers remain available only for pure tests; the repository is the sole project-work
event append path. Decision supersession now requires command attribution, rejects
missing direct-decider attribution, derives `replacement.supersedesDecisionId` from
the command (while accepting a matching value and rejecting conflicts), and preserves
or inherits replacement attribution as specified. Lease integration tests now run
migrations with `ProjectWorkRepositoryLive` and use fresh reactors over the shared SQL
database to verify restart claims/checkpoints, active-claim fencing, expiry, and
checkpoint retention. Exact results: the combined contract/server project-work and
migration focus passed 8 files and 226 tests; `vp fmt --check` passed for 10 affected
files; both `@t3tools/contracts` and `t3` typechecks exited 0 (only existing suggestion
diagnostics); and `git diff --check` passed. Residual risk is limited to the broader
P5-P11 work and their unrun suites.

P5 is complete in `apps/server/src/projectWork/ProjectWorkSearch.ts`,
`ProjectWorkBriefing.ts`, and `ProjectWorkNarrative.ts`. Search uses the project-scoped
FTS5 index with literalized bounded queries, record/state/task/source filters, activity
opt-in, bounded snippets, deterministic ordering, total-count pagination, provenance,
revision metadata, and cycle-safe bounded relationship traversal. Projection persistence
now refreshes FTS atomically with normalized rows, and the search service exposes an
explicit transactional rebuild for upgraded or fixture databases. Briefings are
deterministic and narrative-independent at compact, standard, and detailed bounds;
omission reasons identify task, knowledge, page, relationship, activity, and character
limits. Narratives are optional derived values with source-revision citations, model/time
metadata, bounded output, asynchronous scheduling, cache reuse, and epoch-fenced
invalidation so stale in-flight generation cannot repopulate the cache.

Changed files for P5: `apps/server/src/projectWork/ProjectWorkSearch.ts`,
`ProjectWorkSearch.test.ts`, `ProjectWorkBriefing.ts`, `ProjectWorkBriefing.test.ts`,
`ProjectWorkNarrative.ts`, `ProjectWorkNarrative.test.ts`,
`ProjectWorkPerformance.bench.ts`, `ProjectWorkProjection.ts`, and this plan record.

Exact P5 results: `vp test run apps/server/src/projectWork` passed 33 tests across 7
files; the scoped benchmark passed over 10,000 FTS rows at 20.93 ms mean and over 2,000
projected tasks at 0.46 ms mean; targeted `vp lint` and `vp fmt --check` passed;
`vp run --filter t3 typecheck` exited 0 with only the repository's existing TS3770xx
suggestion diagnostics; and `git diff --check` passed. P6-P11 remain intentionally
unimplemented.

P5 repair tightened query handling to tokenize Unicode letters, marks, and numbers at
the same punctuation boundaries as the unicode61 index. A trimmed `*` now takes an
explicit project-scoped match-all path without FTS `MATCH`, with deterministic ordering
and bounded body snippets. Briefing omission metadata now reports capped criteria,
attempt, blocker, and attention pages. Narrative cache keys include source revision,
text, ordered included IDs, and omission reasons; global clear epochs fence direct
generation, and unique pending tokens keep stale request cleanup from removing a
replacement. The added SQLite and deferred regressions pass with the focused suite;
targeted lint and formatting pass; both `t3` and `@t3tools/contracts` typechecks exit
0 with only existing suggestion diagnostics; and `git diff --check` passes. P6-P11
remain untouched.

P6 was implemented and independently reviewed through the permitted two automatic
repair attempts, but remains blocked. The final review reproduced three unresolved
defects: human protected specification revisions replace the fingerprint-bound
attribution time without recomputing the protected fingerprint; gateway writes expose
the complete reduced project state through RPC and MCP; and duplicate commands rebuild
their response from current state rather than returning the originally committed,
bounded receipt result. The focused final validation command passed 32 tests across
five files, but those paths were not covered by the gateway's three existing tests.
No further automatic repair is allowed by the delivery contract. Resume by addressing
the cited defects in `ProjectWorkGateway.ts` and `ProjectWorkRepository.ts`, adding
their regression coverage, then restart validation.
