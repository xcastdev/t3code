# Turn provenance

Turn history records the model, effort, and work counts that belonged to each turn. These values
are stamped while the turn is current because thread settings and retained activity can change
later.

## Model and effort

The selected model lives on the thread and can change between turns. Rendering history from that
selection would relabel earlier responses, so provider adapters include the effective model and
effort with `turn.started`. Runtime ingestion carries those values on the matching
`thread.session-set` command, and the turn projection stores them.

Effort is resolved at the adapter boundary. The projector cannot consult provider configuration,
and resolving against a later model catalog would rewrite history. Claude records its effective
session effort, Codex uses the explicit selection or the model catalog default, and OpenCode maps
its variant to effort. Providers without an effort concept omit it.

Provenance is separate from `OrchestrationSession`: a session describes current state, while a turn
is history. The projection applies provenance only when its turn ID matches the turn being written,
so a later session update cannot clear an earlier stamp. Optional values remain omitted rather than
being stored as `null`.

## Work counts

Commands, tool calls, subagents, and changed files are counted when a turn settles. Activities are
retained in a bounded window, so recomputing an older turn could silently undercount it.

Both terminal session updates and completed assistant messages can settle a turn. Existing stamps
win, which makes the write idempotent. An interrupt request does not settle counts because the
provider may still emit work before it stops; the later terminal session update performs the stamp.
A late completed diff may update the changed-file count only after the other counts exist.

The server and clients share `packages/shared/src/turnWorkCounts.ts`. It deduplicates lifecycle rows
by tool-call ID, classifies commands by item type, counts a delegation as a subagent rather than a
tool call, and excludes activity hidden from the parent timeline.

## Incomplete activity windows

Settled turns use stamped counts. A live turn may derive counts from its retained activities, but
clients suppress that breakdown when the server identifies the turn as partially retained. Older
hosts do not identify individual partial turns, so clients conservatively suppress derived counts
when the activity window reaches its cap.

The server detects truncation by reading one row beyond the retention limit. It compares the total
and retained row counts per turn because provider events can interleave; the oldest visible row does
not reliably identify every affected turn.

Turn diffs show additions and deletions only after the checkpoint diff is ready. The changed-file
count can still appear when line counts are unavailable.

## Snapshot limits

Turn snapshots are capped per thread. The snapshot query partitions its limit by thread so activity
in one thread cannot starve another. Count fields are emitted only when the complete stamp is
present; a partial database row is treated as unavailable.

When testing optional fields, use `Object.hasOwn` when absence matters. An `undefined` assertion
cannot distinguish an omitted field from a field whose value is `undefined`.
