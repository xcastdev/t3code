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
at construction. Codex's own `"default"` sentinel is mapped to `undefined` there, which is why no
part of the render path needs a `default` special case.

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

Settle has three paths, and all three stamp:

- `thread.session-set`, where the session leaves `running`
- `thread.message-sent`, on assistant completion
- `thread.turn-interrupt-requested`

`settleCountsFor` returns `{}` when a count is already present, which is what makes the write
happen exactly once.

### Classification

`packages/shared/src/turnWorkCounts.ts` is shared by the server (stamping) and the client (live turn
and subfolds) so the two can never disagree about what a command is.

- Dedupe by `toolCallId` — one call emits several lifecycle rows.
- Classify by `itemType`, never `toolName`, which is null for the large majority of stored command
  rows.
- `collab_agent_tool_call` counts as a subagent, not a tool call.
- `info`-tone rows are excluded; `error` and `approval` are counted, because a failed command still
  ran.

`itemType` and `toolCallId` are fields inside `payload_json`, not columns. The activity table stores
`tone` and `kind`.

## The client refuses to guess

Two rules keep the timeline honest.

**Stamped beats derived.** Settled turns read their stamped counts. The live turn and all subfolds
derive client-side from retained activities.

**A count it cannot trust is not rendered.** The guard is one expression:

```
stampedCounts ?? (activitiesMayHaveAgedOut ? null : derivedCounts)
```

When a pre-stamp turn began before the oldest retained activity, counts are `null` and every segment
drops, leaving the bare duration. `null` rather than zeroes is the point — zeroed counts would
render a label with segments silently missing, which is precisely the partial count to avoid.

Subfolds always derive from present rows and never read the stamp, so turn totals reconcile with
subfold sums by construction.

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
subfold structure absorbs it without redesign. Mobile's parallel timeline still renders the old
fold label — the additive contract keeps it working unchanged.
