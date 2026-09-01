# External Notifications — Implementation Plan

## Goal

Implement server-authoritative external notifications with Home Assistant adapter, secret lifecycle, canonical awareness integration, and Web UI — all gated by the 13 acceptance criteria.

## Metadata

- **deliveryMode:** local
- **evidenceTier:** high-risk
- **tier rationale:** security, secret persistence, authorization, shared delivery identity, outbound HTTP, concurrent fanout, cross-service behavior
- **lifecycle state:** in_progress
- **current phase:** P9
- **baseline revision:** `d94577e5c5cfaacc3225c1d06bf0506184514420`
- **candidate revision:** `WORKTREE@c3e17e31ac6667057254d5ad5343a779f85dd5fa` (dirty overlay; evidence tests remain uncommitted)
- **declared scope digest:** `sha256:48ed5a1ebc20dee5ca68935180121492e89702eccfec427c19ede998b1115f47` (sorted newline-delimited paths)
- **current changed files digest:** `sha256:48ed5a1ebc20dee5ca68935180121492e89702eccfec427c19ede998b1115f47` (sorted newline-delimited paths)

## Execution status

Implementation is complete through P8, and focused P5–P7 boundary evidence is now present. The Web UI now adds destinations through a generic integration selector, renders integration-specific fields, preserves custom destination names during type changes, and confirms destructive removal with a short-lived success toast. The work remains in `in_progress/` because this is a high-risk plan and independent validation/revalidation are not complete.

The implementation corrected two findings from independent review: external webhook URLs no longer enter settings streams, and external webhook secrets are restored when a settings update fails. Disabled but configured destinations are eligible for an explicit test without entering normal fanout. Relay and external startup snapshots use separate readiness state so an external-first startup does not prevent later relay reconciliation.

The previously reported boundary evidence gaps are repaired with adapter transport/timeout/2xx tests, dispatcher concurrency tests, relay no-credential/settings-replay coverage, client failure propagation, and Web UI operation coverage. The user has also manually validated the running external-notification flow and final settings controls. Independent validation and revalidation must be rerun against the current dirty candidate.

## AC Trace Table

| AC    | Title                        | Primary Phase | Supporting Phases |
| ----- | ---------------------------- | ------------- | ----------------- |
| AC-01 | Contract defaults/validation | P1            | P2, P9            |
| AC-02 | Secret confidentiality       | P2            | P9                |
| AC-03 | Home Assistant HTTP          | P3            | P9                |
| AC-04 | Payload                      | P3            | P1, P9            |
| AC-05 | Deep link                    | P3            | P1, P9            |
| AC-06 | Fanout/isolation             | P4            | P5, P9            |
| AC-07 | Destination-aware dedupe     | P4            | P5, P9            |
| AC-08 | Awareness semantics          | P5            | P9                |
| AC-09 | Relay compatibility          | P5            | P9                |
| AC-10 | Test operation               | P6            | P4, P1, P9        |
| AC-11 | Client command               | P6            | P9                |
| AC-12 | Web Settings                 | P7            | P9                |
| AC-13 | Docs                         | P8            | P9                |

## Proposed Design

1. **Settings descriptor union and separate write-only replacement URL at boundary.**
2. **Deterministic secret key by destination ID, internal materialization/outbound redaction.**
3. **Static adapter compiler and Effect HttpClient HA adapter.**
4. **Dispatcher bounded fanout, per-destination/thread success identity excluding incidental timestamps, identity update only after success, direct test bypass.**
5. **Retain event stream/filter/projection/worker/confirmation in `AgentAwarenessRelay` but move canonical processing before sink gates.**
6. **Relay and dispatcher sibling sinks with separate identities.**
7. **Startup replay independent of relay and settings-change re-enqueue through same worker so new destination receives while existing suppress.**
8. **CRUD via normal settings; dedicated operate test RPC and environment command.**
9. **Environment-scoped Web UI.**

## Declared Source Scope

`apps/server/src/auth/RpcAuthorization.test.ts` `apps/server/src/auth/RpcAuthorization.ts` `apps/server/src/notifications/ExternalNotificationDispatcher.test.ts` `apps/server/src/notifications/ExternalNotificationDispatcher.ts` `apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts` `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts` `apps/server/src/relay/AgentAwarenessRelay.test.ts` `apps/server/src/relay/AgentAwarenessRelay.ts` `apps/server/src/server.test.ts` `apps/server/src/server.ts` `apps/server/src/serverSettings.test.ts` `apps/server/src/serverSettings.ts` `apps/server/src/ws.ts` `apps/web/src/components/settings/ExternalNotificationsSettings.logic.test.ts` `apps/web/src/components/settings/IntegrationsSettings.environment.test.tsx` `apps/web/src/components/settings/IntegrationsSettings.tsx` `docs/plans/README.md` `docs/plans/completed/README.md` `docs/plans/in_progress/README.md` `docs/plans/in_progress/external-notifications/LEDGER.md` `docs/plans/in_progress/external-notifications/PLAN.md` `docs/plans/in_progress/external-notifications/SPEC.md` `docs/plans/in_progress/external-notifications/STATE.md` `docs/plans/in_progress/external-notifications/TODO.md` `docs/plans/planned/README.md` `docs/user/external-notifications.md` `packages/client-runtime/src/state/server.test.ts` `packages/client-runtime/src/state/server.ts` `packages/contracts/src/externalNotifications.ts` `packages/contracts/src/index.ts` `packages/contracts/src/rpc.ts` `packages/contracts/src/settings.test.ts` `packages/contracts/src/settings.ts` `packages/shared/src/serverSettings.test.ts` `packages/shared/src/serverSettings.ts`

Generated artifacts: none expected. Route tree unchanged. Unexpected generated files require replan.

## Decisions / Assumptions / Blockers

### Decisions

- Home Assistant first but adapter-neutral.
- Static adapters (closed union).
- Canonical awareness flow.
- Sibling independent sinks.
- Atomic destination map/list.
- Per-destination/thread dedupe.
- Test bypass.
- `t3code-dev` default scheme.
- High-risk evidence tier.

### Assumptions

- Target is prior external feature despite empty arguments.
- At-most-once suppression per process sufficient.
- Web only for UI.
- Partial work is non-authoritative.

### Blockers

None.

## Dependency Graph

```
P0 → P1 → P2 ─┐
               ├→ P4 → P5
P0 → P1 → P3 ─┘      ↑
P0 → P1 → P4 ─→ P6   │
P0 → P1 → P5         │
P1+P4 → P6 → P7
P2+P6 → P7
P2+P6 → P8
P8 → P9
```

### Waves

| Wave | Phases | Constraint                     |
| ---- | ------ | ------------------------------ |
| 1    | P0     | Baseline                       |
| 2    | P1     | After P0                       |
| 3    | P2, P3 | After P1, parallel             |
| 4    | P4     | After P2+P3                    |
| 5    | P5     | After P4                       |
| 6    | P6     | After P1+P4, parallel with P5  |
| 7    | P7, P8 | P7 after P2+P6; P8 after P2+P6 |
| 8    | P9     | After all                      |

## Concurrency Story

- **Settings semaphore** guards all settings writes to prevent partial/mixed patches.
- **Same-thread worker ordering** preserved: awareness events for the same thread are processed in canonical order.
- **Bounded cross-destination fanout** with concurrency limit; each destination attempt is isolated.
- **Effect-managed / serialized identity update** for same destination/thread: identity advances only after success.
- **Errors isolated**: failure of one destination does not affect others or terminate awareness.
- **Settings replay via same worker**: new destination receives current state through re-enqueue.

## Phases

### P0 — Baseline / Fail-First

**Goal:** Capture baseline state, provenance, and scope digest. Record dirty state as non-authoritative.

**Actions:**

1. Record `baselineRevision` = `d94577e5c5cfaacc3225c1d06bf0506184514420`.
2. Capture `candidateRevision` = `WORKTREE@d94577e5c5cfaacc3225c1d06bf0506184514420` (dirty).
3. Verify `declaredScopeDigest` matches current changed files.
4. Record `currentChangedFilesDigest`.
5. Fail-first accounting: existing dirty edits in `apps/server/src/serverSettings.ts` and `packages/contracts/src/settings.ts` predate saved lifecycle; must be audited against declared scope before any validation claim.

**Evidence:** git status, git diff against baseline, scope digest match.

### P1 — Contracts

**Goal:** Define `externalNotifications` settings schema, test schema, deep link encoding, and operate test schema.

**ACs:** AC-01, contract portions of AC-04/05/AC-10.

**Actions:**

1. Add `externalNotifications` to settings schema in `packages/contracts/src/settings.ts`.
2. Add deep link encoding helpers.
3. Add operate test RPC schema to `packages/contracts/src/rpc.ts`.
4. Update barrel exports in `packages/contracts/src/index.ts`.
5. Write `packages/contracts/src/settings.test.ts` additions.

### P2 — Settings / Secrets

**Goal:** Implement server-side settings persistence and secret lifecycle.

**ACs:** AC-02, AC-01 persistence.

**Actions:**

1. Implement `externalNotifications` patch handling in `apps/server/src/serverSettings.ts`.
2. Implement deterministic secret key derivation.
3. Integrate `ServerSecretStore` for URL persistence (conditional if store exists).
4. Implement redaction, replacement, removal, and stale cleanup.
5. Write `apps/server/src/serverSettings.test.ts` additions.

### P3 — Home Assistant Adapter

**Goal:** Implement HA webhook adapter with HTTP POST, payload construction, and deep link generation.

**ACs:** AC-03, AC-04, AC-05.

**Actions:**

1. Create `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`.
2. Implement POST JSON with content-type, bounded timeout, 2xx success.
3. Implement payload construction: `schemaVersion`, `test: false`, `environmentId`, `threadId`, `state|null`, optional titles, phase/headline/detail, relative route, deep link.
4. Implement deep link: `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>`, independently encoded.
5. Sanitize errors for malformed/unavailable/timeout/transport/non-2xx.
6. Write `apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts`.

### P4 — Dispatcher

**Goal:** Implement dispatcher with bounded fanout, destination-aware deduplication, and test bypass.

**ACs:** AC-06, AC-07, AC-10 dispatch.

**Actions:**

1. Create `apps/server/src/notifications/ExternalNotificationDispatcher.ts`.
2. Implement bounded fanout: every enabled configured destination attempted, disabled/unconfigured skipped.
3. Implement per-destination/thread deduplication: unchanged/timestamp-only suppressed, identity advances only on success.
4. New/configured destination receives current state without existing resend.
5. Implement test bypass: direct test, no normal identity mutation/fanout.
6. Write `apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`.

### P5 — Awareness / Relay Integration

**Goal:** Integrate dispatcher with `AgentAwarenessRelay` as sibling sink; preserve all existing relay semantics.

**ACs:** AC-06, AC-07, AC-08, AC-09.

**Actions:**

1. Modify `apps/server/src/relay/AgentAwarenessRelay.ts` to move canonical processing before sink gates.
2. Add dispatcher as sibling sink with separate identity.
3. Preserve: filtering, thread ID extraction, projection, meaningful identity excluding timestamps, unchanged suppression, startup replay, transient tombstone and initial-completed confirmation, sanitization.
4. Ensure relay works absent/failing external; external works absent/disabled/failing relay.
5. Ensure signed payload and identity unchanged.
6. Startup replay independent of relay; settings-change re-enqueue through same worker.
7. Write/update `apps/server/src/relay/AgentAwarenessRelay.test.ts`.

### P6 — RPC / Client

**Goal:** Implement operate test RPC and environment command.

**ACs:** AC-10, AC-11.

**Actions:**

1. Add operate test RPC handler in `apps/server/src/ws.ts`.
2. Operate-authorized, exactly selected configured destination, synthetic `test: true`.
3. No normal identity mutation/fanout on test.
4. Read-only/unauth rejected. Sanitized errors.
5. Add environment command in `apps/server/src/server.ts`.
6. Update `packages/client-runtime/src/state/server.ts`.
7. Write `apps/server/src/server.test.ts` additions and `packages/client-runtime/src/state/server.test.ts` additions.

### P7 — Web Settings

**Goal:** Implement environment-scoped Integrations UI for external notifications.

**ACs:** AC-12.

**Actions:**

1. Integrate the environment-scoped section into `apps/web/src/components/settings/IntegrationsSettings.tsx` (no standalone component was introduced).
2. Implement: scheme/add/label/enable/disable/replace/test/remove/Configured.
3. Never display URL. Read-only when disabled.
4. Selected remote environment. Truthful save/test failure.
5. Browser settings unaffected.
6. Add dedicated logic and environment tests for the integrated section.

### P8 — Docs

**Goal:** Write user-facing documentation.

**ACs:** AC-13.

**Actions:**

1. Create `docs/user/external-notifications.md`.
2. Cover: HA setup, payload, URI example, schemes, secrets/redaction, HA not Cloud delivers push.
3. Note: free iOS Personal Team builds expire in 7 days and require reinstall.
4. Update `docs/internals/glossary.md` (conditional).

### P9 — Validation / Revalidation

**Goal:** Full evidence collection, format check, typecheck, independent validation, and independent revalidation.

**ACs:** AC-01 through AC-13.

**Actions:**

1. Run `vp fmt --check` followed by the actual changed paths.
2. Run the focused test suite for implemented test files; record missing boundary tests as evidence gaps rather than invoking nonexistent paths.
3. Run `tsgo --noEmit` from each affected package workdir.
4. Run relay regression.
5. Independent validator on same candidate.
6. Independent revalidator on same candidate (high-risk requirement).
7. Record all evidence in `LEDGER.md`.

## Evidence Strategy

### High-Risk Tier

**Fail-first:** Each behavior tested with failure case first.

**Positive control:** Valid input produces expected output.

**Negative control:** Invalid input produces expected rejection.

**BITE-DEMO contract union:** Union type exhaustiveness checked.

**Redaction / stale removal:** URL never leaves store; stale secrets cleaned.

**HTTP status / deep link:** Correct status mapping; link format exact.

**Dedupe key / identity before success:** Per-destination/thread key computed; identity only advances on success.

**Relay gate / confirmation:** Relay works independently; confirmation preserved.

**Auth scope / wrong environment:** Operate-authorized check; wrong environment rejected.

**UI secret / read-only:** URL never displayed; disabled shows read-only.

**Docs mutation N/A:** No runtime branch; compensated by required-topic content check.

**Race / integration:**

- Settings atomicity
- Controlled HttpClient
- Delayed/failing fanout
- Same-thread worker ordering
- Settings replay

**Dependent sweeps named:** Each sweep identified in ledger.

High-risk requires independent validator then independent revalidator on same candidate.

## Validation Commands

```bash
# Baseline / scope
git status --short --branch
git diff --name-only d94577e5c
git diff --stat d94577e5c

# Targeted format
vp fmt --check
# Then actual changed paths

# Focused tests
vp test run \
  packages/contracts/src/settings.test.ts \
  packages/shared/src/serverSettings.test.ts \
  apps/server/src/serverSettings.test.ts \
  apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts \
  apps/server/src/notifications/ExternalNotificationDispatcher.test.ts \
  apps/server/src/relay/AgentAwarenessRelay.test.ts \
  apps/server/src/auth/RpcAuthorization.test.ts

# Server focused RPC
vp test run apps/server/src/server.test.ts -t "external notification"

# Typecheck (run from each package workdir)
vp run typecheck

# Relay regression
vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts

# Final
git status --short
git diff --name-only d94577e5c
git diff --check
```

No browser.

## Rollback / Containment

- Empty default (`t3code-dev` + `[]`) is inert.
- Disable/remove contains the feature.
- Relay is separate; no coupling.
- No database migration.
- Secrets are destination-scoped.
- Do not claim completion while dedicated RPC, client-runtime, Web UI boundary, or late-relay integration evidence is missing.

## Risks

| Risk                              | Mitigation                                    |
| --------------------------------- | --------------------------------------------- |
| URL leaks                         | ServerSecretStore only; redaction at boundary |
| Non-atomic settings/secret        | Settings semaphore                            |
| Relay gate coupling               | Sibling independent sinks                     |
| Global dedupe                     | Per-destination/thread key                    |
| Identity before success           | Identity advances only after success          |
| Replay bypass ordering            | Same-worker re-enqueue                        |
| Concurrent duplicate              | Effect-managed serialization                  |
| Remote auth                       | Operate-authorized check                      |
| Brittle mocks                     | Controlled HttpClient in tests                |
| Partial edits may be restructured | No completion claim without full evidence     |
