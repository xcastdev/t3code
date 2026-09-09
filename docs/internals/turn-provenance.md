# Turn provenance

> For maintainers. Using T3 Code? See [docs/user](../user/).

A turn records what ran it and what it did. This note covers where that data comes from, why it is
stamped rather than derived, and the two rules that keep the client from lying about it.

## Why the turn, not the thread

`modelSelection` lives on the thread and is overwritten every turn. Reading it at render time
relabels all history the moment a user switches models, so per-turn provenance has to be captured
when the turn starts and stored with the turn.

Checkpoints cannot carry it either. Interrupted turns almost never have one — in the live database,
interrupted turns split 24 `missing` / 14 none / 3 `ready` — so a checkpoint-keyed record would
lose exactly the turns whose history matters most.

## The path

```
adapter turn.started {model, effort}
  → ProviderRuntimeIngestion  (turn-scoped carrier)
  → thread.session.set command
  → decider → thread.session-set event
  → ProjectionPipeline.applyThreadTurnsProjection
  → projection_turns.model / .effort
  → ProjectionSnapshotQuery → thread.turns[]
  → deriveMessagesTimelineRows
```

Two things about this path are deliberate.

**Effort resolves in the adapter.** The projector is pure and cannot read a provider manifest, and
resolving at render time against today's configuration would relabel historical turns. Each adapter
reports the value that actually governed its run: Claude from `ClaudeSessionContext.currentEffort`,
Codex from the explicit `reasoningEffort` selection falling back to the model's catalog default.

Codex's catalog default is not reachable from the adapter — it arrives over the `model/list` RPC and
is mapped in the provider layer — so `CodexDriver` injects a `resolveDefaultReasoningEffort` lookup
at construction. Effort levels come from the model's own `supportedReasoningEfforts`, so every value
that reaches the adapter is a real level — there is no sentinel to filter, and no part of the render
path needs a special case. (`"default"` is a **serviceTier** id, not a reasoning-effort one.)

**Provenance rides beside the session, not inside it.** `OrchestrationTurnProvenance` is a separate
optional field on `ThreadSessionSetCommand` and `ThreadSessionSetPayload`. The session is current
state; the turn is history. Widening `OrchestrationSession` would have conflated the two.

The projection applies provenance only when `turnProvenance.turnId` matches the turn being written,
so a later session-set for a different turn cannot blank what the opening event recorded.

> `turn.started`'s `payload` is itself optional, not merely its fields. Read it as
> `event.payload?.model`. Treating the payload as guaranteed breaks every provider that emits a bare
> turn start.

## Counts are stamped at settle

Work counts are computed once, when the turn settles, and written to `projection_turns`. They are
never recomputed later.

The reason is retention: activities are capped at 500 per thread, so a turn old enough to have lost
rows can no longer be counted accurately. A stamp taken at settle is complete; a count derived
afterwards silently undercounts.

Settle has two paths, and both stamp:

- `thread.session-set`, where the session leaves `running`
- `thread.message-sent`, on assistant completion

`settleCountsFor` returns `{}` when a count is already present, which is what makes the write
happen exactly once.

`thread.turn-interrupt-requested` deliberately does **not** stamp. An interrupt is a request the
provider has not seen yet — it keeps emitting until the stop lands, and Codex first tears down
children on bounded timeouts — so stamping at request time counts out any work that starts inside
that window, permanently. The interrupt records the state and `completedAt`; the terminal
`thread.session-set` stamps the counts. To let it, the settle filters match a turn that is
`running`, or `interrupted` and still unstamped; an interrupted turn keeps its state and its own
end timestamp when that later settle lands.

The `changed_file_count` restamp on a late `thread.turn-diff-completed` applies only to a turn that
was already stamped. A file count written onto an otherwise-NULL row is a partial, and the reader
discards partials wholesale — which would also throw away the counts the client can still derive.

### Classification

`packages/shared/src/turnWorkCounts.ts` is shared by the server (stamping) and the client (live
turn) so the two can never disagree about what a command is.

- Dedupe by `toolCallId` — one call emits several lifecycle rows.
- Classify by `itemType`, never `toolName`, which is null for the large majority of stored command
  rows.
- `collab_agent_tool_call` counts as a subagent, not a tool call.
- `info`-tone rows are excluded; `error` and `approval` are counted, because a failed command still
  ran.
- Rows the timeline hides are excluded, so a fold's total always reconciles with the rows a user can
  expand under it:
  - **`agentId` rows** are a subagent's own tool calls. Claude and OpenCode stamp them and file them
    under the _parent's_ turn, so counting them would attribute a delegate's work to this turn. The
    delegation still counts, through the parent's own un-attributed `collab_agent_tool_call` row.
  - **`detail` starting `ExitPlanMode:`** is the plan-mode boundary, already rendered as its own row.

`itemType`, `toolCallId`, `agentId`, and `detail` are fields inside `payload_json`, not columns. The
activity table stores `tone` and `kind`.

> Turns stamped before this filter existed keep their inflated counts: `settleCountsFor` skips an
> already-stamped turn, and nothing backfills. Only turns settling from now on reconcile with the
> rows a user can expand.

## The client refuses to guess

Two rules keep the timeline honest.

**Stamped beats derived.** Settled turns read their stamped counts. The live turn derives
client-side from retained activities.

**A count it cannot trust is not rendered.** The guard is one expression:

```
stampedCounts ?? (activitiesMayHaveAgedOut ? null : derivedCounts)
```

When a pre-stamp turn began before the oldest retained activity, counts are `null` and every segment
drops, leaving the bare duration. `null` rather than zeroes is the point — zeroed counts would
render a label with segments silently missing, which is precisely the partial count to avoid.

`+N/−M` sums the turn's checkpoint additions and deletions and is suppressed unless the checkpoint
status is `ready`. The changed-file count survives suppression either way.

## Snapshot shape

`turns[]` is capped at 500 per thread. The full-snapshot query partitions with `ROW_NUMBER() OVER
(PARTITION BY thread_id ...)` so one busy thread cannot starve others.

Null provenance columns map to _omitted_ optional fields rather than `null`, and `counts` is emitted
only when all four count columns are present, so a partially-stamped row can never produce a partial
count.

> When testing optional-field omission, assert with `Object.hasOwn`. `assert.isUndefined` cannot
> distinguish an absent field from one present with an `undefined` value, and will pass against a
> real regression.

## Scroll: the timeline follows the end

Sending a message puts the timeline in `following-end`. It follows the stream from the first token.

The previous model anchored a newly sent message near the top with reserved space below it, and only
ever engaged on a thread's first message. It also released the moment a tool ran — evidence that the
anchored reading model did not suit tool-driven agent work.

That machinery is removed rather than left dormant: with its single entrance gone, its effects were
permanently unreachable and `anchoredEndSpace` permanently undefined. `TimelineScrollMode` is now
`following-end | free-scrolling`.

`keepTimelineEndVisibleAfterOverlayGrowth` is retained — composer growth still needs it. Every
break-out path (wheel, touch, scrollbar, Page Up / Home / arrows) and return path (scroll to end,
pill) is unchanged.

Mobile has its own independent anchoring implementation in `ThreadFeed` and shares only the generic
helper in `packages/shared/src/chatList.ts`, which is why the web removal left it untouched.

## Not covered here

Per-turn tokens and cost are not plumbed from adapters. Reasoning is emitted by Claude, OpenCode,
and Codex but dropped at ingestion, which filters to `assistant_text`; when it is picked up, the
fold label absorbs it without redesign. Mobile's parallel timeline still renders the old
fold label — the additive contract keeps it working unchanged.

A steer that changes the model mid-turn is not re-stamped. Claude, Cursor, and Grok all gate
`turn.started` on there being no steering turn, so the run switches model while the turn keeps the
provenance it opened with. Provenance describes what a turn _started_ as; correcting it would need a
second turn-scoped event, which is not worth a row that already reads as history.

Cursor and Grok report `model` but never `effort`, and OpenCode maps its variant selection into the
`effort` field. These are best-effort: the footer renders whatever the adapter reports, and an
adapter that reports nothing renders no chip.
