Github Tracked: false
Status: planned
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

## Acceptance criteria

- [ ] AC-1: A title-only Draft can be created and later refined without a thread or provider.
- [ ] AC-2: A task cannot become Specified without all required specification fields and criteria.
- [ ] AC-3: A task cannot become Ready while required preparation or dependencies remain unresolved.
- [ ] AC-4: Claiming an eligible task creates one leased attempt and derives In progress.
- [ ] AC-5: A second active claim is rejected unless an authorized takeover occurs.
- [ ] AC-6: Lease expiry retains checkpoints and leaves a Failed, reclaimable task.
- [ ] AC-7: Recoverable failures can be reclaimed; manual-triage failures cannot.
- [ ] AC-8: Blocking records a structured reason, resolver, attention, and references.
- [ ] AC-9: Resolving a blocker or failure returns the task to its policy-derived state.
- [ ] AC-10: Completion rejects unsatisfied required criterion IDs.
- [ ] AC-11: An authorized waiver records actor, reason, time, evidence, and spec revision.
- [ ] AC-12: Protected specification revision is explicit and invalidates affected results.
- [ ] AC-13: Reopening a completed task retains completion history and chooses an eligible state.
- [ ] AC-14: A canceled task cannot reopen; continuation needs a linked new task.
- [ ] AC-15: Blocking cycles are rejected with the discovered cycle path.
- [ ] AC-16: Canceling an unresolved dependency blocks, rather than satisfies, dependents.
- [ ] AC-17: Knowledge survives deletion of its source thread, session, worktree, or attempt.
- [ ] AC-18: Accepted decisions cannot be edited in place and are replaced only by attributed supersession.
- [ ] AC-19: Promotion to knowledge is explicit and preserves its source.
- [ ] AC-20: Compact, standard, and detailed briefings obey bounds and report omissions.
- [ ] AC-21: Structured briefing works when narrative generation is absent, stale, disabled, or timed out.
- [ ] AC-22: Narratives are derived, source-cited, and record model, time, and source revision.
- [ ] AC-23: FTS search supports filters and returns bounded snippets, provenance, revisions, and IDs.
- [ ] AC-24: Activity is excluded from ordinary search unless requested.
- [ ] AC-25: UI and MCP mutations use equivalent commands, events, and receipts.
- [ ] AC-26: Reusing an idempotency key does not duplicate an effect.
- [ ] AC-27: Stale writes return current revision and changed fields without overwriting data.
- [ ] AC-28: Agents need required authority for cancel, takeover, protected revisions, decisions, and external writes.
- [ ] AC-29: Discovered work is an unclaimed linked Draft and does not alter active-task scope.
- [ ] AC-30: Web and desktop Work support the first-release workflow.
- [ ] AC-31: Mobile safely handles projects with work records without unsupported controls.
- [ ] AC-32: Needs-you remains durable until its reason resolves, regardless of notification state.
- [ ] AC-33: Disconnected clients show stale cached reads and cannot queue authoritative writes.
- [ ] AC-34: Project moves preserve identity and records; relinking is explicit.
- [ ] AC-35: High-confidence secrets are rejected and redacted consistently.
- [ ] AC-36: Disabling preserves records while hiding mutations and envelopes; re-enabling restores access.
- [ ] AC-37: JSON export preserves version, identity, revisions, relationships, provenance, selected history, and redaction.
- [ ] AC-38: Markdown export is non-authoritative and cannot be imported as state.
- [ ] AC-39: Projections and FTS rebuild from events without changing IDs or revisions.
- [ ] AC-40: Representative scale meets search, briefing, and ordinary-operation latency targets.
- [ ] AC-41: Websocket updates are bounded deltas, never full project collections.
- [ ] AC-42: Older compatible clients preserve or safely render additive kinds, reasons, states, and fields.
- [ ] AC-43: External adapters can only create attributed observations and policy-permitted commands.
- [ ] AC-44: Permanent deletion is explicitly confirmed and never deletes linked external data.

## Plan

- [ ] P1: `packages/contracts/src/projectWork.ts`, `packages/contracts/src/orchestration.ts`,
      `packages/contracts/src/settings.ts`, and `packages/contracts/src/externalNotifications.ts`:
      define IDs, forward-compatible read records, closed write intents, actor/source
      attribution, lifecycle values, deltas, export schemas, and the opt-in setting.
- [ ] P2: `apps/server/src/persistence/Migrations/fork/009_ProjectWork.ts`,
      `apps/server/src/persistence/Migrations.ts`, event-store layers, and command receipts:
      add normalized work projections, FTS5, one-active-attempt indexing, receipt
      fingerprints/actors/results, rebuild support, and filtered aggregate event reads.
- [ ] P3: `apps/server/src/projectWork/ProjectWorkDecider.ts` and
      `ProjectWorkPolicy.ts`: implement explicit task, relationship, criterion, evidence,
      duplicate, approval, assignment, watcher, and protected-specification commands;
      derive readiness, action availability, attention, and claimability server-side.
- [ ] P4: `apps/server/src/projectWork/ProjectWorkLeaseReactor.ts`,
      `ProjectWorkProjection.ts`, and `ProjectWorkQuery.ts`: add fenced attempts,
      leases, checkpoints, expiry/reclaim/takeover, stable activity, comments, knowledge
      lifecycles, decision acceptance/rejection/supersession, and explicit promotion.
- [ ] P5: `apps/server/src/projectWork/ProjectWorkSearch.ts`, `ProjectWorkBriefing.ts`,
      and `ProjectWorkNarrative.ts`: implement bounded FTS5 search, relationship
      traversal, deterministic compact/standard/detailed briefings, cached asynchronous
      narratives, invalidation, pagination, and scale fixtures.
- [ ] P6: `apps/server/src/auth/RpcAuthorization.ts`, `EnvironmentAuth.ts`, and
      `apps/server/src/mcp/toolkits/projectWork/`: derive durable user/agent identities,
      bind single-use human approvals to protected agent intents, and expose every
      read/write intent through shared RPC and MCP handlers.
- [ ] P7: `apps/server/src/provider/Services/ProviderService.ts`, provider adapters,
      `RuntimeInstructions.ts`, and `apps/server/src/textGeneration/`: inject a bounded
      workspace envelope at session start and generate derived narratives through the
      configured text-generation fallback without delaying structured reads.
- [ ] P8: `apps/server/src/projectWork/ProjectWorkAttentionReactor.ts`,
      `ProjectWorkContentGuard.ts`, `ProjectWorkExport.ts`, and notification dispatch:
      persist attention/seen state, emit best-effort deduplicated notifications, reject
      and redact secrets, scrub derived caches after a newly known secret, and export
      versioned JSON or visibly non-authoritative Markdown.
- [ ] P9: `packages/client-runtime/src/project-work/`,
      `apps/web/src/routes/work.$environmentId.$projectId.tsx`, and
      `apps/web/src/components/work/`: add Overview, Tasks, and Knowledge with bounded
      subscriptions, virtualized/paginated lists, progressive lifecycle forms, stale
      disconnected reads, and disabled authoritative writes.
- [ ] P10: `apps/web/src/components/Sidebar.tsx`, command palette, keybindings, and
      `settings.projects.tsx`: add Work entry points, opt-in, relink, archive, export,
      and permanent-delete confirmation. Update mobile orchestration compatibility only;
      do not expose mobile management controls.
- [ ] P11: `apps/server/src/orchestration/`, deletion services, and project settings:
      isolate work events from legacy subscriptions, add capability-negotiated work
      streams with cursor-safe skipped-event replay, explicit archive/restore, project
      tombstones, permanent local deletion, relocation checks, backup/rebuild coverage,
      rollout behavior, and focused user documentation.

## Validation

- [ ] `vp test run packages/contracts/src/projectWork.test.ts packages/contracts/src/orchestration.test.ts packages/contracts/src/settings.test.ts packages/contracts/src/externalNotifications.test.ts`
- [ ] `vp test run apps/server/src/persistence/Migrations/fork/009_ProjectWork.test.ts apps/server/src/persistence/Migrations.forkSequence.test.ts`
- [ ] `vp test run apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts apps/server/src/orchestration/LiveStreamBudget.test.ts`
- [ ] `vp test run apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/auth/EnvironmentAuth.test.ts`
- [ ] `vp test run apps/server/src/projectWork`
- [ ] `vp test run apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/mcp/toolkits/projectWork`
- [ ] `vp test run apps/server/src/provider/Layers/ProviderService.test.ts apps/server/src/provider/RuntimeInstructions.test.ts apps/server/src/textGeneration/TextGeneration.test.ts`
- [ ] `vp test run packages/client-runtime/src/project-work`
- [ ] `vp test run --project unit apps/web/src/components/work apps/web/src/components/CommandPalette.logic.test.ts apps/web/src/keybindings.test.ts`
- [ ] `vp test run apps/mobile/src/state/projectWorkCompatibility.test.ts`
- [ ] `vp test bench apps/server/src/projectWork/ProjectWorkPerformance.bench.ts`
- [ ] `vp run --filter @t3tools/contracts typecheck && vp run --filter t3 typecheck && vp run --filter @t3tools/client-runtime typecheck && vp run --filter @t3tools/web typecheck && vp run --filter @t3tools/mobile typecheck`

## Outcome

No code changed and no validation command ran while planning. The work record includes
the fresh GPT-6-ASTRA review corrections: durable actor identity; receipt fingerprint
and actor checks; approval-bound protected agent operations; complete decision/note
commands; attempt fencing; bounded readiness cascades; legacy-event isolation; secret
cache invalidation; and tombstoned deletion of all local project-owned content.

Residual implementation risks are lease holders continuing filesystem or external work
after T3 fences their writes, false positives or gaps in secret detection, broad
dependency fan-out, and irreversible permanent deletion. Disable the environment flag
to roll back exposure while retaining records; do not down-migrate or discard event
history.
