# Review resolution 5: storage maintenance and issued keys

Validator: Opus 5.5 (design subagent). I checked the two MEDIUM findings against the current `implementation-plan.md` (Task 13), the approved `design.md`, `AGENTS.md`, and resolutions 1-4. Then I revised the plan in place and reread every touched section.

`review-resolution.md` and `-2.md` through `-4.md` are unchanged. The pre-revision copy is at `/tmp/claude-1000/-home-user--local-share-t3-worktrees-t3code-t3-ca5fe124/51bf31a3-6ccf-4248-9ad9-88cb1d5d8d50/scratchpad/implementation-plan.before-r5.md`.

The probe scripts are in that scratchpad directory: `wal.mjs`, `admit2.mjs`, `bigdel.mjs`, and `key.mjs`.

No product code changed. I installed nothing, started no servers, made no commits or PRs, and spawned no subagents. The only things I ran were standalone `node` probes against temporary databases in the scratchpad. This is not an approval; the primary rereviews it.

## Finding 1: acceptance transaction conflicts with WAL checkpoint

**Verdict: accepted.** The probe also exposed two more budget defects behind it, so the original "exceeded only by the write in progress" claim was false in three ways.

### Evidence

**Pre-revision plan.**

- Storage budget, line 618, said to prune, then run `incremental_vacuum` and `wal_checkpoint(TRUNCATE)`, then measure.
- Accept, line 624, ran its checks and the insert in one store transaction, and those checks included "storage budget is full".

**Probes.** All probes ran with real `node:sqlite` on Node v24.22.1 (SQLite 3.53.4).

| Probe                                                                               | Result                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wal.mjs`: `BEGIN IMMEDIATE`, `DELETE`, `PRAGMA incremental_vacuum`                 | The vacuum succeeds inside the transaction                                                                                                                                                                      |
| `wal.mjs`: `PRAGMA wal_checkpoint(TRUNCATE)` inside that transaction                | Throws `database table is locked`, which confirms the primary's reproduction                                                                                                                                    |
| `wal.mjs`: same steps with the checkpoint after `COMMIT`                            | `{busy:0}`, and the file shrinks from 8.4 MB to 6.3 MB                                                                                                                                                          |
| `wal.mjs`: a second connection holds a read transaction                             | The checkpoint returns `{busy:1}`, and the `-wal` grows by 1 MB with no shrink. After the reader commits, the checkpoint completes                                                                              |
| First admission prototype, default `wal_autocheckpoint`                             | Peak measured usage was 8,146,760 bytes against a 4 MiB budget. The automatic checkpoint copied about 4 MiB of WAL into the main file but left the `-wal` file at full size, so the same data sat on disk twice |
| `admit2.mjs`: autocheckpoint off, 4-row prune batches with one unbounded vacuum     | About 850 KB over budget                                                                                                                                                                                        |
| `admit2.mjs`: 1-row batches                                                         | About 67 KB over budget                                                                                                                                                                                         |
| `bigdel.mjs`: deleting about 10 MiB                                                 | Writes only 58 KB of WAL                                                                                                                                                                                        |
| `bigdel.mjs`: one unbounded `incremental_vacuum` after that delete                  | Peaks 8.8 MiB above start                                                                                                                                                                                       |
| `bigdel.mjs`: `incremental_vacuum(256)` steps with a TRUNCATE checkpoint after each | Peaks 1.07 MiB above start                                                                                                                                                                                      |

So the overshoot comes from vacuum page movement, not from the delete. Bounding the vacuum step bounds it, and the same rule covers a large explicit `delete_capture`.

### Model (smallest correct)

- **Store lane.** One store connection and one single-permit lane in the worker. Every store write takes the lane, and so does every file write or delete under `replay/` and `drafts/`. That covers flows, admission, dispatch, settle, history prune, maintenance, drafts, `delete_capture`, and recovery. Reads don't take the lane. No read transaction or iterator spans an `await`. While a flow record waits for the lane, the worker pauses reading the control socket.
- **Checkpoint rule.** `wal_autocheckpoint = 0`. `wal_checkpoint(TRUNCATE)` runs only outside transactions: after a commit that leaves the `-wal` over 1 MiB (`walTarget`), and between maintenance steps. `busy != 0` marks the checkpoint incomplete.
- **`admit(bytes, { protect? })`** runs inside the lane and outside any write transaction:
  1. Retry an incomplete checkpoint. If it is still blocked, return `full` without pruning, so a blocked checkpoint can't grow the WAL.
  2. While usage plus `bytes` is over budget, delete the oldest prunable records in a short transaction. Prunable excludes pending replays' sources and `protect`. Then vacuum in 256-page steps, with a checkpoint after each. Stop when nothing is prunable, a checkpoint is busy, or a pragma throws (logged without data).
  3. Decide from measured sizes.
- **Accept** has four steps:
  1. **Check, read-only.** Exact-key row: return it or refuse it for different input. Then: not issued, expired, pending cap, missing draft, and missing source (`not-found`). Then build the request and run the completeness and HTTP refusals and the abort check.
  2. **Admit** (`protect: requestId`).
  3. **Write the body file.**
  4. **Commit.** A `BEGIN IMMEDIATE` transaction re-runs every check from step 1, plus source exists and not aborted, inserts `pending`, and commits. Then it deletes the named draft and applies the checkpoint rule. A refusal here rolls back and deletes the body file.

  The order of idempotency checks and caps is unchanged, and a same-key retry needs no storage, so it works when the store is full. Every writer takes the lane, so the re-check normally repeats step 1's answers. It stays so the decision is atomic with the insert.

- **Crash between body write and commit.** Worker start deletes `replay/` files with no pending row.
- **Writes the budget never refuses.** Replay row state changes (dispatch, settle, timeout, recovery) are small, bounded by the 20-pending cap, and needed for safety. A replay's response record is a flow insert. If it is refused, the replay stays `completed` with no `resultRequestId` and detail "Response not stored: …".
- **Visible state.** Capture status adds `storageBlocked: true` while a checkpoint is incomplete, so increasing `droppedFlows` has a visible cause.
- **Honest bound.** Before every write, measured usage plus the estimate is within `maxDiskBytes`. Physical use can briefly exceed it by three amounts:
  - SQLite overhead on the write in progress, about 64 KiB for a 256 KiB flow.
  - The unchecked WAL, at most `walTarget` plus one write.
  - One 1 MiB vacuum step.

  No overshoot persists past the next admission. It is a budget, not a quota.

### Plan changes

- **Task 13 store.**
  - The `meta` table adds `keySecret` (see Finding 2).
  - New "Store lane" bullet.
  - "Storage budget" is rewritten with checkpoint rule, admission, refusals, and bound sub-bullets. It includes the "never refuse a replay state change" rule and the response-not-stored rule.
- **Task 13 Accept.** Rewritten as the four steps check, admit, body, and commit, with orphan-file cleanup at worker start.
- **Injection.** The store's `onStorageStep` observer joins the injected dependencies.
- **Tests (store).**
  - The pressure test now runs on real `node:sqlite` with 200 flows. It asserts the stated bound at every `onStorageStep`, admission before every write, file shrink, and no "database table is locked".
  - New blocked-checkpoint test: an open reader on a second connection. Flows drop with `storageBlocked`, the `-wal` does not grow across five admissions, and after the reader commits the store shrinks and accepts.
  - The unprunable-data test adds the response-not-stored settle.
- **Tests (replay).** New real-`node:sqlite` storage-pressure accept test, with a fake control connection:
  - The source is the oldest prunable request and is protected. Other records are pruned, the file shrinks, nothing throws "locked", the row and body exist, and one `replay` message is sent.
  - A blocked-checkpoint row is refused with storage-full and leaves no row, file, or message.
  - A same-key retry under pressure still returns the replay.
- **Review Focus 9, Task 14 internals and user docs, and self-review byte budgets** now state the new bound and the transaction rule.

## Finding 2: keys claimed to be inspector-issued are not validated as issued

**Verdict: accepted.** This is a real requirement, not loose wording.

### Evidence

- Resolution 4's model said "a key that is malformed, from another `storeId`, or above the high-water mark is refused as not issued". The refusal text said "was not issued by this inspector".
- The `replay_request` description required keys from `preview_replay`.
- The pre-revision checks (plan line 625) were grammar, `storeId`, `seq` at or below the high-water mark, and the floor. The `nonce` was never checked, and minting writes nothing.
- So a key with any nonce change, or a `seq` changed to another value between floor and high-water mark, had no row and passed every check. It was accepted as a new replay. Agents carry these keys as text across turns, so a one-character transcription error is a realistic way to send twice, which the idempotency key exists to prevent.
- Restating the guarantee more narrowly would have left exactly that case uncovered, so a fix was warranted.

### Model

`rk1.<storeId>.<seq>.<nonce>.<tag>`:

- `tag` is the first 32 lowercase hex chars of HMAC-SHA256(`keySecret`, `"rk1.<storeId>.<seq>.<nonce>"`).
- `keySecret` is 32 random bytes in the `meta` table, created with the database.

**Validation.** A key must match a strict canonical grammar: lowercase hex, decimal `seq` with no leading zeros, exact field widths. Its tag text must equal the recomputed tag. Only one spelling passes, so two different strings can't create two rows for one logical key. Any one-character change fails, except with probability 2⁻¹²⁸.

**Unchanged:**

- Minting still writes nothing and reads no clock.
- Keys survive restarts.
- The floor, expiry, and the row-first lookup are unchanged.
- `deleteData` makes a new `storeId` and `keySecret`, so old keys are refused as not issued.
- The high-water check stays. It refuses keys whose `seq` is above the high-water mark.
- A nonce collision makes two Sends share a key. The second gets the first replay back, or is refused for different input. It never sends twice.

**Scope stated in the plan.**

- The tag is an accident and corruption check. It also catches keys from other inspectors.
- It is not an authorization boundary, and it is not stored in `ServerSecretStore`. Anyone who can read `dataDir` is already trusted with the plugin.
- Idempotency covers exact retries of an issued key while its row is kept.
- A caller that deliberately gets a new key is asking for a new replay.
- No exactly-once network delivery is promised.

**Length.** A key is at most 87 chars, so the tool input bound moves from 1-64 to 1-96. The UI keeps keys in bridge `state` unchanged.

**Probe** (`key.mjs`, `node:crypto`). A valid key (73 chars) is issued. Changing `storeId`, `seq` (42→41), `nonce`, or `tag`, uppercasing it, using `seq` `042`, or using a key from another secret all give not-issued. The maximum length is 87.

### Plan changes

- **Decision table, "Long-running mutations".** The HMAC tag, and the exact-retry scope sentence.
- **Review Focus 9.** Altered keys, and the updated test list.
- **Task 13 Replay keys.** Format, grammar, tag, canonical spelling, collision behavior, and restart and clock behavior.
- **Accept step 1.** "Not issued" now means grammar, `storeId`, and tag, or `seq` above the high-water mark. The not-issued message no longer says "Call preview_replay for a key". It warns that the key may have been copied wrong and the original replay may have been sent, and says to get a new key only for an intended new replay.
- **Replay history.** `deleteData` makes a new `storeId` and `keySecret`.
- **Operations.** `replay_request` input is 1-96 chars. Its description says a key protects only exact retries and a new key is a new replay. The `preview_replay` description says retries must pass the key unchanged.
- **New `replay.test.ts` table.** A valid unused key altered in `storeId`, in `seq` within the floor and high-water range, in `nonce` or `tag`, uppercased, with a leading-zero `seq`, or minted by another `dataDir`. Each is refused as not issued with no row, no body file, and no control message. The original is then accepted once. The same alterations of a key that already has a row are refused and never return or duplicate that row.
- **Eval (g).** Now two rows: an expired refusal, and a not-issued refusal from an altered retry key. The agent neither calls `preview_replay` nor replays. It may call `get_replay` for a `replayId` it already holds, and it reports and asks the user. This covers the changed model-facing refusal text, per `evals/README.md`.
- **Task 14 internals.** Why keys carry a tag, and its scope.
- **Self-review.** Key length, and altered keys refused.

## Self-review of the touched plan

- I searched for stale text: "one store transaction", "exceed only by", "1-64", the four-part key form, "Call preview_replay for a key.", unbounded `incremental_vacuum`, and "plus one flow". None remain, except Task 1's unrelated 64-char tool-name limit.
- **Interface propagation.**
  - The key format and the 96-char bound appear only in Task 13: store, keys, operations, tests, and evals. Docs and self-review are updated too.
  - SDK, contracts, `PLUGIN_LIMITS`, the bridge, and mobile and web hosts are untouched. `node:crypto` is a builtin, so the builtins-only `.cjs` rule holds.
  - The panel still takes keys only from `preview_replay`, so the UI is unchanged.
- **Task order and gates.** Unchanged. Everything stays in Task 13, its Step 1 tests and Step 5 evals, plus Task 14 text and the summary tables.
- **Preserved.**
  - Builtin-only backend with embedded addon.
  - Standalone and docked versioned panel hosts.
  - Remote, MCP, provider-matrix, and assistant paths.
  - Bounded envelopes and chunks.
  - Commit-before-handoff dispatch intent and conservative `unknown`.
  - Enqueue-and-query with `seq` merge and reconnect reconciliation.
  - Bounded history, drafts, and pending.
  - Floor-based expiry.

  The subscription-restart concern is not carried over, per the primary.

## Remaining material questions

1. **Checkpoint per write at high body sizes.** With `walTarget = 1 MiB`, a capture of flows larger than 1 MiB checkpoints after nearly every flow. That's one TRUNCATE checkpoint, with its fsync, per flow. I judged that acceptable for a debugging proxy and kept it as a constant. If inspector throughput matters, raise `walTarget` (the bound grows with it) instead of turning autocheckpoint back on.
2. **External readers.** An external process holding a read transaction on `inspector.sqlite` stops capture storage (`storageBlocked`) until it closes. That is the safe direction. Users are told in the user guide.
3. **Open from resolution 4.** Whether `delete_capture` should be refused while it holds a pending replay's source, and whether `preview_replay` should be the key-minting tool or a separate one. Both are still open and unchanged by this resolution. Both are outside these findings.
