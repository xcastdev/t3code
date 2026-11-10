# Review resolution 3: implementation-plan.md

Validator: Opus 5.5 (design subagent). I checked both findings from the primary's third rereview against the current `implementation-plan.md` (Task 13), the approved `design.md`, and the earlier resolution records. Then I revised the plan in place and reread the touched interfaces. `review-resolution.md` and `review-resolution-2.md` are unchanged. The pre-revision copy is at `/tmp/claude-1000/-home-user--local-share-t3-worktrees-t3code-t3-ca5fe124/e314afac-9bbb-48f1-a694-147b93634a19/scratchpad/implementation-plan.before-r3.md`.

No product code changed. I installed nothing, started no servers, made no commits or PRs, and spawned no subagents.

This is not final approval. The primary rereviews it independently.

## Verdicts

| #   | Finding                                                                            | Verdict  |
| --- | ---------------------------------------------------------------------------------- | -------- |
| 1   | A crash can falsely report that a replay was not sent                              | Accepted |
| 2   | Replay status cannot be recovered after a reconnect, and `get_replay` has no `seq` | Accepted |

## 1. False "not sent" after handoff: accepted

**Evidence (pre-revision plan)**

- `addon.py` called `replay.client` and then reported `replayDispatched`. The worker set `dispatched: true` only when that report arrived.
- At worker start, `pending` with `dispatched: false` became `failed` with "Not sent: the plugin stopped." The same rule applied when mitmdump exited.
- The worker may write the `replay` message, and mitmdump may send it upstream, before the acknowledgement is read and persisted. A crash or socket loss in that window therefore turned a request that may have been sent into a definite "not sent". The plan was treating a missing acknowledgement as proof that nothing was sent.

**Model** (smallest conservative one; no new message or state)

- `dispatched` now means that the worker committed its intent to hand the request to mitmdump. The worker commits `dispatched: true` and `dispatchedAt` once a control connection is live, and writes the `replay` message only after that commit. If the commit fails, it writes nothing.
- `replayDispatched` is removed. The addon sends no acknowledgement, and the committed intent is the only dispatch record.
- Every interruption after the commit settles as `unknown`. That covers worker crash and restart, control socket close, a failed socket write, and mitmdump exit or `stop_capture`. The detail is "Interrupted after handoff; the upstream may have received it." The 30 s deadline starts at `dispatchedAt`.
- "Not sent" (`failed`, `dispatched: false`) is now true by construction: nothing reaches the socket before the commit. The transient mitmdump's 10 s startup limit still applies only before the commit.
- `failed` with `dispatched: true` (a mitmproxy error) is labeled "may have been sent". Delivery across power loss is explicitly not promised, and neither is exactly-once delivery.

**Plan changes**

- Decision table, "Long-running mutations": one sentence on commit-before-handoff.
- Review Focus 9 now covers the handoff interruption and its tests.
- Task 13:
  - `replays.dispatched` is defined as committed intent.
  - The addon no longer acknowledges dispatch.
  - The Dispatch, Settle, and Worker start rules and the definiteness rule are updated as above.
  - The `replay_request` description says which outcomes are definite.
  - The panel labels "may have been sent".
- New unit tests in `replay.test.ts`, all using the fake control connection:
  - The message arrives only after `dispatched: true` is visible through a second store connection.
  - Interruption after the write and before any result, as a table of three cases: (1) abandon the service and recover on the same `dataDir` (worker crash), (2) close the control connection (mitmdump crash or disconnect), (3) fail the socket write. Every case ends `unknown`.
  - A failed intent commit writes nothing and settles as not sent.
- New integration test (real mitmdump): `stop_capture` after the upstream received the request and before it answered gives `unknown` with `dispatched: true`.
- Eval (f): with a mocked `unknown`, the agent must not report "not sent".
- Docs (Task 14) and the Task 15 Step 2 manual check are updated.

## 2. Replay status not recoverable after reconnect: accepted

**Evidence (pre-revision plan)**

- `get_replay` returned `{ replayId, state, dispatched, detail?, resultRequestId?, destination }` with no `seq`. The panel was told to "merge by `seq`", which that result could not support.
- Replay items arrived only in `requests` batches, and `requests` snapshots held only request summaries.
- The `get_replay` reconcile ran only "after a remount". The same panel misses a terminal change during a reconnect (Task 2's `hostReconnected` resync) or an overflow resync (Task 7), and then stays pending.
- `requests` requires a `captureId`. A transient replay made with no capture had no topic to arrive on.

**Model** (no replay snapshot and no polling)

- Each replay row has a `seq` from the store-wide counter, bumped on every row change. `get_replay` returns `seq` as read.
- Replay items move to `capture-status` batches, which the panel always holds and which take no params. They are sent on every row change, whatever capture or filter the panel shows. `requests` now carries request summaries only. A replay's result record is an ordinary summary with `replayOf`. The `capture-status` snapshot carries capture state only, with `revision` set to the same `seq` high-water mark.
- Pure module `ui/replayTracker.ts`: it applies a batch item or a `get_replay` result only when the incoming `seq` is greater than the held one. Terminal rows never change again, so a terminal state cannot regress.
- Reconciliation: after every `capture-status` snapshot, the panel calls `get_replay { waitMs: 0 }` once for each tracked `replayId`. That covers first subscribe, remount, reconnect resync, overflow resync, and resubscribe after a worker restart. The subscription is already live, so a change after the query's read arrives as a batch.
- Bounds:
  - The panel tracks at most 20 unsettled replays, and Send is disabled at 20.
  - A terminal merge or `not-found` drops the entry.
  - An entry with a key but no `replayId` (the call timed out before acceptance) shows "Not confirmed" with an explicit Retry that reuses the key. It is never retried automatically.

**Plan changes**

- Task 13: the `replays.seq` column, the `get_replay` result shape, the `capture-status` and `requests` topic definitions, the panel tracker and reconciliation rule, and `ui/replayTracker.test.ts` in the test list. Step 2 now runs `backend` and `ui`.
- New tests:
  - `ui/replayTracker.test.ts`, using a deferred fake `get_replay` and no timers: a terminal change missed during a gap, with two cases (host reconnect resync and overflow resync, terminal batch never delivered), is recovered. A delayed `pending` result after a terminal batch does not regress the state. Tracking cleanup, and no query for a key without a `replayId`.
  - The existing `get_replay` waitMs test also asserts that `seq` increases and matches the `capture-status` item.
- Review Focus 3, Task 15 Step 3 (replay settles while disconnected, then shows completed after restore), and the self-review coverage and budget notes are updated.

## Self-review performed

- **Interfaces:** `get_replay` output (`seq` added), topic item shapes (`replay` items now only on `capture-status`), and the `replays` columns (`seq` added) now agree everywhere they appear. No reference to `replayDispatched`, or to replay items on `requests`, remains.
- **Recovery transitions** (`pending` → terminal): before commit, not sent; after commit, a result, an error, or `unknown`. Worker start, socket close, write failure, mitmdump exit, and the deadline all apply the same rule.
- **Ordering:** commit, then socket write, then result. The panel subscribes, then the snapshot arrives, then it queries, then later batches arrive. Neither path depends on wall-clock timing. Unit tests use the injected timer, deferreds, and a second store connection.
- **Bounds:** `capture-status` batches stay within `maxBatchBytes`. There are at most 20 reconcile calls per snapshot, and each result is small.
- **Task order:** unchanged. All changes are internal to Task 13, its eval, and the Task 14 and 15 text.

## Remaining limits and questions

1. **Resubscribe after `closed { worker-failed }`.** The plan does not say when a panel reopens a subscription that the host closed with `worker-failed`. I did not invent a rule. Reconciliation runs on whatever `capture-status` snapshot comes next. If the primary judges this a gap, the smallest fix is in the bridge or surface: resubscribe when the registry reports the plugin `running` again. That is outside these two findings.
2. **`unknown` is honest but weak.** A late upstream response is still not matched after the deadline or an interruption.
3. **No probes were run.** The commit-before-write ordering is plain worker logic, so it needs no mitmproxy behavior. The new integration case runs under the existing `test:mitmproxy` prerequisite.
4. **Replay rows are never pruned.** Their retention is not specified, as before. They are small, but maintainers may want them pruned with their source capture.
