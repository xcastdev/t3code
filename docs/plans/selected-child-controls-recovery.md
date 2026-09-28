Github Tracked: false
Status: planned
Github Issue: none

# Selected child controls and transcript recovery

## Goal

Make selected-child Stop reliable for Claude and Codex, deliver Codex and T3-managed OpenCode child answers to the immediate owning parent, report capabilities from current native handles, and recover bounded Claude/OpenCode transcript history without duplicate or misordered entries. Do not advertise a provider action until its native path and failure behavior are verified.

## Scope

- In: Claude and Codex selected-child Stop; Codex and T3-managed OpenCode child question and approval handoff; current-session, per-child capabilities; bounded Claude/OpenCode transcript recovery; web, desktop, and mobile status and request outcomes; native approval and denial proof for Claude, Codex, and T3-managed OpenCode.
- Out: Direct child messaging for Claude or Codex; Claude child `AskUserQuestion`; new external OpenCode support; Codex transcript recovery; other providers' actions.

## Acceptance criteria

- [ ] AC-1: Stop targets one live Claude or Codex child and completes only after that native child reports stopped. Duplicate in-flight requests do not issue duplicate native stops. A handle stale before dispatch is rejected as failed; uncertainty after native dispatch returns unknown without retry. The parent and siblings continue.
- [ ] AC-2: A child question/request and its resolution use the same public identity in the child view and parent thread. The wire change is additive: existing clients' legacy answers records remain accepted and are normalized as an answered resolution; a tagged answered/cancelled resolution is used only when the server advertises support. For answered resolutions, preserve exact answer strings, including empty strings, and explicit skipped question IDs; an absent value remains distinct from an empty value and is never inferred to be cancellation. Cancellation is sent only through adapters with a native cancellation operation; unsupported adapters never emulate it with empty answers. Codex and T3-managed OpenCode record the parent handoff status independently from native request settlement and show both in web and mobile. Handoff states are pending, recorded, unavailable, failed, and unknown; recorded means the handoff was durably accepted by its delivery mechanism, not consumed by the parent model. Handoff failure does not strand native settlement or claim the requested operation succeeded, and nested Codex handoff is never redirected to root. Claude child AskUserQuestion stays unsupported.
- [ ] AC-3: Capability states describe the current provider session generation, child identity, and pending request. Inactive known-provider messaging is unsupported. Claude/Codex messaging is unsupported. Unknown identity with a live session is unverified. Controls are actionable only when the corresponding capability is supported and show a provider-specific reason otherwise.
- [ ] AC-4: Claude and OpenCode expose bounded native transcript recovery through the existing getAgentTranscriptPage flow. Persist native entries as append-only revisions: each revision has a new persisted eventSequence, while all revisions for one provider message/block retain a stable nativeEntryId and providerOrderKey. The client entry exposes nativeEntryId, providerOrderKey, and eventSequence for the latest revision. Merge chooses the highest eventSequence for a stable native identity but sorts and keyset-pages by providerOrderKey plus nativeEntryId, so a later text revision updates content without moving the entry in chronology. Cursors carry independent native-source, persisted-revision-watermark, and chronological keyset positions. eventSequence is never the sole chronology or paging key. Ingestion waits for a bounded persistence receipt before claiming recovered entries. Failed or incomplete recovery remains retryable and visibly partial. Stream/snapshot merges deduplicate by native message and block identity, and child narration never appears in the parent transcript.
- [ ] AC-5: For Claude, Codex, and T3-managed OpenCode, native probes exercise both approval and denial, capture the actual next model-facing parent context and final answer, and verify immediate-parent/sibling isolation. Codex and T3-managed OpenCode probes also answer a native child question and verify the exact native answer and parent context. A fixture-only test or previous OpenCode approval trace does not satisfy this criterion.

## Proposed design and decisions

Keep the existing `supported` / `unsupported` / `unverified` contract values and reasons. Resolve capabilities using a current session-generation-bound native handle. A known provider with no active session cannot execute a message or stop; report unsupported with a reason. Use unverified only when an active session exists but native ownership or status cannot be confirmed. Keep `message` unsupported for Claude and Codex regardless of `canAcceptDirectInput` metadata.

Represent user-input resolution additively. Keep the legacy answers record and existing respond command accepted, normalize a legacy record as answered without inferring skipped or cancelled fields, and add a tagged answered/cancelled form behind a negotiated server capability. An answered value preserves exact strings (including empty strings) and explicit skipped question IDs; absence stays absent. Adapters declare whether native cancellation is supported and map cancellation only when the provider has a native operation. An adapter without that operation rejects cancellation as unsupported instead of sending empty answers.

Persist handoff delivery separately from native request settlement using pending, recorded, unavailable, failed, and unknown. A recorded handoff means the provider-specific delivery mechanism accepted durable context; it does not mean the parent model consumed or mentioned it. If handoff fails, still settle the native request when possible and surface the separate status in both clients. Missing handoff delivery after a restart is unknown, not recorded or failed.

Add an optional provider adapter page-read operation for native child transcripts. Keep the public getAgentTranscriptPage RPC and persisted projection as the client-facing path. The server fetches at most one bounded native page, appends native item revisions in provider order, waits for the typed persistence receipt, then reads the projection page. Each item revision has a new eventSequence, but retains stable nativeEntryId and providerOrderKey; the projection returns the latest revision sequence/content without changing chronological identity. Expose providerOrderKey in transcript entries and use (providerOrderKey, nativeEntryId) keyset paging. The opaque cursor keeps separate native-source cursor, persisted-revision watermark, and chronological page boundary. Decode legacy cursor payloads: resolve their existing sequence/activity tuple to a providerOrderKey when possible; if the referenced row is unavailable, restart from a documented safe boundary and mark the page partial rather than interpreting an event sequence as provider chronology. Keep Claude forwardSubagentText disabled unless adapter tests prove child attribution, no parent leakage, and no duplicate snapshot/delta output.

## Plan

- [ ] P1: `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `CodexAdapter.ts`, and `CodexSessionRuntime.ts`: implement dedicated selected-child Stop using Claude `stopTask(taskId)` and Codex child thread/turn identity. Validate session generation before dispatch. Register the matching native completion observer before sending the stop request. Coalesce duplicate in-flight stops by child key and generation. Reject stale pre-dispatch handles; after dispatch, report unknown if native completion is not observed within the bounded wait. Do not call Codex's stop-all `interruptTurn`. Add Claude/Codex adapter and runtime tests for duplicate commands, pre-dispatch staleness, timeout-after-dispatch, replacement generation, completed children, and parent/sibling isolation.
- [ ] P2: `apps/server/src/provider/Services/ProviderAdapter.ts`, `Services/ProviderService.ts`, and `Layers/ProviderService.ts`: resolve capabilities and reasons from current provider and child state; remove OpenCode-specific generic reasons. Return unsupported for inactive known-provider messaging and unsupported Claude/Codex messaging; return unverified only for an active but unresolved child/request. Update `packages/client-runtime/src/state/subagentRuntime.ts`, web `AgentsPanel.tsx`, and mobile `AgentTranscriptSheet.tsx` to expose only supported controls and display the reason. Add provider-service, client-state, web, and mobile behavioral tests.
- [ ] P3: Add the backward-compatible typed user-input resolution and handoff status across packages/contracts/src/orchestration.ts, providerRuntime.ts, provider.ts, and rpc.ts; apps/server/src/orchestration/decider.ts and Layers/ProviderCommandReactor.ts; provider Services/ProviderService.ts and Layers/ProviderService.ts; CodexSessionRuntime.ts; OpenCodeApprovalBridge.ts and OpenCodeAdapter.ts; and packages/client-runtime/src/operations/commands.ts. Preserve the legacy answers record and existing command/event payload. Add a tagged answered/cancelled variant and advertise it through a server capability; clients serialize the new form only when that capability is present, while old clients and older servers continue using the legacy answer command. Normalize legacy answers without converting absent fields to empty strings, skipped values, or cancellation. Add optional adapter cancellation only for providers with a real native cancel operation; unsupported providers return a typed unsupported result without calling native answer APIs. Persist handoff state (pending/recorded/unavailable/failed/unknown) keyed by public request ID, native request ID, child key, and session generation, independently from native settlement. Codex records an answered choice in the verified immediate parent's model history before releasing the child request; nested injection rejection records unavailable and never redirects to root. T3-managed OpenCode records the resolution in the parent-session bridge before native reply. A handoff error never prevents native settlement once the request is claimed. Web and mobile show native resolution and handoff state separately. Add contract and rpc round trips for both legacy and negotiated payloads, ProviderService and ProviderCommandReactor routing/recovery tests, client command serialization tests, same-ID parent/child tests, empty-versus-absent/skipped tests, provider-native cancellation mapping tests, duplicate resolution, interrupted/failed handoff, nested Codex rejection, and UI status tests.
- [ ] P4: Add bounded provider page readers and append-only transcript revision projection across apps/server/src/provider/Services/ProviderAdapter.ts, Layers/ClaudeAdapter.ts, Layers/OpenCodeAdapter.ts, Layers/ProviderService.ts, apps/server/src/ws.ts, orchestration/agentTranscriptCursor.ts, Layers/ProjectionSnapshotQuery.ts, Layers/ProviderRuntimeIngestion.ts, and packages/client-runtime/src/state/subagentRuntime.ts. Claude reads the selected child with the SDK reader and bounded limit/offset; OpenCode reads session.messages for the validated child session with its native cursor. Give every provider message/block a stable nativeEntryId and stable providerOrderKey. Append a new persisted revision event for each content change with a fresh eventSequence; project the highest revision sequence per nativeEntryId while preserving providerOrderKey. Expose providerOrderKey and latest-revision eventSequence in the page entry. Order pages by the keyset tuple (providerOrderKey, nativeEntryId), never eventSequence alone; use eventSequence only as the persisted revision catch-up watermark/tie-breaker. Version agentTranscriptCursor.ts to encode the chronological tuple plus independent native-source cursor and persisted-revision watermark. Continue decoding legacy cursor sequence/activity tuples by resolving the referenced row to providerOrderKey; if resolution is impossible, restart at a safe boundary and mark partial. Ingest fetched entries in provider order and wait for a bounded typed receipt/watermark before returning the page. Bound page rows and payload bytes; on read/ingestion failure retain a retryable source cursor and return partial status. Extend ingestion/projection tests for append-only revisions, latest-revision selection, stable chronology, explicit order-key paging, native-vs-persisted cursor progression, legacy cursor decoding, receipt barriers, initial/mid-walk failures, reconnect catch-up and 1,000-row retention, and dedupe. Extend subagentRuntime.test.ts, AgentsPanel.test.tsx, and AgentTranscriptSheet.test.tsx for order-key sorting, cursor progression, retry/partial state, and recovered old text later extended by live output (same identity/order key, newer revision wins). Assess forwardSubagentText with child-only and concurrent-sibling fixtures; enable only if native IDs support leak-free deduplication.
- [ ] P5: Add an opt-in native proof harness at `apps/server/src/provider/Layers/SubagentNativeHandoff.native.test.ts`. Run it against disposable provider sessions and temporary workspaces, capture provider versions and native request IDs, record the next model-facing parent context before inference and the actual final answer, and verify sibling isolation. Run a fresh approve and deny case for each of Claude, Codex, and T3-managed OpenCode. Also run question/answer cases for Codex and T3-managed OpenCode. Do not reuse the previous OpenCode approval trace as proof of these changes. If credentials or a native child request are unavailable, record the exact failing stage and leave the affected capability unverified.
- [ ] P6: Run the focused test, typecheck, lint, and native-proof commands below. Review `docs/user/chat-timeline.md` and update it only if the current instructions are inaccurate. Do not run a T3 dev server, browser, or simulator as part of this plan; an integrated client pass remains with the primary agent and requires explicit user approval.

## Validation

Provider adapter and orchestration tests:

```bash
vp test run apps/server/src/provider/Layers/ClaudeAdapter.test.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/CodexSessionRuntime.test.ts apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts apps/server/src/provider/Layers/OpenCodeAdapter.test.ts apps/server/src/provider/OpenCodeApprovalBridge.test.ts apps/server/src/provider/Layers/ProviderService.test.ts
```

```bash
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts apps/server/src/orchestration/agentTranscriptCursor.test.ts apps/server/src/orchestration/decider.questionAttachments.test.ts apps/server/src/orchestration/decider.userInputDismiss.test.ts
```

Contracts and clients (mobile activity test path is `apps/mobile/src/lib/threadActivity.test.ts`):

```bash
vp test run packages/contracts/src/orchestration.test.ts packages/contracts/src/provider.test.ts packages/contracts/src/providerRuntime.test.ts packages/contracts/src/rpc.test.ts packages/contracts/src/providerCommands.test.ts packages/client-runtime/src/operations/commands.test.ts packages/client-runtime/src/state/subagentRuntime.test.ts packages/client-runtime/src/pendingRequests.test.ts apps/web/src/components/AgentsPanel.test.tsx apps/mobile/src/features/threads/AgentTranscriptSheet.test.tsx apps/mobile/src/lib/threadActivity.test.ts
```

WebSocket page recovery (the test covers the getAgentTranscriptPage RPC through ws.ts):

```bash
vp test run apps/server/src/server.test.ts -t 'routes bounded subagent transcript reads through the shared WebSocket RPC'
```

Run the new opt-in native tests separately. These commands are safe only when the harness uses a temporary workspace/home, keeps OpenCode bound to loopback on an ephemeral port, and cleans up the captured provider process/session. Provider credentials must come from the normal provider login; do not copy secrets or point T3 at live userdata.

```bash
T3_NATIVE_SUBAGENT_PROOF=1 vp test run apps/server/src/provider/Layers/SubagentNativeHandoff.native.test.ts -t 'Claude approval|Claude denial'
T3_NATIVE_SUBAGENT_PROOF=1 vp test run apps/server/src/provider/Layers/SubagentNativeHandoff.native.test.ts -t 'Codex approval|Codex denial|Codex question'
T3_NATIVE_SUBAGENT_PROOF=1 vp test run apps/server/src/provider/Layers/SubagentNativeHandoff.native.test.ts -t 'OpenCode approval|OpenCode denial|OpenCode question'
```

Targeted typechecks:

```bash
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts --filter @t3tools/client-runtime --filter @t3tools/web --filter @t3tools/mobile typecheck
```

Scoped lint on planned changed files:

```bash
vp lint \
  apps/server/src/provider/Services/ProviderAdapter.ts \
  apps/server/src/provider/Services/ProviderService.ts \
  apps/server/src/provider/Layers/ProviderService.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/Layers/ClaudeAdapter.ts \
  apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/CodexSessionRuntime.ts \
  apps/server/src/provider/Layers/CodexSessionRuntime.test.ts \
  apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts \
  apps/server/src/provider/Layers/OpenCodeAdapter.ts \
  apps/server/src/provider/Layers/OpenCodeAdapter.test.ts \
  apps/server/src/provider/OpenCodeApprovalBridge.ts \
  apps/server/src/provider/OpenCodeApprovalBridge.test.ts \
  apps/server/src/provider/Layers/SubagentNativeHandoff.native.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/agentTranscriptCursor.ts \
  apps/server/src/orchestration/agentTranscriptCursor.test.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts \
  apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
  apps/server/src/ws.ts \
  apps/server/src/server.test.ts \
  packages/contracts/src/orchestration.ts \
  packages/contracts/src/orchestration.test.ts \
  packages/contracts/src/providerRuntime.ts \
  packages/contracts/src/providerRuntime.test.ts \
  packages/contracts/src/provider.ts \
  packages/contracts/src/provider.test.ts \
  packages/contracts/src/rpc.ts \
  packages/contracts/src/rpc.test.ts \
  packages/contracts/src/providerCommands.test.ts \
  packages/client-runtime/src/operations/commands.ts \
  packages/client-runtime/src/operations/commands.test.ts \
  packages/client-runtime/src/state/subagentRuntime.ts \
  packages/client-runtime/src/state/subagentRuntime.test.ts \
  packages/client-runtime/src/pendingRequests.ts \
  packages/client-runtime/src/pendingRequests.test.ts \
  apps/web/src/components/AgentsPanel.tsx \
  apps/web/src/components/AgentsPanel.test.tsx \
  apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx \
  apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx \
  apps/mobile/src/features/threads/AgentTranscriptSheet.tsx \
  apps/mobile/src/features/threads/AgentTranscriptSheet.test.tsx \
  apps/mobile/src/features/threads/PendingApprovalCard.tsx \
  apps/mobile/src/features/threads/PendingUserInputCard.tsx \
  apps/mobile/src/lib/threadActivity.ts \
  apps/mobile/src/lib/threadActivity.test.ts \
  --report-unused-disable-directives
```

```bash
git diff --check
```

## Risks and rollback notes

- Claude child `AskUserQuestion` is unavailable in the Agent SDK; do not surface it as supported. [Claude SDK user-input documentation](https://code.claude.com/docs/en/agent-sdk/user-input)
- Codex may reject `thread/inject_items` for nested V2 parent threads. In that case the native answer can settle, but handoff remains explicitly unavailable; never redirect to root.
- OpenCode’s decision bridge applies to T3-managed instances only. External OpenCode remains deferred.
- Native snapshot reads can race with live deltas. Preserve separate cursors, immutable event sequence, stable provider identities, bounded ingestion receipts, and visible partial state.
- Wire changes must be additive and capability-negotiated: preserve legacy user-input answer records and legacy transcript cursor decoding while new clients and servers roll forward independently. Do not change existing field meanings or reinterpret absent values. Transcript revision storage must remain append-only; if stable provider order cannot be represented, keep recovery partial rather than falling back to eventSequence as chronology.

## Outcome

Not implemented. This is the implementation plan draft awaiting Astra’s final spot-check. The existing `docs/plans/per-subagent-transcripts-controls.md` remains untouched.

## Suggested slug

`selected-child-controls-recovery`

READY_TO_SAVE
