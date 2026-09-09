# Chat Activity Visibility — STATE

title: Chat Activity Visibility
slug: chat-activity-visibility
status: completed
delivery_mode: local
evidence_tier: local-standard
current_phase: complete — awaiting independent validation
created_at: 2026-09-08T23:18:56-05:00
updated_at: 2026-09-08T23:52:10-05:00
started_at: 2026-09-08T23:36:00-05:00
validation_result: pass
revalidation_result: pass
summary: Per-turn provenance (model, effort, work counts) plus enriched folds, three-column tool rows, tool-aware working status, and follow-the-end-on-send scrolling
tracking_issue: null
worktree: /home/user/.local/share/t3/worktrees/t3code/t3code-3afad540
branch: t3code/improve-chat-activity-visibility
baseline_revision: 8f7b05edb30e2620bfacf5a6c4b31c8ec7576845
candidate_revision: 8f7b05edb+worktree:821266e83e11f74766850451eb4601dbe1503c8a4a150e12176a14b300d5ff87
declared_scope_digest: e5d193e463d281c7806e40d38c60b2ab29100d3013c3fb22ad410c080a641aac
changed_files_digest: 821266e83e11f74766850451eb4601dbe1503c8a4a150e12176a14b300d5ff87
implementer_task: direct primary implementation
implementer_session: null
implementer_model: claude-opus-5[1m] (coordinator) + dispatched implementer subagents, same model
validator_task: a5f6bbc78fd428fcb (validate-wrapper, mode=validate)
validator_session: fresh dispatch, independent context
validator_model: claude-opus-5[1m]
revalidator_task: N/A (local-standard tier; revalidation optional)
revalidator_session: N/A (local-standard tier; revalidation optional)
revalidator_model: N/A (local-standard tier; revalidation optional)
spec_path: docs/plans/in_progress/chat-activity-visibility/SPEC.md
plan_path: docs/plans/in_progress/chat-activity-visibility/PLAN.md
todo_path: docs/plans/in_progress/chat-activity-visibility/TODO.md
ledger_path: docs/plans/in_progress/chat-activity-visibility/LEDGER.md

## Lifecycle

## Declared Scope

Anticipated paths. The digest is recorded at P0 execution, not pre-filled.

**Server**

- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Drivers/CodexDriver.ts` — scope amendment, approved
  2026-09-08; see `LEDGER.md#p2-ac-01`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — corrected
  target; `projector.ts` never writes `projection_turns`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/persistence/{Layers,Services}/ProjectionTurns.ts` — repository
  layer widened by the six new migration columns
- `apps/server/src/orchestration/decider.ts` — passes the additive optional
  `turnProvenance` through (3 lines)
- `apps/server/src/persistence/Migrations/044_ProjectionTurnsProvenance.ts` and
  its registration in `Migrations.ts`

**Contracts / shared**

- `packages/contracts/src/orchestration.ts`
- `packages/shared` — new work-classification module

**Web**

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- `apps/web/src/components/chat/timelineScrollAnchoring.ts`
- `apps/web/src/session-logic.ts`

**Docs**

- `docs/user/`, `docs/internals/`

## User Decisions

Recorded because they narrow scope and would otherwise look like omissions.

| Decision                  | Choice                                                                                                                                       | Date       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Per-turn model provenance | Stamp the turn (no backfill)                                                                                                                 | 2026-09-08 |
| Scope                     | Turn summary + footer, working state, tool row polish                                                                                        | 2026-09-08 |
| Tokens / cost per turn    | Out of scope                                                                                                                                 | 2026-09-08 |
| Fold label                | Keep `Worked for {duration}` and lead with it                                                                                                | 2026-09-08 |
| Effort display            | Always show a concrete level; never the literal `default`; omit only when absent                                                             | 2026-09-08 |
| Tool row duration         | Far right, right-aligned                                                                                                                     | 2026-09-08 |
| Commands                  | Separate category from other tool calls                                                                                                      | 2026-09-08 |
| Subfolds                  | Same vocabulary, no duration                                                                                                                 | 2026-09-08 |
| Reasoning/thinking rows   | Deferred to a future effort                                                                                                                  | 2026-09-08 |
| Scroll                    | Follow the end immediately on send (terminal model, not anchored reading model); remove the superseded anchoring machinery in the same phase | 2026-09-08 |
| Fold counts               | Stamped on the turn at settle                                                                                                                | 2026-09-08 |
| Mobile                    | Deferred to a follow-up                                                                                                                      | 2026-09-08 |
| Delivery                  | Local, single worktree, no PR split                                                                                                          | 2026-09-08 |

## Open Questions

None blocking. All design decisions are resolved.

## Notes

The review that produced this plan corrected an earlier draft on two structural
points: the client has no per-turn record to stamp (only `latestTurn` and
`checkpoints[]`, and interrupted turns rarely have checkpoints), and effort
cannot be resolved in the pure projector. Both are addressed by P2–P5.

Reasoning is dropped for every provider at `ProviderRuntimeIngestion.ts:1743`,
not just Codex. When reasoning rows are picked up later, the subfold structure
absorbs them without redesign.

All live-database inspection during planning was strictly read-only.
