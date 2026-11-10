# Review resolution 4: replay retention

Validator: Opus 5.5 (design subagent). I checked the remaining MEDIUM finding against the current `implementation-plan.md` (Task 13), the approved `design.md`, `AGENTS.md`, and resolutions 1-3. I then revised the plan in place and reread every touched section. `review-resolution.md`, `-2.md` and `-3.md` are unchanged. The pre-revision copy is at `/tmp/claude-1000/-home-user--local-share-t3-worktrees-t3code-t3-ca5fe124/08eb1fbd-4cac-493a-ad8e-35178d2c4347/scratchpad/implementation-plan.before-r4.md`.

No product code changed. I installed nothing, started no servers, made no commits or PRs, and spawned no subagents. This is not an approval; the primary rereviews it.

## Verdict: accepted

**Evidence (pre-revision plan)**

- Task 13, line 616: the `replays` table had a unique `idempotencyKey` and no deletion rule anywhere in the plan.
- Line 651: the only pruning test was `store prunes oldest captures past maxDiskBytes`. Replay rows, `replay/<id>.bin` files, and drafts were not counted in that budget.
- Line 620: Accept treated any unknown key as new. Deleting rows would therefore let an old retry send a second request. Host `deleteData` (Task 5, line 338) has the same effect.
- Line 634: keys were caller-chosen 1-64 char strings. A bounded store cannot tell a forgotten caller-chosen key from a new one, so no retention rule over those keys could be safe.
- Line 636: drafts lived until replay or worker start, with no count limit. Pending replays had no server-side cap; only the panel's limit of 20 existed, and agents bypass the panel.
- `maxDiskBytes` had no defined measure. Deleting SQLite rows does not shrink the file, so a budget over row bytes would not be honest about disk use.

The resolution-3 note "Replay rows are never pruned" already admitted this gap.

## Model

Keys are issued by the inspector and carry a number that a stored floor can compare against. Expiry then needs no memory of old keys and no clock.

- **Keys.** `preview_replay` returns a fresh `idempotencyKey` = `rk1.<storeId>.<seq>.<nonce>`. `seq` is the store's current high-water mark (persisted), `storeId` is random per database, and minting writes nothing. The tool input stays a 1-64 char string, so a bad key gets an actionable refusal (at most 54 chars are used).
- **History.** Every pending row is kept, plus the newest 1000 settled rows. Pruning the oldest settled row raises `keyFloor` above that row's `keySeq` in the same transaction.
- **Accept order.** All of these run in one transaction:
  1. A row with the key exists: same input returns it, different input is refused.
  2. Otherwise, a key that is malformed, from another `storeId`, or above the high-water mark is refused as not issued.
  3. A key below the floor is refused as expired ("may have been sent and is no longer kept").
  4. The pending cap (20), a missing draft, and a full storage budget each refuse with nothing recorded.

  So an expired retry is never treated as a new replay. An unused key passed by the floor also expires, which is a safe refusal.

- **Restart and clock.** `storeId`, `seq`, and `keyFloor` are in SQLite, so keys survive restarts. No rule reads time. After `deleteData` the new `storeId` makes old keys refused.
- **Backpressure, not unsafe eviction.** At most 20 replays are pending server-wide, and each settles within 40 s or at worker start. At most 4 drafts exist. Evicting a draft is safe because a replay naming it is refused as not sent.
- **Storage budget.** `maxDiskBytes` (default 512 MiB, minimum 64 MiB) covers the measured on-disk size of `inspector.sqlite` and its `-wal`, plus `replay/` and `drafts/`. Excluded are the CA files and the addon.
  - The database uses `auto_vacuum = INCREMENTAL`. After pruning, the store runs `incremental_vacuum` and `wal_checkpoint(TRUNCATE)`, so pruning shrinks the physical file.
  - Pruning removes the oldest captures, then the running capture's oldest records. It never removes the source request of a pending replay.
  - Data that cannot be pruned is pending files and their sources, drafts, and replay history. When that alone is over budget, new flows are dropped and counted, and replays and draft writes are refused.
  - Disk use exceeds the budget only by the write in progress.
  - A replay result record joins its source request's capture, so capture pruning covers it.

## Exact plan changes

- Decision table, "Long-running mutations": keys come from `preview_replay`, and history is bounded with expired keys refused. Neither idempotency beyond the kept history nor exactly-once delivery is promised.
- Review Focus 9: keys come from `preview_replay`, and a pruned or deleted-data retry is refused. The test list now names history pruning, expired keys, and storage pressure.
- Task 13 manifest: the `maxDiskBytes` minimum, and the setting is the whole budget.
- Task 13 store: `replays.keySeq`, `detail` capped at 1 KiB, timestamps for display only, a `meta { storeId, keyFloor }` table, and "Storage budget" and result-record placement bullets.
- Task 13 `replay.ts`: a new "Replay keys" bullet, and Accept rewritten as one transaction with the ordered refusals and their exact messages. New "Replay history" bullet. `maxReplayHistory` is injected.
- Task 13 UI: Send uses the latest preview key, then fetches a fresh one, so two Sends never share a key. A Retry refused as expired or not issued drops the entry, labeled "may have been sent".
- Task 13 operations: `preview_replay` becomes an agent-visible read-only operation that returns `idempotencyKey`, and its description is defined. The `replay_request` key comes from `preview_replay`. Its description says to ask the user after an expired or not-issued refusal. `get_replay` explains `not-found` for pruned history. `body_draft_write` keeps at most 4 drafts under `drafts/`.
- Task 13 tests:
  - Unit (`store`/`bodies`): storage pressure measured by on-disk file sizes, including shrink after prune. Unprunable data over budget drops flows and refuses replays and drafts, sending nothing. Draft eviction, and a replay naming an evicted draft refused as not sent.
  - Unit (`replay`): history pruning raises the floor transactionally. A same-key retry after pruning is refused as expired and writes nothing to the control connection. In the same test, an unused key below the floor is refused, a kept replay below the floor is still returned, and `get_replay` for the pruned id returns `not-found`. Restart keeps keys valid. Deleted or recreated data, a seq above the high-water mark, and a malformed key are refused. The 21st pending replay is refused, while a same-key retry still works at the cap.
  - Integration replays take their keys from `preview_replay`.
- Task 13 evals: (f) now calls `preview_replay` first. New (g): after an expired refusal, the agent does not mint a new key and replay. It reports that the replay may have been sent and asks the user.
- Task 14 docs: internals explains issued keys and the floor. The user guide covers the 1000-replay history, expired retries, and what `maxDiskBytes` covers.
- Self-review budgets: disk, replay-row, draft, and idempotency-lifetime bounds.

Unchanged: commit-before-handoff, conservative `unknown`, enqueue-and-query, required keys (now issued, still required), highest-`seq` merge and reconnect reconciliation, the bundled addon, standalone panels, remote paths, and the provider matrix. I did not carry over resolution 3's resubscribe concern, per the primary's finding that Task 10 remounts the frame.

## Self-review

- `preview_replay` is listed once, under agent operations, and no longer under UI-only. No "caller-supplied" key wording remains. The only mention of "caller-chosen" is the docs rationale.
- Accept checks the row before the floor, so a kept replay below the floor is still returned. Every pruned key is below the floor. There is no path from a missing row to a new replay for an issued key below the floor.
- Bounds: 20 pending plus 1000 settled rows, 4 drafts of 16 MiB, at most 20 pending bodies, all inside measured `maxDiskBytes`. The panel's own limit of 20 matches the server cap.
- Task order is unchanged. Every change stays within Task 13, its evals, Task 14 text, and the summary tables.

## Remaining material questions

1. **`preview_replay` is now an agent tool.** It adds one call per agent replay. It also shows the agent the destination before execution, which the design asks for. Its `refusal?` output lets the agent see a truncated-body refusal early. The primary may prefer a dedicated `new_replay_key` operation instead. The safety argument is the same.
2. **`wal_checkpoint(TRUNCATE)` cannot finish while a read transaction is open.** Worker reads are short and synchronous, so a stalled checkpoint only delays the shrink until the next prune. The pressure test should run with no open reader.
3. **`delete_capture` of a capture holding a pending replay's source** is not specified. Budget pruning skips such sources. An explicit delete might be refused until the replays settle, which takes at most 40 s. I left it open as outside this finding.
4. **The 1000-row history and the 20-pending cap are constants, not settings.** Settled rows are small (about 1.5 KiB each), so the history is negligible inside the budget.
