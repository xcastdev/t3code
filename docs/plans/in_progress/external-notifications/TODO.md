# External Notifications — TODO

Implementation and focused P5–P7 evidence now exist. P9 independent validation and revalidation remain open; do not treat implementation presence as completion.

## P0 — Baseline / Fail-First

- [x] P0-PROV Record baseline revision `d94577e5c5cfaacc3225c1d06bf0506184514420` — `LEDGER.md#p0-baseline`
- [x] P0-PROV Record candidate revision `WORKTREE@d94577e5c5cfaacc3225c1d06bf0506184514420` — `LEDGER.md#p0-baseline`
- [x] P0-SCOPE Verify `declaredScopeDigest` matches current changed files — `LEDGER.md#p0-baseline`
- [x] P0-SCOPE Record `currentChangedFilesDigest` — `LEDGER.md#p0-baseline`
- [x] P0-FAIL Audit dirty edits in `apps/server/src/serverSettings.ts` and `packages/contracts/src/settings.ts` as non-authoritative against declared scope — `LEDGER.md#p0-baseline`

## P1 — Contracts

- [x] AC-01 Add `externalNotifications` to settings schema in `packages/contracts/src/settings.ts` — `LEDGER.md#p1-ac-01`
- [x] AC-01 Write/update `packages/contracts/src/settings.test.ts` for defaults, validation, unknown kinds, blank IDs/labels, invalid scheme/variant, atomic replacement, unrelated patch isolation — `LEDGER.md#p1-ac-01`
- [x] AC-04 Add payload schema/type for notification payload in `packages/contracts/src/externalNotifications.ts` — `LEDGER.md#p1-ac-04`
- [x] AC-05 Add deep link encoding helpers (independently encoded env/thread IDs) — `LEDGER.md#p1-ac-05`
- [x] AC-10 Add operate test RPC schema to `packages/contracts/src/rpc.ts` — `LEDGER.md#p1-ac-10`
- [x] Update barrel exports in `packages/contracts/src/index.ts` — `LEDGER.md#p1-ac-01`

## P2 — Settings / Secrets

- [x] AC-01 Implement `externalNotifications` patch handling in `apps/server/src/serverSettings.ts` — `LEDGER.md#p2-ac-01`
- [x] AC-01 Write/update `apps/server/src/serverSettings.test.ts` for atomic replacement and patch isolation — `LEDGER.md#p2-ac-01`
- [x] AC-02 Implement deterministic secret key derivation by destination ID — `LEDGER.md#p2-ac-02`
- [x] AC-02 Integrate `ServerSecretStore` for URL persistence (conditional) — `LEDGER.md#p2-ac-02`
- [x] AC-02 Implement redaction, replacement, removal, and stale cleanup — `LEDGER.md#p2-ac-02`
- [x] AC-02 Validate existing `ServerSecretStore` integration through server-settings tests; no direct store changes required — `LEDGER.md#p2-ac-02`

## P3 — Home Assistant Adapter

- [x] AC-03 Create `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts` — `LEDGER.md#p3-ac-03`
- [x] AC-03 Implement POST JSON with content-type, bounded timeout, 2xx success — `LEDGER.md#p3-ac-03`
- [x] AC-03 Sanitize errors for malformed/unavailable/timeout/transport/non-2xx — `LEDGER.md#p3-ac-03`
- [x] AC-04 Implement payload construction with `schemaVersion`, `test: false`, `environmentId`, `threadId`, `state|null`, optional titles, phase/headline/detail, relative route, deep link — `LEDGER.md#p3-ac-04`
- [x] AC-04 Ensure unavailable metadata consistently null/omitted without fabrication — `LEDGER.md#p3-ac-04`
- [x] AC-05 Implement deep link: `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>` — `LEDGER.md#p3-ac-05`
- [x] Write `apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts` — `LEDGER.md#p3-ac-03`

## P4 — Dispatcher

- [x] AC-06 Create `apps/server/src/notifications/ExternalNotificationDispatcher.ts` — `LEDGER.md#p4-ac-06`
- [x] AC-06 Implement bounded fanout: every enabled configured destination attempted, disabled/unconfigured skipped — `LEDGER.md#p4-ac-06`
- [x] AC-06 Ensure failures isolated; works without cloud/relay credentials — `LEDGER.md#p4-ac-06`
- [x] AC-07 Implement per-destination/thread deduplication: unchanged/timestamp-only suppressed — `LEDGER.md#p4-ac-07`
- [x] AC-07 Ensure identity advances only on success — `LEDGER.md#p4-ac-07`
- [x] AC-07 New/configured destination receives current state without existing resend — `LEDGER.md#p4-ac-07`
- [x] AC-10 Implement test bypass: direct test, no normal identity mutation/fanout — `LEDGER.md#p4-ac-10`
- [x] Write `apps/server/src/notifications/ExternalNotificationDispatcher.test.ts` — `LEDGER.md#p4-ac-06`

## P5 — Awareness / Relay Integration

- [x] AC-08 Modify `apps/server/src/relay/AgentAwarenessRelay.ts` to move canonical processing before sink gates — `LEDGER.md#p5-ac-08`
- [x] AC-08 Preserve filtering, thread ID extraction, projection, meaningful identity, unchanged suppression, startup replay, transient tombstone, confirmation, sanitization — `LEDGER.md#p5-ac-08`
- [x] AC-07 Add dispatcher as sibling sink with separate identity — `LEDGER.md#p5-ac-07`
- [x] AC-06 Ensure relay works absent/failing external; external works absent/disabled/failing relay — `LEDGER.md#p5-ac-06`
- [x] AC-09 Ensure signed payload and identity unchanged; relay tests pass — `LEDGER.md#p5-ac-09`
- [x] AC-08 Startup replay independent of relay; settings-change re-enqueue through same worker — `LEDGER.md#p5-ac-08`
- [x] Write/update `apps/server/src/relay/AgentAwarenessRelay.test.ts` — `LEDGER.md#p5-ac-08`

## P6 — RPC / Client

- [x] AC-10 Add operate test RPC handler in `apps/server/src/ws.ts` — `LEDGER.md#p6-ac-10`
- [x] AC-10 Operate-authorized, exactly selected configured destination, synthetic `test: true` — `LEDGER.md#p6-ac-10`
- [x] AC-10 Read-only/unauth rejected; sanitized errors — `LEDGER.md#p6-ac-10`
- [x] AC-11 Add environment command in `apps/server/src/server.ts` — `LEDGER.md#p6-ac-11`
- [x] AC-11 Update `packages/client-runtime/src/state/server.ts` — `LEDGER.md#p6-ac-11`
- [x] Write/update `apps/server/src/server.test.ts` additions — `LEDGER.md#p6-ac-10`
- [x] Write/update `packages/client-runtime/src/state/server.test.ts` additions — `LEDGER.md#p6-ac-11`

## P7 — Web Settings

- [x] AC-12 Integrate external notifications into `apps/web/src/components/settings/IntegrationsSettings.tsx` — `LEDGER.md#p7-ac-12`
- [x] AC-12 Implement scheme/add/label/enable/disable/replace/test/remove/Configured — `LEDGER.md#p7-ac-12`
- [x] AC-12 Never display URL; read-only when disabled; selected remote environment; truthful save/test failure — `LEDGER.md#p7-ac-12`
- [x] AC-12 Browser settings unaffected — `LEDGER.md#p7-ac-12`
- [x] Write `apps/web/src/components/settings/ExternalNotificationsSettings.logic.test.ts` — `LEDGER.md#p7-ac-12`
- [x] Write `apps/web/src/components/settings/IntegrationsSettings.environment.test.tsx` — `LEDGER.md#p7-ac-12`

## P8 — Docs

- [x] AC-13 Create `docs/user/external-notifications.md` — `LEDGER.md#p8-ac-13`
- [x] AC-13 Cover HA setup, payload, URI example, schemes, secrets/redaction — `LEDGER.md#p8-ac-13`
- [x] AC-13 Note HA not Cloud delivers push — `LEDGER.md#p8-ac-13`
- [x] AC-13 Note free iOS Personal Team builds expire in 7 days — `LEDGER.md#p8-ac-13`

## P9 — Validation / Revalidation

- [x] P9-FMT Run `vp fmt --check` followed by actual changed paths — `LEDGER.md#p9-fmt`
- [x] P9-TEST Run focused test suite for implemented test files — `LEDGER.md#p9-test`
- [x] P9-TYPE Run `vp run typecheck` from each package workdir — `LEDGER.md#p9-type`
- [x] P9-RELAY Run relay regression — `LEDGER.md#p9-relay`
- [x] P9-SCOPE Run git status, diff, check against baseline — `LEDGER.md#p9-scope`
- [ ] P9-VAL Independent validator on same candidate — `LEDGER.md#p9-val`
- [ ] P9-REVAL Independent revalidator on same candidate (high-risk requirement) — `LEDGER.md#p9-reval`
