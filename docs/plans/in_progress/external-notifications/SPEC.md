# External Notifications — Specification

## Problem / Outcome

The current personal awareness push path is relay/T3 Connect credential-dependent. There is no direct server-owned user destination path and no external webhook secret lifecycle. External Notifications adds a server-authoritative, adapter-neutral delivery mechanism so that awareness state changes can reach user-configured external endpoints (Home Assistant and future static adapters) without depending on relay or cloud credentials.

## Confirmed Root Cause

Current personal awareness push is relay/T3 Connect credential-dependent; no direct server-owned user destination path; no external webhook secret lifecycle.

## Hypotheses

Exact title/model metadata sources are non-blocking implementation research only. All product and architecture decisions are resolved.

## Scope

### In Scope

- Server-authoritative settings with `externalNotifications` patch
- Schemes: `t3code-dev`, `t3code-preview`, `t3code` (default `t3code-dev`)
- Multiple stable destinations per environment
- Static union of adapter kinds (closed/ exhaustive compiler)
- Home Assistant adapter (first adapter)
- Canonical awareness flow integration
- Isolated per-destination fanout
- Per-destination/thread identity and deduplication
- Secret lifecycle (persistence, redaction, staleness cleanup)
- Operate test RPC
- Environment command
- Web Integrations UI
- Focused docs and tests

### Out of Scope

- Replacing relay
- Direct APNs/FCM
- Plugin system
- Retries/history/guaranteed delivery
- Mobile UI
- Awareness policy changes
- Git/tracking/browser use

## Invariants

- Preserve `AgentAwarenessRelay` filtering, thread ID extraction, projection, meaningful identity excluding timestamps, unchanged suppression, startup replay, transient tombstone and initial-completed confirmation, sanitization.
- Relay and external sinks are independent.
- Adding a destination receives current state without resending existing destinations.
- Atomic settings patches.
- Read-only inspection only; no mutation/test from outside.
- No URL crossing client boundary.

## Acceptance Criteria

### AC-01 — Contract defaults/validation

Absent config => `t3code-dev` + `[]`. Valid schemes and HA variant accepted. Unknown kinds, blank IDs/labels, invalid scheme/variant rejected. External config/destination arrays atomically replaced. Unrelated patches do not materialize an `externalNotifications` patch.

### AC-02 — Secret confidentiality

URL only in `ServerSecretStore`; never in `settings.json`, WebSocket, streams, caches, logs/errors. Redacted resubmission preserves existing. Replacement replaces. Clear/remove removes. Stale cleanup.

### AC-03 — Home Assistant HTTP

POST JSON with `content-type`, bounded timeout; all 2xx success. Malformed/unavailable/timeout/transport/non-2xx sanitized. No request when disabled/unconfigured.

### AC-04 — Payload

`schemaVersion`, `test: false`, `environmentId`, `threadId`, `state|null`, optional project/thread/model titles and phase/headline/detail, relative route, deep link. Unavailable metadata consistently null/omitted without fabrication.

### AC-05 — Deep link

Exactly `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>`, independently encoded. Selected scheme used for real and test.

### AC-06 — Fanout/isolation

Every enabled configured destination attempted. Disabled/unconfigured skipped. Failures isolated. Works without cloud/relay credentials.

### AC-07 — Destination-aware dedupe

Unchanged/timestamp-only suppressed per destination/thread. New/configured destination gets current state without existing resend. Identity advances only on success.

### AC-08 — Awareness semantics

Same filtering/projection/startup replay/unchanged suppression/transient confirmation as current relay path.

### AC-09 — Relay compatibility

Relay tests pass. Relay works absent/failing external. External works absent/disabled/failing relay. Signed payload and identity unchanged.

### AC-10 — Test operation

Operate-authorized, exactly selected configured destination, synthetic `test: true`, no normal identity mutation/fanout. Read-only/unauth rejected. Sanitized errors.

### AC-11 — Client command

Environment-scoped, targets selected environment. Exposes success/auth/sanitized failure.

### AC-12 — Web Settings

Scheme/add/label/enable/disable/replace/test/remove/Configured. Never display URL. Read-only when disabled. Selected remote environment. Truthful save/test failure. Browser settings unaffected.

### AC-13 — Docs

HA setup, payload, URI example, schemes, secrets/redaction, HA not Cloud delivers push, free iOS Personal Team builds expire in 7 days and require reinstall.

## Contract / Security / Ordering / Persistence / Concurrency / Failure Semantics

- **Contract:** Closed union / exhaustive compiler. Old settings decode to empty. Destination collection whole replacement.
- **Security:** URL is credential. No filesystem/provider/relay secret payload.
- **Ordering:** Same-thread canonical ordering. Bounded destination concurrency.
- **Persistence:** Settings semaphore. Descriptors durable/settings, URL durable/secrets, identity process-local.
- **Concurrency:** Settings semaphore guards writes. Bounded cross-destination fanout. Same-thread worker ordering preserved.
- **Failure:** Failures never terminate awareness/relay. Test failures returned to caller.

## Decisions

- Home Assistant first but adapter-neutral.
- Static adapters (closed union).
- Canonical awareness flow.
- Sibling independent sinks.
- Atomic destination map/list.
- Per-destination/thread dedupe.
- Test bypass (direct, not via awareness).
- `t3code-dev` default scheme.
- High-risk evidence tier.

## Assumptions

- Target is prior external feature despite empty arguments.
- At-most-once suppression per process sufficient.
- Web only for UI.
- Partial work is non-authoritative.

## Open Questions

None. All remaining work is implementation research only.

## Constraints / Risks

- URL leaks
- Non-atomic settings/secret
- Relay gate coupling
- Global dedupe
- Identity before success
- Replay bypass ordering
- Concurrent duplicate
- Remote auth
- Brittle mocks
- Partial edits may be restructured

## Readiness

Ready for implementation per saved plan.
