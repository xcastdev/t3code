# Synthetic subscription SSE replay fixtures

Every stream in `streams.ts` is synthetic. These are protocol probes, not provider
captures. No reusable historical SSE bytes were found in retained fixture 18–25
homes; their summaries and database records cannot establish capture provenance.

`PiSubscriptionReplay.test.ts` injects fetch into the pinned
`@earendil-works/pi-ai@0.99.1` Codex Responses SDK (OpenAI dependency `7.19.0`).
Broker replays pass the SDK-generated request to the broker and feed validated
bytes back into that SDK. No network, provider CLI, server or model is used.
Fragmentation is deterministic, including single-byte UTF-8 and line boundaries.
Completion joins the SDK, broker, settlement and transport cleanup.

## Compatibility

All 11 original acceptance gaps now have successful broker/SDK parity: unknown
non-tool events and extra event fields, JSON `type` overriding SSE `event:`, `id:`
and `retry:`, multiline `data:` joined with LF, DONE before and after completion,
postterminal events, refusal done without duplicate text, and punctuated call IDs.
Valid subscription SSE also accepts missing or incorrect MIME types. DONE alone
never proves completion or usage. Validated namespace survives SDK history replay.

Both upstream errors remain failures, now classified locally as
`SSE_UPSTREAM_ERROR`. Private provider diagnostics never enter forwarded output,
errors or settlements. Validated failure usage retains the reported model and
usage, settles `failed`, and charges the greater of reservation and report in each
dimension. Without validated usage it settles `unknown`, omits reported usage and
model, and charges reserved input plus 64,000 output. Malformed supplied usage is
rejected; zero usage is never synthesized.

The pinned SDK still has an LF-only multi-frame delimiter limitation: direct CRLF
replay fails with invalid SSE JSON, while broker LF normalization succeeds. This
qualification remains separate from the closed broker gaps. These tests establish
synthetic replay compatibility, not live provider or packaged-worker qualification.

## Tool and safety controls

Ten of the 20 tool probes succeed through both broker and SDK: ordinary calls,
namespace, punctuated call IDs, done-only arguments, deltas without arguments.done,
missing/extra/duplicate/swapped terminal sets, and changed terminal arguments.
Terminal calls are independently validated for advertised names, bounded identities
and object JSON arguments. They never create executable streamed calls.

Unfinished and duplicate live calls still fail in both paths. Eight intentional
SDK differentials remain rejected by the broker: wrong delta index/item identity,
changed arguments.done, changed live final item ID/call ID/name/arguments, and an
unadvertised tool name. SDK permissiveness does not authorize those changes.

Replay controls retain response/frame/count caps, accumulated argument bounds,
usage arithmetic and detail bounds, exact model/request/tool authority, and raw
and decoded credential/account scans. After the first validated terminal, later
output, tools and accounting are ignored, but bounded reading and secret scanning
continue through EOF. Raw trailing echoes span reads; escaped echoes are checked
in complete JSON frames even when the trailing frame lacks its delimiter. A
harmless trailing comment and an exactly-at-budget stream accompany the rejection
controls. Existing broker tests retain authorization and transport cleanup checks.
