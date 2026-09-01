# External Notifications — LEDGER

## Shared Provenance (current candidate)

| Field                        | Value                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| baseline_revision            | `d94577e5c5cfaacc3225c1d06bf0506184514420`                                                        |
| candidate_revision           | `WORKTREE@d94577e5c5cfaacc3225c1d06bf0506184514420` (dirty)                                       |
| declared_scope_digest        | `sha256:2dec9ec164d739a2b421c74d67f57b4a2339ebb37082eb39faf9ef18c43ffa8f`                         |
| current_changed_files_digest | `sha256:2dec9ec164d739a2b421c74d67f57b4a2339ebb37082eb39faf9ef18c43ffa8f`                         |
| current_changed_files        | See `STATE.md` provenance; 30 paths including lifecycle READMEs and the moved plan package        |
| implementer                  | direct primary implementation / `ses_fa4cea939ffeeirmIHsesYjjQP` / `openai/gpt-5.6-luna`          |
| validator                    | validate-wrapper / `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                        |
| revalidator                  | validate-wrapper-alt / `ses_fa4923707ffeA0gvUbAe5yfgB6` / `deepseek-v4-pro`                       |
| latest validation            | `unverifiable`; focused implementation checks pass, but required boundary evidence is missing     |
| latest revalidation          | `fail`; missing RPC, client-runtime, Web UI boundary, and late-relay integration evidence remains |
| timestamp_policy             | ISO-8601 with timezone, captured at execution time; never pre-fill execution timestamps           |

**Current candidate is in `docs/plans/in_progress/external-notifications/`. The historical pre-implementation block below is retained only as provenance of the original saved plan.**

---

## Historical Shared Provenance

| Field                        | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline_revision            | `d94577e5c5cfaacc3225c1d06bf0506184514420`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| candidate_revision           | `WORKTREE@d94577e5c5cfaacc3225c1d06bf0506184514420` (dirty)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| declared_scope_digest        | `sha256:43a78297a5178a30bdac4f25d5864063931d018579f10ab2e5174093c1011710`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| current_changed_files_digest | `sha256:43a78297a5178a30bdac4f25d5864063931d018579f10ab2e5174093c1011710`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| current_changed_files        | `apps/server/src/auth/RpcAuthorization.ts; apps/server/src/notifications/ExternalNotificationDispatcher.test.ts; apps/server/src/notifications/ExternalNotificationDispatcher.ts; apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts; apps/server/src/notifications/HomeAssistantWebhookAdapter.ts; apps/server/src/relay/AgentAwarenessRelay.test.ts; apps/server/src/relay/AgentAwarenessRelay.ts; apps/server/src/server.ts; apps/server/src/serverSettings.test.ts; apps/server/src/serverSettings.ts; apps/server/src/ws.ts; apps/web/src/components/settings/IntegrationsSettings.tsx; docs/plans/in_progress/external-notifications/LEDGER.md; docs/plans/in_progress/external-notifications/PLAN.md; docs/plans/in_progress/external-notifications/SPEC.md; docs/plans/in_progress/external-notifications/STATE.md; docs/plans/in_progress/external-notifications/TODO.md; docs/user/external-notifications.md; packages/client-runtime/src/state/server.ts; packages/contracts/src/externalNotifications.ts; packages/contracts/src/index.ts; packages/contracts/src/rpc.ts; packages/contracts/src/settings.test.ts; packages/contracts/src/settings.ts; packages/shared/src/serverSettings.test.ts; packages/shared/src/serverSettings.ts` |
| implementer_task             | direct primary implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| implementer_session          | ses_fa4cea939ffeeirmIHsesYjjQP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| implementer_model            | openai/gpt-5.6-luna                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| validator_task               | validate-wrapper                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| validator_session            | ses_fa4a1c53fffe0A6R6N4gbMp5h7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| validator_model              | openai/gpt-5.6-sol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| revalidator_task             | validate-wrapper-alt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| revalidator_session          | ses_fa4923707ffeA0gvUbAe5yfgB6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| revalidator_model            | deepseek-v4-pro                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| timestamp_policy             | ISO-8601 with timezone, captured at execution time; never pre-fill execution timestamps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Gate status:** Focused implementation evidence passes for contracts, settings/secrets, the Home Assistant adapter, dispatcher, formatting, and package typechecks. Independent review found and the implementation corrected URL-stream leakage, secret rollback, disabled configured test handling, and separate relay/external snapshot readiness. Final high-risk validation is `UNVERIFIABLE`/`FAIL` because dedicated RPC, client-runtime, Web UI boundary, and late-relay integration evidence is still missing. High-risk final PASS requires fresh independent revalidation after those gaps are closed.

**Rows cannot become VALIDATED/PASS until executable evidence and provenance exist.** High-risk final PASS requires independent revalidation.

---

## P0 — Baseline / Fail-First

<a id="p0-baseline"></a>

### Baseline and scope provenance

| Field                   | Value                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P0                                                                                                                                      |
| criterion               | PROV/SCOPE                                                                                                                              |
| fail-first              | pre-existing dirty edits were treated as non-authoritative until audited against declared scope                                         |
| positive control        | baseline and dirty candidate revisions recorded; current changed paths declared                                                         |
| negative control        | no unexpected generated files or undeclared implementation paths                                                                        |
| mutation / BITE-DEMO    | N/A — provenance and scope accounting; no runtime behavior is mutated                                                                   |
| race / integration      | N/A                                                                                                                                     |
| dependent-path sweep    | implementation, tests, user documentation, and moved lifecycle artifacts included in the 30-path scope                                  |
| command                 | `git status --short --branch; git diff --name-only d94577e5c; git diff --check`                                                         |
| result                  | VALIDATED — baseline `d94577e5c`, dirty candidate, and 30-path declared scope recorded; final audit passed at 2026-09-01T10:44:28-05:00 |
| artifact / reference    | `PLAN.md` metadata; `STATE.md` provenance                                                                                               |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                 |
| timestamp               | 2026-09-01T10:44:28-05:00                                                                                                               |

---

## P1 — Contracts

<a id="p1-ac-01"></a>

### Contract defaults/validation

| Field                   | Value                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                                   |
| criterion               | AC-01                                                                                                                |
| fail-first              | absent config => `t3code-dev` + `[]`                                                                                 |
| positive control        | valid scheme and HA variant accepted                                                                                 |
| negative control        | unknown kind, blank ID/label, invalid scheme/variant rejected                                                        |
| mutation / BITE-DEMO    | external config/destination arrays atomically replaced; unrelated patch does not materialize `externalNotifications` |
| race / integration      | N/A at contract level                                                                                                |
| dependent-path sweep    | settings schema union exhaustive                                                                                     |
| command                 | `vp test run packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts`                     |
| result                  | VALIDATED — exit 0; 144 focused tests passed in the validation batch (2026-09-01T10:29:03-05:00)                     |
| artifact / reference    | `packages/contracts/src/settings.ts`                                                                                 |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                              |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                            |

<a id="p1-ac-04"></a>

### Payload schema

| Field                   | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                 |
| criterion               | AC-04                                                                                              |
| fail-first              | missing optional fields null/omitted                                                               |
| positive control        | full payload with all fields present                                                               |
| negative control        | N/A (schema only)                                                                                  |
| mutation / BITE-DEMO    | payload schema exhaustive                                                                          |
| race / integration      | N/A at contract level                                                                              |
| dependent-path sweep    | payload schema consistent with AC-04 definition                                                    |
| command                 | `vp test run packages/contracts/src/settings.test.ts`                                              |
| result                  | VALIDATED — exit 0; contract assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `packages/contracts/src/externalNotifications.ts`                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                            |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                          |

<a id="p1-ac-05"></a>

### Deep link encoding

| Field                   | Value                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                 |
| criterion               | AC-05                                                                                              |
| fail-first              | missing encoding edge case                                                                         |
| positive control        | independently encoded env/thread IDs                                                               |
| negative control        | N/A (schema only)                                                                                  |
| mutation / BITE-DEMO    | encoding helpers exact                                                                             |
| race / integration      | N/A at contract level                                                                              |
| dependent-path sweep    | encoding matches `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>`                     |
| command                 | `vp test run packages/contracts/src/settings.test.ts`                                              |
| result                  | VALIDATED — exit 0; encoding assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `packages/contracts/src/externalNotifications.ts`                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                            |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                          |

<a id="p1-ac-10"></a>

### Operate test schema

| Field                   | Value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                       |
| criterion               | AC-10                                                                                                    |
| fail-first              | missing required fields                                                                                  |
| positive control        | operate test schema with destination ID                                                                  |
| negative control        | N/A (schema only)                                                                                        |
| mutation / BITE-DEMO    | operate test schema exhaustive                                                                           |
| race / integration      | N/A at contract level                                                                                    |
| dependent-path sweep    | schema matches operate test definition                                                                   |
| command                 | `vp test run packages/contracts/src/settings.test.ts`                                                    |
| result                  | VALIDATED — exit 0; operate schema assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `packages/contracts/src/rpc.ts`                                                                          |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                  |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                |

---

## P2 — Settings / Secrets

<a id="p2-ac-01"></a>

### Settings persistence

| Field                   | Value                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| phase                   | P2                                                                                                      |
| criterion               | AC-01                                                                                                   |
| fail-first              | patch does not persist when absent                                                                      |
| positive control        | valid patch persisted atomically                                                                        |
| negative control        | unrelated patch does not materialize `externalNotifications`                                            |
| mutation / BITE-DEMO    | atomic replacement verified                                                                             |
| race / integration      | settings semaphore prevents concurrent corruption                                                       |
| dependent-path sweep    | settings patch flows through settings semaphore                                                         |
| command                 | `vp test run apps/server/src/serverSettings.test.ts`                                                    |
| result                  | VALIDATED — exit 0; 33 server-settings tests passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/serverSettings.ts`                                                                     |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                 |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                               |

<a id="p2-ac-02"></a>

### Secret confidentiality

| Field                   | Value                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P2                                                                                                                                 |
| criterion               | AC-02                                                                                                                              |
| fail-first              | URL written to settings.json                                                                                                       |
| positive control        | URL stored only in ServerSecretStore                                                                                               |
| negative control        | URL not in WS, streams, caches, logs/errors                                                                                        |
| mutation / BITE-DEMO    | redacted resubmission preserves; replacement replaces; clear/remove removes; stale cleanup                                         |
| race / integration      | secret store isolation verified                                                                                                    |
| dependent-path sweep    | secret lifecycle independent of settings read                                                                                      |
| command                 | `vp test run apps/server/src/serverSettings.test.ts`                                                                               |
| result                  | VALIDATED — exit 0; secret redaction, stream confidentiality, stale cleanup, and rollback tests passed (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/serverSettings.ts`; `apps/server/src/serverSettings.test.ts`                                                      |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                            |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                                          |

---

## P3 — Home Assistant Adapter

<a id="p3-ac-03"></a>

### Home Assistant HTTP

| Field                   | Value                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| phase                   | P3                                                                                                            |
| criterion               | AC-03                                                                                                         |
| fail-first              | no request when disabled/unconfigured                                                                         |
| positive control        | POST with content-type, 2xx success                                                                           |
| negative control        | malformed/unavailable/timeout/transport/non-2xx sanitized                                                     |
| mutation / BITE-DEMO    | bounded timeout enforced                                                                                      |
| race / integration      | controlled HttpClient                                                                                         |
| dependent-path sweep    | HTTP adapter independent of relay                                                                             |
| command                 | `vp test run apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts`                               |
| result                  | VALIDATED — exit 0; 3 Home Assistant adapter tests passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`                                                |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                       |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                     |

<a id="p3-ac-04"></a>

### Payload construction

| Field                   | Value                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| phase                   | P3                                                                                                |
| criterion               | AC-04                                                                                             |
| fail-first              | missing metadata null/omitted                                                                     |
| positive control        | full payload with all fields                                                                      |
| negative control        | unavailable metadata null/omitted without fabrication                                             |
| mutation / BITE-DEMO    | payload fields exact per spec                                                                     |
| race / integration      | N/A (single call)                                                                                 |
| dependent-path sweep    | payload schema from P1                                                                            |
| command                 | `vp test run apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts`                   |
| result                  | VALIDATED — exit 0; payload assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`                                    |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                           |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                         |

<a id="p3-ac-05"></a>

### Deep link

| Field                   | Value                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| phase                   | P3                                                                                                  |
| criterion               | AC-05                                                                                               |
| fail-first              | missing encoding                                                                                    |
| positive control        | `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>`                                       |
| negative control        | N/A                                                                                                 |
| mutation / BITE-DEMO    | encoding independent per component                                                                  |
| race / integration      | N/A                                                                                                 |
| dependent-path sweep    | encoding helpers from P1                                                                            |
| command                 | `vp test run apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts`                     |
| result                  | VALIDATED — exit 0; deep-link assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`                                      |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                             |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                           |

---

## P4 — Dispatcher

<a id="p4-ac-06"></a>

### Fanout/isolation

| Field                   | Value                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| phase                   | P4                                                                                                |
| criterion               | AC-06                                                                                             |
| fail-first              | disabled destination skipped                                                                      |
| positive control        | all enabled destinations attempted                                                                |
| negative control        | failure of one does not affect others                                                             |
| mutation / BITE-DEMO    | works without cloud/relay credentials                                                             |
| race / integration      | bounded concurrency; controlled HttpClient                                                        |
| dependent-path sweep    | dispatcher independent of relay                                                                   |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                |
| result                  | VALIDATED — exit 0; 4 dispatcher tests passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/notifications/ExternalNotificationDispatcher.ts`                                 |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                           |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                         |

<a id="p4-ac-07"></a>

### Destination-aware dedupe

| Field                   | Value                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P4                                                                                                                                      |
| criterion               | AC-07                                                                                                                                   |
| fail-first              | unchanged/timestamp-only NOT suppressed (should be)                                                                                     |
| positive control        | unchanged/timestamp-only suppressed per dest/thread                                                                                     |
| negative control        | new destination gets current state                                                                                                      |
| mutation / BITE-DEMO    | identity advances only on success                                                                                                       |
| race / integration      | per-dest/thread key; concurrent duplicate suppressed                                                                                    |
| dependent-path sweep    | dedupe key independent of relay identity                                                                                                |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                                                      |
| result                  | VALIDATED — exit 0; dedupe, success identity, and new-destination assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/notifications/ExternalNotificationDispatcher.ts`                                                                       |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                 |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                                               |

<a id="p4-ac-10"></a>

### Test dispatch bypass

| Field                   | Value                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P4                                                                                                                                  |
| criterion               | AC-10                                                                                                                               |
| fail-first              | test triggers normal fanout (should not)                                                                                            |
| positive control        | test sent to exactly selected destination                                                                                           |
| negative control        | no identity mutation on test                                                                                                        |
| mutation / BITE-DEMO    | test bypass isolated                                                                                                                |
| race / integration      | N/A                                                                                                                                 |
| dependent-path sweep    | test bypass independent of dedupe                                                                                                   |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                                                  |
| result                  | VALIDATED — exit 0; direct test bypass and identity isolation assertions passed in the validation batch (2026-09-01T10:29:03-05:00) |
| artifact / reference    | `apps/server/src/notifications/ExternalNotificationDispatcher.ts`                                                                   |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                             |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                                           |

---

## P5 — Awareness / Relay Integration

<a id="p5-ac-06"></a>

### Fanout without relay dependency

| Field                   | Value                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                        |
| criterion               | AC-06                                                                                                     |
| fail-first              | external requires relay (should not)                                                                      |
| positive control        | external works absent/disabled relay                                                                      |
| negative control        | relay works absent/disabled external                                                                      |
| mutation / BITE-DEMO    | sibling independent sinks verified                                                                        |
| race / integration      | settings replay via same worker                                                                           |
| dependent-path sweep    | dispatcher and relay independent gates                                                                    |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                           |
| result                  | STALE — relay regression passed, but external/relay independence and late-replay controls are not covered |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                            |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                   |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                 |

<a id="p5-ac-07"></a>

### Dedupe in relay integration

| Field                   | Value                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                          |
| criterion               | AC-07                                                                                       |
| fail-first              | existing destinations resent on new add (should not)                                        |
| positive control        | new destination gets current state                                                          |
| negative control        | existing destinations not resent                                                            |
| mutation / BITE-DEMO    | separate identity per sink                                                                  |
| race / integration      | same-worker ordering preserved                                                              |
| dependent-path sweep    | identity per sink from dispatcher                                                           |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                             |
| result                  | STALE — dispatcher dedupe passed, but relay settings-replay integration evidence is missing |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                     |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                   |

<a id="p5-ac-08"></a>

### Awareness semantics

| Field                   | Value                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                              |
| criterion               | AC-08                                                                                                           |
| fail-first              | filtering/projection/startup replay broken                                                                      |
| positive control        | all existing awareness behaviors preserved                                                                      |
| negative control        | unchanged suppression, transient confirmation                                                                   |
| mutation / BITE-DEMO    | canonical processing before sink gates                                                                          |
| race / integration      | startup replay independent of relay                                                                             |
| dependent-path sweep    | relay event stream unchanged                                                                                    |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                 |
| result                  | STALE — existing relay tests passed, but the required external startup/replay path is not independently covered |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                         |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                       |

<a id="p5-ac-09"></a>

### Relay compatibility

| Field                   | Value                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                               |
| criterion               | AC-09                                                                                                            |
| fail-first              | relay tests fail after integration                                                                               |
| positive control        | relay tests pass unchanged                                                                                       |
| negative control        | signed payload and identity unchanged                                                                            |
| mutation / BITE-DEMO    | relay existing behavior preserved                                                                                |
| race / integration      | relay independent of external                                                                                    |
| dependent-path sweep    | relay signing unchanged                                                                                          |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                  |
| result                  | STALE — relay regression passed, but external failure isolation and signed-payload boundary coverage are missing |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                                   |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                          |
| timestamp               | 2026-09-01T10:29:03-05:00                                                                                        |

---

## P6 — RPC / Client

<a id="p6-ac-10"></a>

### Operate test RPC

| Field                   | Value                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P6                                                                                                                           |
| criterion               | AC-10                                                                                                                        |
| fail-first              | unauth read-only test rejected                                                                                               |
| positive control        | operate-authorized test to exact destination                                                                                 |
| negative control        | wrong environment rejected; sanitized errors                                                                                 |
| mutation / BITE-DEMO    | test bypass verified at RPC boundary                                                                                         |
| race / integration      | RPC boundary isolation                                                                                                       |
| dependent-path sweep    | RPC handler from P1 schema                                                                                                   |
| command                 | `vp test run apps/server/src/server.test.ts -t "external notification"`                                                      |
| result                  | STALE — exit 0; 139 tests skipped because no matching external-notification boundary test exists (2026-09-01T10:34:46-05:00) |
| artifact / reference    | `apps/server/src/ws.ts`; `apps/server/src/auth/RpcAuthorization.ts`                                                          |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                      |
| timestamp               | 2026-09-01T10:34:46-05:00                                                                                                    |

<a id="p6-ac-11"></a>

### Client command

| Field                   | Value                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| phase                   | P6                                                                                                                                         |
| criterion               | AC-11                                                                                                                                      |
| fail-first              | command targets wrong environment                                                                                                          |
| positive control        | environment-scoped, correct target                                                                                                         |
| negative control        | auth failure exposed                                                                                                                       |
| mutation / BITE-DEMO    | client state updated                                                                                                                       |
| race / integration      | environment scope verified                                                                                                                 |
| dependent-path sweep    | client runtime from P1 schema                                                                                                              |
| command                 | `vp test run packages/client-runtime/src/state/server.test.ts`                                                                             |
| result                  | STALE — exit 0; 15 existing client-runtime tests passed, but no external-notification command assertions exist (2026-09-01T10:34:58-05:00) |
| artifact / reference    | `packages/client-runtime/src/state/server.ts`                                                                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                    |
| timestamp               | 2026-09-01T10:34:58-05:00                                                                                                                  |

---

## P7 — Web Settings

<a id="p7-ac-12"></a>

### Web Settings UI

| Field                   | Value                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P7                                                                                                                                        |
| criterion               | AC-12                                                                                                                                     |
| fail-first              | URL displayed (should not)                                                                                                                |
| positive control        | scheme/add/label/enable/disable/replace/test/remove/Configured                                                                            |
| negative control        | read-only when disabled; URL never shown                                                                                                  |
| mutation / BITE-DEMO    | browser settings unaffected                                                                                                               |
| race / integration      | selected remote environment verified                                                                                                      |
| dependent-path sweep    | UI from RPC/contract definitions                                                                                                          |
| command                 | `vp run typecheck` from `apps/web`                                                                                                        |
| result                  | STALE — exit 0; the UI compiles, but the planned dedicated environment and secret-boundary tests do not exist (2026-09-01T10:29:41-05:00) |
| artifact / reference    | `apps/web/src/components/settings/IntegrationsSettings.tsx`                                                                               |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                   |
| timestamp               | 2026-09-01T10:29:41-05:00                                                                                                                 |

---

## P8 — Docs

<a id="p8-ac-13"></a>

### Documentation

Current content check rerun at `2026-09-01T10:42:22-05:00`: exit 0 with all 7 required topics present. This supersedes the earlier timestamp retained in the table below.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P8                                                                                                                                                                                                                                                                                                                                                                                 |
| criterion               | AC-13                                                                                                                                                                                                                                                                                                                                                                              |
| fail-first              | missing required topic                                                                                                                                                                                                                                                                                                                                                             |
| positive control        | HA setup, payload, URI example, schemes, secrets/redaction covered                                                                                                                                                                                                                                                                                                                 |
| negative control        | HA not Cloud delivers push noted                                                                                                                                                                                                                                                                                                                                                   |
| mutation / BITE-DEMO    | mutation N/A (no runtime branch); compensated by required-topic content check                                                                                                                                                                                                                                                                                                      |
| race / integration      | N/A (docs only)                                                                                                                                                                                                                                                                                                                                                                    |
| dependent-path sweep    | docs content matches implementation                                                                                                                                                                                                                                                                                                                                                |
| command                 | `node -e 'const fs=require("node:fs"); const text=fs.readFileSync("docs/user/external-notifications.md","utf8"); const required=["Home Assistant","schemaVersion","t3code-dev","t3code-preview","redact","Cloud","7 days"]; for (const term of required) if (!text.includes(term)) throw new Error(`missing ${term}`); console.log(`${required.length} required topics present`)'` |
| result                  | VALIDATED — exit 0; 7 required topics present (2026-09-01T10:37:12-05:00)                                                                                                                                                                                                                                                                                                          |
| artifact / reference    | `docs/user/external-notifications.md`                                                                                                                                                                                                                                                                                                                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                                                                                                                                                                                                            |
| timestamp               | 2026-09-01T10:37:12-05:00                                                                                                                                                                                                                                                                                                                                                          |
| note                    | free iOS Personal Team builds expire in 7 days and require reinstall — present and checked                                                                                                                                                                                                                                                                                         |

---

## P9 — Validation / Revalidation

<a id="p9-fmt"></a>

### Format check

Final format check rerun at `2026-09-01T10:46:04-05:00`: exit 0; all matched files use the correct format. This supersedes the earlier timestamp retained in the table below.

| Field                   | Value                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                       |
| criterion               | FMT                                                                                      |
| fail-first              | formatting violations                                                                    |
| positive control        | all files pass                                                                           |
| negative control        | N/A                                                                                      |
| mutation / BITE-DEMO    | N/A                                                                                      |
| race / integration      | N/A                                                                                      |
| dependent-path sweep    | all changed files                                                                        |
| command                 | `vp fmt --check`                                                                         |
| result                  | VALIDATED — exit 0; all changed files use the correct format (2026-09-01T10:30:16-05:00) |
| artifact / reference    | format output                                                                            |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                  |
| timestamp               | 2026-09-01T10:30:16-05:00                                                                |

<a id="p9-test"></a>

### Focused tests

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| phase                   | P9                                                                                                                                                                                                                                                                                                                                                                             |
| criterion               | TEST                                                                                                                                                                                                                                                                                                                                                                           |
| fail-first              | test failure                                                                                                                                                                                                                                                                                                                                                                   |
| positive control        | all tests pass                                                                                                                                                                                                                                                                                                                                                                 |
| negative control        | N/A                                                                                                                                                                                                                                                                                                                                                                            |
| mutation / BITE-DEMO    | N/A                                                                                                                                                                                                                                                                                                                                                                            |
| race / integration      | N/A                                                                                                                                                                                                                                                                                                                                                                            |
| dependent-path sweep    | all test files                                                                                                                                                                                                                                                                                                                                                                 |
| command                 | `vp test run packages/contracts/src/settings.test.ts packages/shared/src/serverSettings.test.ts apps/server/src/serverSettings.test.ts apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts apps/server/src/notifications/ExternalNotificationDispatcher.test.ts apps/server/src/relay/AgentAwarenessRelay.test.ts apps/server/src/auth/RpcAuthorization.test.ts` |
| result                  | VALIDATED — exit 0; 7 test files and 144 tests passed (2026-09-01T10:43:56-05:00)                                                                                                                                                                                                                                                                                              |
| artifact / reference    | test output                                                                                                                                                                                                                                                                                                                                                                    |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                                                                                                                                                                                                        |
| timestamp               | 2026-09-01T10:43:56-05:00                                                                                                                                                                                                                                                                                                                                                      |

<a id="p9-type"></a>

### Typecheck

| Field                   | Value                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                |
| criterion               | TYPE                                                                                                                              |
| fail-first              | type error                                                                                                                        |
| positive control        | all packages pass typecheck                                                                                                       |
| negative control        | N/A                                                                                                                               |
| mutation / BITE-DEMO    | N/A                                                                                                                               |
| race / integration      | N/A                                                                                                                               |
| dependent-path sweep    | packages/contracts, apps/server, packages/client-runtime, apps/web                                                                |
| command                 | `vp run typecheck` from each of `packages/contracts`, `packages/shared`, `packages/client-runtime`, `apps/server`, and `apps/web` |
| result                  | VALIDATED — exit 0 in all five package worktrees; only pre-existing Effect suggestions were reported (2026-09-01T10:29:41-05:00)  |
| artifact / reference    | typecheck output                                                                                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                           |
| timestamp               | 2026-09-01T10:29:41-05:00                                                                                                         |

<a id="p9-relay"></a>

### Relay regression

| Field                   | Value                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                            |
| criterion               | RELAY                                                                                                         |
| fail-first              | relay test failure                                                                                            |
| positive control        | relay tests pass                                                                                              |
| negative control        | N/A                                                                                                           |
| mutation / BITE-DEMO    | N/A                                                                                                           |
| race / integration      | N/A                                                                                                           |
| dependent-path sweep    | AgentAwarenessRelay                                                                                           |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                               |
| result                  | VALIDATED — exit 0; relay regression passed in the final focused validation batch (2026-09-01T10:43:56-05:00) |
| artifact / reference    | relay test output                                                                                             |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                       |
| timestamp               | 2026-09-01T10:43:56-05:00                                                                                     |

<a id="p9-scope"></a>

### Scope verification

Final scope audit rerun at `2026-09-01T10:46:04-05:00`: 30 changed paths matched the declared scope digest and `git diff --check` passed.

| Field                   | Value                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                     |
| criterion               | SCOPE                                                                                                                                  |
| fail-first              | diff against baseline exceeds declared scope                                                                                           |
| positive control        | changed files within declared scope                                                                                                    |
| negative control        | no unexpected generated files                                                                                                          |
| mutation / BITE-DEMO    | N/A                                                                                                                                    |
| race / integration      | N/A                                                                                                                                    |
| dependent-path sweep    | declared scope digest matches                                                                                                          |
| command                 | `git status --short; git diff --name-only d94577e5c; git diff --check`                                                                 |
| result                  | VALIDATED — exit 0; current changed files match the declared 30-path scope and `git diff --check` is clean (2026-09-01T10:42:22-05:00) |
| artifact / reference    | git output                                                                                                                             |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                |
| timestamp               | 2026-09-01T10:42:22-05:00                                                                                                              |

<a id="p9-val"></a>

### Independent validation

| Field                   | Value                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| phase                   | P9                                                                                                                                                                                   |
| criterion               | VAL                                                                                                                                                                                  |
| fail-first              | validator finds defect                                                                                                                                                               |
| positive control        | validator confirms all evidence                                                                                                                                                      |
| negative control        | validator negative tests pass                                                                                                                                                        |
| mutation / BITE-DEMO    | all BITE-DEMO evidence verified                                                                                                                                                      |
| race / integration      | all race/integration evidence verified                                                                                                                                               |
| dependent-path sweep    | all dependent paths verified                                                                                                                                                         |
| command                 | independent validator run                                                                                                                                                            |
| result                  | FAIL — independent validator identified missing RPC/client/UI boundary evidence and relay integration coverage; implementation fixes were applied, but this row requires a fresh run |
| artifact / reference    | validator report                                                                                                                                                                     |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                              |
| timestamp               | 2026-09-01T00:45:33-05:00 (report recorded in session summary)                                                                                                                       |

<a id="p9-reval"></a>

### Independent revalidation (high-risk required)

| Field                   | Value                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                      |
| criterion               | REVAL                                                                                                                                   |
| fail-first              | revalidator finds defect                                                                                                                |
| positive control        | revalidator confirms all evidence                                                                                                       |
| negative control        | revalidator negative tests pass                                                                                                         |
| mutation / BITE-DEMO    | all evidence re-verified                                                                                                                |
| race / integration      | all evidence re-verified                                                                                                                |
| dependent-path sweep    | all paths re-verified                                                                                                                   |
| command                 | independent revalidator run                                                                                                             |
| result                  | FAIL — independent revalidator confirmed the implementation fixes but left the same required boundary and late-relay evidence gaps open |
| artifact / reference    | revalidator report                                                                                                                      |
| validator session/model | `ses_fa4923707ffeA0gvUbAe5yfgB6` / `deepseek-v4-pro`                                                                                    |
| timestamp               | 2026-09-01T00:45:33-05:00 (report recorded in session summary)                                                                          |
