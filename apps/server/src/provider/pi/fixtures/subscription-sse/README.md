# Synthetic subscription SSE replay fixtures

Every stream in `streams.ts` is synthetic. These are protocol probes, not raw provider
captures. No reusable historical SSE bytes were found in the retained fixture 18–25
homes; their summaries and database records cannot establish capture provenance.
The older subscription broker test streams are synthetic too.

`PiSubscriptionReplay.test.ts` injects fetch into the installed, pinned
`@earendil-works/pi-ai@0.99.1` Codex Responses SDK (OpenAI dependency `7.19.0`).
Each broker replay passes the SDK-generated request to the existing broker and feeds
its forwarded bytes back into the SDK. No network, provider CLI, server, or model
is used. Responses are rebuilt for every invocation; fragmentation is deterministic,
including one-byte reads through emoji and line boundaries. Completion waits for
both the SDK and broker, including settlement and transport drain.

The shared `PiSubscriptionTestKit.ts` extracts the original event/success/model and
broker fixture without changing their defaults, returned handles, or accounting.
The existing 124 broker cases remain behaviorally unchanged.

## Current compatibility baseline

There are **13 explicitly qualified broker parity-gap scenarios**: 11 acceptance
mismatches and two upstream-error classification mismatches. They pass as assertions
of the current typed rejection, not skipped tests or production fixes.

| Synthetic probe                        | Pinned SDK oracle                      | Current broker                          |
| -------------------------------------- | -------------------------------------- | --------------------------------------- |
| Unknown non-tool event                 | Completion, text, usage                | `SSE_FRAME_INVALID`                     |
| Extra non-tool event fields            | Completion, text, usage                | `SSE_FRAME_INVALID`                     |
| Conflicting SSE `event:` / JSON `type` | JSON `type` wins                       | `SSE_FRAME_INVALID`                     |
| `id:` control                          | Ignored                                | `SSE_FRAME_INVALID`                     |
| `retry:` control                       | Ignored                                | `SSE_FRAME_INVALID`                     |
| Multiline `data:` JSON                 | Lines joined with LF                   | `SSE_FRAME_INVALID`                     |
| `[DONE]` before completion             | Ignored                                | `SSE_ACCOUNTING_REQUIRED`               |
| `[DONE]` after completion              | Ignored after terminal                 | `SSE_FRAME_INVALID`                     |
| Postterminal event                     | Ignored after terminal                 | `SSE_FRAME_INVALID`                     |
| Refusal with `response.refusal.done`   | Delta is text; done ignored            | `SSE_FRAME_INVALID`                     |
| Punctuation in `call_id`               | Composite `call_id\|item.id` preserved | `SSE_FRAME_INVALID`                     |
| `error` after creation                 | Upstream failure, zero usage           | `SSE_FRAME_INVALID`, unknown accounting |
| `response.failed` after creation       | Upstream failure, zero usage           | `SSE_FRAME_INVALID`, unknown accounting |

For the two upstream errors, rejection and lack of reported usage already agree;
the gap is classification. The broker omits provider messages from its error and
settlement, and charges the existing 64k output unknown maximum. Trailing-frame
rejections after validated completion instead settle as failed with reported usage;
they are not unknown-usage cases.

One separate **SDK limitation** is recorded: multi-frame CRLF is not delimited by
this pinned SDK's LF-only parser. The direct oracle fails with invalid SSE JSON,
while broker normalization lets the same fragmented bytes complete through the SDK.
It is not counted in the 13 broker gaps.

## Reconciliation observations and retained guards

The 20 tool probes include four successful broker/SDK controls: ordinary calls,
namespace preservation, arguments supplied by `arguments.done` without deltas, and
deltas/finalization without `arguments.done`. Punctuation is the compatibility gap
above. Two malformed streams fail in both paths: unfinished calls and duplicate
added calls that leave an unfinished SDK slot.

The other **13 tool differential probes** record SDK success versus current broker
`SSE_TOOL_INVALID`: missing/extra/duplicate/swapped terminal calls, wrong delta
index/item ID, changed arguments.done, changed final item ID/call ID/name/arguments,
changed terminal arguments, and undeclared tool name. These mix reconciliation
observations with authority controls. They are not counted as 13 additional defects
or an instruction to adopt SDK permissiveness. In particular, terminal set equality
is only today's behavior. S1b separately owns its accept/ignore/reject design, and
the user plan calls for relaxing exact terminal-set matching.

Positive controls accompany the retained guards: valid declared tools, normal usage,
comments and split UTF-8, a harmless trailing comment, and a stream exactly at the
kept-byte budget. Negative controls exercise undeclared names, inconsistent/negative/
missing usage, absent terminal usage, one byte over the kept-byte budget, escaped
credential/account echoes in unknown fields, and raw trailing echoes split across
reads. Trailing echo checks omit the final LF to exercise raw scanning before line
parsing. The SDK may ignore trailing frames; the broker must still scan their bytes.
