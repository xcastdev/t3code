# Chat Activity Visibility — Specification

## Problem / Outcome

The chat timeline does not tell the user what happened, what ran it, or what is
happening right now.

1. **A settled turn does not say what it did.** All intermediate work folds
   behind `Worked for 1m 12s` (`apps/web/src/components/chat/MessagesTimeline.logic.ts:634`).
   The duration survives; everything about the work is discarded. Two turns that
   took the same time render identically whether one read a file or rewrote
   twelve and ran the test suite.
2. **A turn does not say what model ran it.** Model and reasoning effort appear
   nowhere in the timeline. `modelSelection` lives on the thread
   (`packages/contracts/src/orchestration.ts:441`) and is overwritten every turn
   (`apps/server/src/orchestration/projector.ts:466`), so switching models
   mid-thread silently relabels all history.
3. **"Working" does not say what it is working on.** The busy row shows
   `Working for {timer}` plus a generic `Thinking` label. States are ad-hoc
   booleans (`ChatView.tsx:2334`), not a status.
4. **The stream does not stick to the bottom on send.** A sent message is pinned
   near the top with reserved end space and the stream only follows the end once
   it overflows the viewport or a tool runs.

Outcome: a turn reports what it did, what ran it, and how long it took; live work
names the tool it is running; and the stream follows the end from the first token.

## Confirmed Root Cause

Per-turn provenance is captured by adapters and then dropped before it reaches
any read model:

- Adapters compute resolved effort (`ClaudeAdapter.ts:4266`,
  `CodexAdapter.ts:1837`, `CodexProvider.ts:119`) but mostly emit empty
  `turn.started` payloads (`CodexAdapter.ts:1054`, `ClaudeAdapter.ts:2931`).
- `TurnStartedPayload` already carries optional `model`/`effort`
  (`packages/contracts/src/providerRuntime.ts:361`), but ingestion never reads
  them; an accepted `turn.started` collapses into `thread.session.set`
  (`ProviderRuntimeIngestion.ts:1720`) and `OrchestrationSession`
  (`orchestration.ts:350`) has no model field.
- The client receives only `latestTurn` (one turn per thread) and
  `checkpoints[]`. There is no per-turn record to read from.

Fold summaries are absent because activities are capped at 500 per thread
(`projector.ts:806`, `ProjectionSnapshotQuery.ts:76`), so client-side counting of
older turns is structurally partial.

## Scope

### In Scope

- Per-turn record on the wire: `turns[]` with state, timing, model, effort, and
  settle-time work counts
- Adapter reporting of resolved model/effort on `turn.started` for all five
  providers
- Enriched turn fold summary and nested subfolds
- Per-turn footer with model, effort, duration, timestamp
- Three-column tool rows with right-aligned duration; commands as a distinct
  category
- Tool-aware working status with dwell, stable fallback phrase, shared ticker
- Follow-the-end-on-send scroll behavior and removal of the superseded
  send-time anchoring machinery

### Out of Scope

- **Per-turn tokens and cost.** Requires usage plumbed from provider adapters.
- **Reasoning/thinking rows.** All providers emit reasoning
  (`ClaudeAdapter.ts:1359`, `OpenCodeAdapter.ts:826`, `CodexAdapter.ts:1251`),
  and ingestion drops all of it (`ProviderRuntimeIngestion.ts:1743`). Deferred by
  explicit user decision.
- **Backfill of historical turns.** Pre-change turns show no badge.
- **Mobile.** `apps/mobile` has a parallel timeline (`ThreadFeed.tsx` 2525 lines,
  `threadActivity.ts` 1796 lines, duplicate fold label at `threadActivity.ts:1341`).
  Deferred by explicit user decision; additive contracts keep it working
  unchanged.

## Behavior

### Turn fold (settled turns)

```
› Worked for 1m 12s · 5 Commands · 7 Tool Calls · 2 Subagents · 3 Changed Files +42/−11
› You stopped after 1m 12s · 2 Commands · 1 Changed File +8/−0
```

The interrupted phrasing above matches the shipped copy. An earlier draft of this
spec wrote `Stopped After`; changing existing user-facing wording was never in
scope, so AC-09 governs _which_ turns receive the interrupted treatment, not the
words used.

Segments omit individually. When nothing is countable the label falls back to
today's bare `Worked for {duration}` / `Stopped After {duration}`. The active
turn never folds.

### Subfolds

One per contiguous work group between assistant messages inside a turn. Same
vocabulary and order, no duration:

```
› 3 Commands
› 2 Tool Calls · 1 Subagent
```

Turn totals equal the sum of subfolds. A single-item subfold still renders as a
subfold.

### Turn footer

On the terminal assistant message, under the existing `showAssistantMeta` gate
and hover behavior:

```
◈ Claude Opus 4.5 · ⌁ high · 1m 12s · 2:47 PM
```

Effort renders as a concrete level, never the literal string `default`; it is
omitted only when the model has no effort concept. Degrades to icons-only via
container query. Pre-stamp turns render today's footer.

### Tool rows

```
▣  Shell Command   git status --short && git log --oneline -5              0.1s
▤  Read File       /tmp/opencode/xcastdev-opencode/package.json
```

`[icon] [Name] [description] → [duration?]`. Duration right-aligned and
`shrink-0`; description flexes and truncates first. Rows without a duration keep
the column empty so the right edge stays a column.

### Working status

Names the running tool ("running command", "reading file"). Minimum ~1200 ms
dwell with a queue that drops generic churn. Stable-hashed fallback phrase per
message. Live-ness derives from stream phase, never from absent timestamps.

### Scroll

On send the timeline enters `following-end` and follows the stream from the
first token. Existing break-out (upward wheel, touch, scrollbar drag, PageUp /
Home / ArrowUp) and return (scroll to end, pill) behavior is unchanged.

## Acceptance Criteria

- **AC-01** `turn.started` carries resolved `model` and `effort` for Claude
  (both emit sites), Codex, and OpenCode; Cursor and Grok report `model` with
  `effort` absent.
- **AC-02** Ingestion forwards `model`/`effort` from `turn.started` into the
  turn-start orchestration payload without altering existing session semantics.
- **AC-03** The projector persists per-turn `model`, `effort`, and settle-time
  counts; counts dedup by `toolCallId`, classify by `itemType`, and exclude
  `info`-tone rows.
- **AC-04** `turns[]` is exposed on the thread snapshot, capped at 500, and is
  optional on the wire so old servers and cached snapshots decode.
- **AC-05** A settled turn fold renders stamped counts; a live turn and all
  subfolds derive client-side; a pre-stamp turn whose activities may have aged
  out renders the bare duration label rather than a partial count.
- **AC-06** `+N/−M` is suppressed when `checkpoint.status !== "ready"` while the
  changed-file count is retained.
- **AC-07** Subfolds split at assistant-message boundaries and their counts sum
  to the turn total.
- **AC-08** The footer renders model, concrete effort, duration, and timestamp
  from `turns[]`; effort is omitted only when absent; the literal `default` never
  renders.
- **AC-09** Historical interrupted turns render the interrupted label
  (`You stopped after ...`), not `Worked for`.
- **AC-10** Tool rows render name, description, and right-aligned duration;
  commands are visually and categorically distinct from other tools.
- **AC-11** Per-tool duration derives from a retained lifecycle start timestamp,
  and all live durations share one ticker interval.
- **AC-12** Working status names the active tool, holds a label for the dwell
  window, and never renders a live indicator for a settled part.
- **AC-13** On send the timeline follows the end from the first token; break-out
  and return paths behave exactly as before.

## Constraints

- Contract additions are optional/nullable; old servers and clients interoperate.
- No repo-wide checks (`vp check`, `vp run -r test`); CI owns the full suite.
- Server tests wait on receipts and worker drains, never sleeps or polling.
- No continuously repainting animations; opacity-only, reduced-motion aware.
- Migration on a live 1.4 GB database is additive and nullable, with no backfill.
