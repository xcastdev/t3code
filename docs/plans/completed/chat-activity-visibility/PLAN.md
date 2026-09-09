# Chat Activity Visibility — Implementation Plan

## Goal

Make a chat turn report what it did, what ran it, and what it is doing right
now — by carrying per-turn provenance that adapters already compute, enriching
the existing fold, and following the stream on send.

## Metadata

- **deliveryMode:** local (single worktree, no PR split, no tracked issue)
- **evidenceTier:** standard
- **tier rationale:** touches the event-sourced ingestion write path and a
  database migration, but adds only optional fields and no auth, secret,
  network, or destructive surface
- **lifecycle state:** planned
- **current phase:** P0
- **worktree:** `/home/user/.local/share/t3/worktrees/t3code/t3code-3afad540`
- **branch:** `t3code/improve-chat-activity-visibility`
- **baseline revision:** `8f7b05edb30e2620bfacf5a6c4b31c8ec7576845` (clean tree)

## Verified Facts

Every design decision below rests on these, confirmed against source and the
live database rather than assumed.

| Fact                                                       | Evidence                                                                                                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fold label discards all work detail                        | `MessagesTimeline.logic.ts:634`                                                                                                                                                         |
| Timeline already groups by `turnId` and folds              | `MessagesTimeline.logic.ts:546-581`, `deriveTurnFolds:520`                                                                                                                              |
| Thread-level `modelSelection` is overwritten each turn     | `orchestration.ts:441`, `projector.ts:466`                                                                                                                                              |
| `TurnStartedPayload` already has optional `model`/`effort` | `providerRuntime.ts:361`                                                                                                                                                                |
| Ingestion never reads `payload.model`/`payload.effort`     | grep over `ProviderRuntimeIngestion.ts` returns nothing                                                                                                                                 |
| `turn.started` collapses into `thread.session.set`         | `ProviderRuntimeIngestion.ts:1720`; `OrchestrationSession` has no model field (`orchestration.ts:350`)                                                                                  |
| OpenCode already reports `{model, effort}`                 | `OpenCodeAdapter.ts:4090`                                                                                                                                                               |
| Claude emits `{}` on the main `sendTurn` path              | `ClaudeAdapter.ts:2931`; `{model}` only at `:4583`                                                                                                                                      |
| Claude computes resolved effort                            | `ClaudeAdapter.ts:4266`, `getEffectiveClaudeAgentEffort:383`                                                                                                                            |
| Codex emits `{}` despite computing effort                  | `CodexAdapter.ts:1054` vs `:1837`                                                                                                                                                       |
| Codex default effort is **not** adapter-reachable          | remote `model/list`, mapped `Layers/CodexProvider.ts:115`; injected via `Drivers/CodexDriver.ts` instead — see `LEDGER.md#p2-ac-01`                                                     |
| Effort option id differs per provider                      | Claude `"effort"` (`:1240`,`:4252`); Codex `"reasoningEffort"` (`:1837`, `settings.ts:738`)                                                                                             |
| Client sees only one turn per thread                       | `listLatestTurnRows`, `ProjectionSnapshotQuery.ts:693`                                                                                                                                  |
| `projection_turns` already stores per-turn state/timing    | live DB schema                                                                                                                                                                          |
| Interrupted turns rarely have checkpoints                  | live DB: interrupted/`missing`+none = 38, interrupted/`ready` = 3                                                                                                                       |
| Checkpoints carry `additions`/`deletions`                  | `orchestration.ts:362-367`                                                                                                                                                              |
| Checkpoint diffs are not truncated                         | `CheckpointStore.test.ts:118`; max 634 files observed                                                                                                                                   |
| 555 ready checkpoints have zero files                      | live DB — read-only turns omit "Changed Files" naturally                                                                                                                                |
| Activities capped at 500 per thread                        | in-memory `projector.ts:806`; SQL `LIMIT` `ProjectionSnapshotQuery.ts:76` at `:1049`/`:1413`                                                                                            |
| Activity ageing is a known problem                         | `CodexAdapter.ts:540` comment                                                                                                                                                           |
| Tool calls carry a stable `toolCallId`                     | inside `payload_json`, not a column — written `ProviderRuntimeIngestion.ts:811-812`; 3 calls produced 12 activity rows                                                                  |
| `itemType` classifies tools                                | live DB `tool.completed`: `command_execution` 26605, `dynamic_tool_call` 4641, `file_change` 4383, `collab_agent_tool_call` 2079, `mcp_tool_call` 259, `web_search` 175, `image_view` 3 |
| `toolName` is unreliable                                   | null for 21833 of 26607 `command_execution` rows                                                                                                                                        |
| Tool name already exists separately                        | `toolTitle` → `toolWorkEntryHeading` (`MessagesTimeline.tsx:2265`), discarded by `??` at `:2399`                                                                                        |
| Merge loses the tool start time                            | `mergeDerivedWorkLogEntries` spreads `...next` over `...previous` (`session-logic.ts:1166-1168`)                                                                                        |
| Subagent grouping exists                                   | `agentSpawn.agentTaskIds` (`session-logic.ts:1072`)                                                                                                                                     |
| Interrupted styling only checks `latestTurn`               | `MessagesTimeline.logic.ts:613`                                                                                                                                                         |
| Scroll already has three modes                             | `timelineScrollAnchoring.ts:1`; transitions at `ChatView.tsx:3848/3914/4117/4128/4189/5757`                                                                                             |
| Break-out paths are complete                               | wheel `:3983`, touch `:3990`, scrollbar `:3999`, keyboard `:4015`                                                                                                                       |
| Anchoring disables end-follow while installed              | `MessagesTimeline.tsx:622`, `ChatView.tsx:1119-1126`                                                                                                                                    |
| Reasoning is dropped for all providers                     | `ProviderRuntimeIngestion.ts:1743` filters to `assistant_text`                                                                                                                          |
| `deriveTurnFolds` has no direct tests                      | 0 matches in the 1702-line `MessagesTimeline.logic.test.ts`                                                                                                                             |

## AC Trace Table

| AC    | Title                         | Primary Phase | Supporting |
| ----- | ----------------------------- | ------------- | ---------- |
| AC-13 | Follow end on send            | P1            | —          |
| AC-01 | Adapter model/effort          | P2            | P3         |
| AC-02 | Ingestion forwarding          | P3            | —          |
| AC-03 | Projector stamp + counts      | P4            | P3         |
| AC-04 | `turns[]` on the wire         | P5            | P4         |
| AC-05 | Stamped vs derived counts     | P6            | P4, P5     |
| AC-06 | Diff suppression              | P6            | —          |
| AC-07 | Subfolds                      | P6            | —          |
| AC-09 | Interrupted history           | P6            | P5         |
| AC-11 | Tool duration + shared ticker | P6            | P7, P8     |
| AC-08 | Turn footer                   | P7            | P5         |
| AC-10 | Tool rows                     | P7            | P6         |
| AC-12 | Working status                | P8            | —          |

## Phases

### P0 — Baseline

Record baseline revision and clean-tree state. No code changes.

### P1 — Scroll: follow end on send (AC-13)

Ships first: independent of everything else, small, immediately visible.

**Behavior change.** Today a sent message jumps to the top of the viewport with
reserved blank space below it, and the reply fills that space downward
(Claude.ai/ChatGPT reading model). After this phase the sent message stays at
the bottom and the timeline sticks to the newest line as the agent works
(terminal model). T3 already abandons anchoring the moment a tool runs
(`shouldReleaseTimelineAnchorForToolActivity`), which is evidence the anchored
model does not suit tool-driven agent work.

The anchoring machinery is removed rather than left in place because `:5757` is
its only entrance: once it no longer runs, three guarded effects become
permanent no-ops, `anchoredEndSpace` is permanently `undefined`, and
`shouldReleaseTimelineAnchorForToolActivity` returns `false` on its first
condition. The mode would have no way to be entered again.

- `ChatView.tsx:5757` enters `following-end` on send instead of
  `anchoring-new-turn`.
- Remove the superseded anchoring machinery rather than leaving it dormant:
  `anchoredEndSpace` plumbing, the overflow-follow effect (`:4137-4184`),
  `onTimelineAnchorReady` (`:4059`), `shouldReleaseTimelineAnchorForToolActivity`
  (`ChatView.logic.ts:68`), `releaseChatTimelineAnchor` (`ChatView.tsx:1127`),
  and the `anchoredEndSpace` branch of `maintainScrollAtEnd`
  (`MessagesTimeline.tsx:622`).
- Keep `keepTimelineEndVisibleAfterOverlayGrowth` — composer growth still needs it.
- Keep every break-out and return path untouched.

**Evidence:** targeted tests for send → follows end, upward wheel breaks follow,
return to end re-follows, composer growth keeps the end visible.

### P2 — Adapters report resolved model and effort (AC-01)

| Provider      | Change                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| Claude        | Emit `effectiveEffort` at **both** sites: `:2931` (main path, currently `{}`) and `:4583` |
| Codex         | `explicit reasoningEffort ?? model.defaultReasoningEffort`; emit at `:1054`               |
| OpenCode      | Already correct (`:4090`) — regression test only                                          |
| Cursor / Grok | Keep `{model}`; `effort` absent (no effort concept)                                       |

Resolution happens here, in the adapter, because the projector is pure and
cannot read a provider manifest, and because resolving at render time against
today's config would relabel historical turns.

**Evidence:** per-adapter tests asserting the resolved value, including Claude's
second emit site and Codex's default fallback.

### P3 — Ingestion forwards model and effort (AC-02)

Add a turn-scoped field on the turn-start orchestration payload and populate it
from `turn.started`. Do not widen `OrchestrationSession`: the session is current
state, the turn is history.

**Evidence:** receipt-driven ingestion tests — forwarding, absent payload,
unchanged session semantics.

### P4 — Projection pipeline, counts, migration (AC-03)

**Corrected during implementation.** Five facts in the original draft were wrong;
see `LEDGER.md#p4-ac-03` for the verification of each. The corrected design:

- Migration: additive nullable columns on `projection_turns` — `model`,
  `effort`, `command_count`, `tool_call_count`, `subagent_count`,
  `changed_file_count`. Pattern: `NNN_Name.ts` with a `PRAGMA table_info` guard,
  default-exported `Effect.gen`, registered in `Migrations.ts`.
- The SQL writer is **`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`**
  (`applyThreadTurnsProjection`), **not** `projector.ts` — the latter never
  touches `projection_turns` and is a pure in-memory reducer for the decider.
- Write model/effort on turn start; write counts once when the turn settles.
  Settle has **three** paths, all needing the stamp: the `thread.session-set`
  leaving-running branch, the `thread.message-sent` assistant-completion branch,
  and `thread.turn-interrupt-requested`.
- Counting requires a **new explicit SQL query** against
  `projection_thread_activities` filtered by `turn_id`: the turn and activity
  projections are decoupled and share no loaded state.
- `toolCallId` and `itemType` are **not columns** — they live inside
  `payload_json` (written at `ProviderRuntimeIngestion.ts:811-812`). Dedup and
  classification read them from there. The stored columns are `tone` and `kind`.
- Classification lives in one shared module
  (`packages/shared/src/turnWorkCounts.ts`, implemented and passing) used by both
  server and client so the two can never disagree.

**Evidence:** projector tests for stamp, counts, dedup (the 3-calls/12-rows
case), interrupted turns, and old-payload decode.

### P5 — Contracts and snapshot query (AC-04)

- `OrchestrationTurnSummary = {turnId, state, requestedAt, startedAt, completedAt, assistantMessageId, model?, effort?, counts?}`.
- `turns: Schema.optional(Schema.Array(OrchestrationTurnSummary))` on the thread,
  capped at 500.
- New per-thread `listTurnRows` in `ProjectionSnapshotQuery.ts`.
  `listLatestTurnRows` is at `:685` and returns only the single latest turn per
  thread (join on `projection_threads.latest_turn_id`), so it cannot be reused.
- **Correction:** checkpoints are _not_ capped in SQL, so there is no checkpoint
  cap to mirror. Follow the genuine precedent instead:
  `THREAD_DETAIL_ACTIVITY_LIMIT = 500` (`ProjectionSnapshotQuery.ts:76`) applied
  as a `LIMIT` at `:1049` and `:1413`.

**Evidence:** contract decode tests for present/absent/old payloads; snapshot
query test for cap and ordering.

### P6 — Summary derivation and subfolds (AC-05, AC-06, AC-07, AC-09, AC-11)

- Settled turns read stamped counts from `turns[]`.
- Live turn and all subfolds derive client-side from retained activities.
- Pre-stamp turns derive only when the turn started after the oldest retained
  activity; otherwise the bare duration label. Partial counts never render.
- `+N/−M` sums checkpoint `additions`/`deletions`; suppressed unless
  `checkpoint.status === "ready"`; file count retained either way.
- Subfolds split at assistant-message boundaries; totals reconcile with the turn.
- Interrupted styling reads per-turn state, fixing `MessagesTimeline.logic.ts:613`.
- Retain the lifecycle `startedAt` in `mergeDerivedWorkLogEntries`
  (`session-logic.ts:1166`) and add it to `WorkLogEntry` so per-tool duration
  becomes derivable.

**Evidence:** first direct tests for `deriveTurnFolds`; subfold split; stamped-
vs-derived precedence; truncation fallback; diff suppression; `startedAt`
retention; interrupted history.

### P7 — Rendering (AC-08, AC-10)

- Tool rows: replace the `??` at `MessagesTimeline.tsx:2399` with three columns,
  duration right-aligned and `shrink-0`, description flexing and truncating
  first. Reuse existing T3 tokens (`text-secondary-label`, `text-icon-muted`,
  `text-warning`, `text-destructive`) and the current tone-icon mapping; keep
  `circle-alert` failure behavior. Filename emphasis via `filePathDisplay.ts`.
- Fold rows: enriched labels for turn and subfold, same button semantics,
  `aria-expanded`, `data-scroll-anchor-ignore`.
- Footer: model/effort/duration/timestamp from `turns[]` by `turnId`, under the
  existing `showAssistantMeta` gate, icons-only via container query.

**Evidence:** row-structure and footer tests for present/absent effort, no
literal `default`, pre-stamp fallback.

### P8 — Working-state legibility (AC-12)

- Tool→phrase map keyed on `itemType`.
- ~1200 ms minimum dwell with a queue that drops generic churn.
- Stable-hashed fallback phrase, deterministic per message.
- Live-ness from stream phase, never absent timestamps.
- Shared duration ticker: one `setInterval` plus a subscriber set, following the
  existing `WorkingTimer` precedent of writing text nodes directly.

**Evidence:** dwell/queue behavior, stable phrase determinism, one-interval
assertion for N live rows.

### P9 — Docs and verification

- `docs/user/` for the user-visible change; `docs/internals/` for the turn
  record, the count-at-settle rule, and the scroll simplification.
- Targeted `vp test run` on touched files plus scoped lint and typecheck.

## Sequencing

P1 is independent and ships first. P2 → P3 → P4 → P5 are strictly ordered. P6
and P7 may start against client-derived counts and switch to stamped counts once
P5 lands. P8 is independent. P9 last.

## Surfaces

- **Contracts** → server, web, desktop follow.
- **Web** primary; **desktop** inherits.
- **Mobile** deferred; additive optional fields keep it working untouched.
- **Providers** all five decided in P2.
- **Connection modes** unaffected: no new per-token wire traffic; the stamp is
  small fields on events that already exist.

## Risks

1. **Ingestion is the event-sourced write path.** Mitigation: additive optional
   field only, no change to existing event semantics, receipt-driven tests.
2. **Migration against a live 1.4 GB database.** Mitigation: additive nullable
   columns, no backfill, no rewrite.
3. **Anchoring removal touches a lot of `ChatView.tsx`.** Mitigation: the
   fallback (`following-end`) is already the thread-open default; existing
   scroll tests cover the surface.
4. **Stamped/derived count drift.** Mitigation: one shared classification module
   for both sides, asserted in tests.
5. **Activity ageing makes old counts partial.** Mitigation: stamped counts are
   authoritative; the client refuses to render a derived count it cannot trust.
