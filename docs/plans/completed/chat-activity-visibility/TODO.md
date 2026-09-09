# Chat Activity Visibility — TODO

All items complete. Independently validated 2026-09-09 (`PASS`, all 13 criteria).
Evidence anchors point at the corresponding `LEDGER.md` sections.

**Correction:** P4 items below name `projector.ts` as the write target. That was a
planning error — `projector.ts` never touches `projection_turns`. The real SQL
writer is `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, which is
where the work landed. See the correction table in `LEDGER.md`.

## P0 — Baseline

- [x] P0-PROV Record baseline revision `8f7b05edb30e2620bfacf5a6c4b31c8ec7576845` — `LEDGER.md#p0-baseline`
- [x] P0-PROV Confirm clean worktree at plan start — `LEDGER.md#p0-baseline`
- [x] P0-SCOPE Record declared scope digest — `LEDGER.md#p0-baseline`

## P1 — Scroll: follow end on send

- [x] AC-13 Enter `following-end` on send in `apps/web/src/components/ChatView.tsx:5757` — `LEDGER.md#p1-ac-13`
- [x] AC-13 Remove the overflow-follow effect (`ChatView.tsx:4137-4184`) — `LEDGER.md#p1-ac-13`
- [x] AC-13 Remove `onTimelineAnchorReady` (`ChatView.tsx:4059`) — `LEDGER.md#p1-ac-13`
- [x] AC-13 Remove `releaseChatTimelineAnchor` (`ChatView.tsx:1127`) — `LEDGER.md#p1-ac-13`
- [x] AC-13 Remove `shouldReleaseTimelineAnchorForToolActivity` (`apps/web/src/components/ChatView.logic.ts:68`) and its tests — `LEDGER.md#p1-ac-13`
- [x] AC-13 Remove the `anchoredEndSpace` branch of `maintainScrollAtEnd` (`apps/web/src/components/chat/MessagesTimeline.tsx:622`) — `LEDGER.md#p1-ac-13`
- [x] AC-13 Retain `keepTimelineEndVisibleAfterOverlayGrowth` for composer growth — `LEDGER.md#p1-ac-13`
- [x] AC-13 Test: send follows the end from the first token — `LEDGER.md#p1-ac-13`
- [x] AC-13 Test: upward wheel breaks follow; downward does not — `LEDGER.md#p1-ac-13`
- [x] AC-13 Test: scroll back to end re-follows — `LEDGER.md#p1-ac-13`
- [x] AC-13 Test: composer growth keeps the end visible — `LEDGER.md#p1-ac-13`

## P2 — Adapters report resolved model and effort

- [x] AC-01 Emit resolved `effort` at `apps/server/src/provider/Layers/ClaudeAdapter.ts:2931` (main `sendTurn` path) — `LEDGER.md#p2-ac-01`
- [x] AC-01 Emit resolved `effort` at `ClaudeAdapter.ts:4583` — `LEDGER.md#p2-ac-01`
- [x] AC-01 Emit `model`/`effort` at `apps/server/src/provider/Layers/CodexAdapter.ts:1054` using `explicit reasoningEffort ?? model.defaultReasoningEffort` — `LEDGER.md#p2-ac-01`
- [x] AC-01 Confirm Cursor/Grok emit `model` with `effort` absent — `LEDGER.md#p2-ac-01`
- [x] AC-01 Test: Claude both emit sites report resolved effort — `LEDGER.md#p2-ac-01`
- [x] AC-01 Test: Codex falls back to `defaultReasoningEffort` when unset — `LEDGER.md#p2-ac-01`
- [x] AC-01 Test: OpenCode regression for existing `{model, effort}` — `LEDGER.md#p2-ac-01`

## P3 — Ingestion forwards model and effort

- [x] AC-02 Add turn-scoped `model`/`effort` to the turn-start orchestration payload in `packages/contracts/src/orchestration.ts` — `LEDGER.md#p3-ac-02`
- [x] AC-02 Populate from `turn.started` in `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — `LEDGER.md#p3-ac-02`
- [x] AC-02 Leave `OrchestrationSession` unchanged — `LEDGER.md#p3-ac-02`
- [x] AC-02 Test: forwarding, absent payload, unchanged session semantics (receipt-driven) — `LEDGER.md#p3-ac-02`

## P4 — Projector, counts, migration

- [x] AC-03 Migration: nullable `model`, `effort`, `command_count`, `tool_call_count`, `subagent_count`, `changed_file_count` on `projection_turns` — `LEDGER.md#p4-ac-03`
- [x] AC-03 Shared classification module in `packages/shared` (dedup by `toolCallId`, classify by `itemType`, exclude `info` tone, `collab_agent_tool_call` → subagent) — `LEDGER.md#p4-ac-03`
- [x] AC-03 Write model/effort on turn start in `apps/server/src/orchestration/projector.ts` — `LEDGER.md#p4-ac-03`
- [x] AC-03 Write counts once on turn completion/interruption — `LEDGER.md#p4-ac-03`
- [x] AC-03 Test: stamp, counts, dedup (3 calls / 12 rows), interrupted turns, old-payload decode — `LEDGER.md#p4-ac-03`

## P5 — Contracts and snapshot query

- [x] AC-04 Add `OrchestrationTurnSummary` to `packages/contracts/src/orchestration.ts` — `LEDGER.md#p5-ac-04`
- [x] AC-04 Add optional `turns[]` to the thread schema, capped at 500 — `LEDGER.md#p5-ac-04`
- [x] AC-04 Add per-thread `listTurnRows` to `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — `LEDGER.md#p5-ac-04`
- [x] AC-04 Test: decode with field present, absent, and from an old server — `LEDGER.md#p5-ac-04`
- [x] AC-04 Test: snapshot cap and ordering — `LEDGER.md#p5-ac-04`

## P6 — Summary derivation and subfolds

- [x] AC-11 Retain lifecycle `startedAt` in `mergeDerivedWorkLogEntries` (`apps/web/src/session-logic.ts:1166`) and add it to `WorkLogEntry` — `LEDGER.md#p6-ac-11`
- [x] AC-05 Read stamped counts for settled turns — `LEDGER.md#p6-ac-05`
- [x] AC-05 Derive client-side for the live turn and all subfolds — `LEDGER.md#p6-ac-05`
- [x] AC-05 Fall back to the bare duration label when a pre-stamp turn's activities may have aged out — `LEDGER.md#p6-ac-05`
- [x] AC-06 Sum checkpoint `additions`/`deletions`; suppress `+N/−M` unless `status === "ready"`; retain file count — `LEDGER.md#p6-ac-06`
- [x] AC-07 Split subfolds at assistant-message boundaries — `LEDGER.md#p6-ac-07`
- [x] AC-09 Read per-turn state for interrupted styling, fixing `MessagesTimeline.logic.ts:613` — `LEDGER.md#p6-ac-09`
- [x] AC-05 Test: first direct `deriveTurnFolds` coverage — `LEDGER.md#p6-ac-05`
- [x] AC-07 Test: subfold split; totals reconcile with the turn — `LEDGER.md#p6-ac-07`
- [x] AC-05 Test: stamped-vs-derived precedence; truncation fallback — `LEDGER.md#p6-ac-05`
- [x] AC-06 Test: diff suppression retains the file count — `LEDGER.md#p6-ac-06`
- [x] AC-09 Test: historical interrupted turn renders `Stopped After` — `LEDGER.md#p6-ac-09`

## P7 — Rendering

- [x] AC-10 Replace the `??` merge at `apps/web/src/components/chat/MessagesTimeline.tsx:2399` with three columns — `LEDGER.md#p7-ac-10`
- [x] AC-10 Right-align duration, `shrink-0`; description flexes and truncates first; empty column preserved — `LEDGER.md#p7-ac-10`
- [x] AC-10 Reuse existing tone/color tokens; keep `circle-alert` failure behavior — `LEDGER.md#p7-ac-10`
- [x] AC-10 Filename emphasis via `apps/web/src/filePathDisplay.ts` — `LEDGER.md#p7-ac-10`
- [x] AC-05 Render enriched turn and subfold labels in `TurnFoldTimelineRow` (`MessagesTimeline.tsx:1221`) — `LEDGER.md#p7-ac-05`
- [x] AC-08 Render the footer in `AssistantTimelineRow` (`MessagesTimeline.tsx:1264`) from `turns[]` — `LEDGER.md#p7-ac-08`
- [x] AC-08 Omit effort only when absent; never render the literal `default` — `LEDGER.md#p7-ac-08`
- [x] AC-08 Icons-only degradation via container query — `LEDGER.md#p7-ac-08`
- [x] AC-08 Test: effort present, absent, pre-stamp fallback — `LEDGER.md#p7-ac-08`
- [x] AC-10 Test: row structure and duration alignment — `LEDGER.md#p7-ac-10`

## P8 — Working-state legibility

- [x] AC-12 Tool→phrase map keyed on `itemType` — `LEDGER.md#p8-ac-12`
- [x] AC-12 ~1200 ms dwell with a queue that drops generic churn — `LEDGER.md#p8-ac-12`
- [x] AC-12 Stable-hashed fallback phrase, deterministic per message — `LEDGER.md#p8-ac-12`
- [x] AC-12 Derive live-ness from stream phase, never absent timestamps — `LEDGER.md#p8-ac-12`
- [x] AC-11 Shared duration ticker: one interval plus a subscriber set — `LEDGER.md#p8-ac-11`
- [x] AC-12 Test: dwell/queue behavior; stable phrase determinism — `LEDGER.md#p8-ac-12`
- [x] AC-11 Test: N live rows consume one interval — `LEDGER.md#p8-ac-11`

## P9 — Docs and verification

- [x] Update `docs/user/` for the user-visible change — `LEDGER.md#p9-docs`
- [x] Update `docs/internals/` for the turn record, count-at-settle rule, and scroll simplification — `LEDGER.md#p9-docs`
- [x] Run targeted `vp test run` on touched files — `LEDGER.md#p9-verify`
- [x] Run scoped lint and typecheck for changed scope only — `LEDGER.md#p9-verify`
