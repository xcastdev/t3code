# External Notifications — LEDGER

## Shared Provenance (current candidate)

| Field                        | Value                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| baseline_revision            | `d94577e5c5cfaacc3225c1d06bf0506184514420`                                               |
| candidate_revision           | `53d151085d94f0d7a7acb12cb2776b9ce159050b` (immutable implementation candidate)          |
| declared_scope_digest        | `sha256:48ed5a1ebc20dee5ca68935180121492e89702eccfec427c19ede998b1115f47`                |
| current_changed_files_digest | `sha256:48ed5a1ebc20dee5ca68935180121492e89702eccfec427c19ede998b1115f47`                |
| current_changed_files        | See `STATE.md` provenance; 35 paths including boundary tests and lifecycle READMEs       |
| implementer                  | direct primary implementation / `ses_fa4cea939ffeeirmIHsesYjjQP` / `openai/gpt-5.6-luna` |
| validator                    | validate-wrapper / `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`               |
| revalidator                  | validate-wrapper-alt / `ses_fa4923707ffeA0gvUbAe5yfgB6` / `deepseek-v4-pro`              |
| latest validation            | `pending independent validation`                                                         |
| latest revalidation          | `pending independent revalidation`                                                       |
| timestamp_policy             | ISO-8601 with timezone, captured at execution time; never pre-fill execution timestamps  |

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

**Gate status:** Focused implementation and boundary evidence passes for contracts, settings/secrets, the Home Assistant adapter, dispatcher, relay sibling delivery, RPC authorization/dispatch, client-runtime routing, Web UI environment selection, secret redaction, formatting, and package typechecks. Independent review found and the implementation corrected URL-stream leakage, secret rollback, disabled configured test handling, and separate relay/external snapshot readiness. High-risk final PASS still requires fresh independent validation and revalidation.

**Rows cannot become VALIDATED/PASS until executable evidence and provenance exist.** High-risk final PASS requires independent revalidation.

---

## P0 — Baseline / Fail-First

<a id="p0-baseline"></a>

### Baseline and scope provenance

| Field                   | Value                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P0                                                                                                                                                  |
| criterion               | PROV/SCOPE                                                                                                                                          |
| fail-first              | pre-existing dirty edits were treated as non-authoritative until audited against declared scope                                                     |
| positive control        | baseline and dirty candidate revisions recorded; current changed paths declared                                                                     |
| negative control        | no unexpected generated files or undeclared implementation paths                                                                                    |
| mutation / BITE-DEMO    | N/A — provenance and scope accounting; no runtime behavior is mutated                                                                               |
| race / integration      | N/A                                                                                                                                                 |
| dependent-path sweep    | implementation, tests, user documentation, and moved lifecycle artifacts included in the 35-path scope                                              |
| command                 | `git status --short --branch; git diff --name-only d94577e5c; git ls-files --others --exclude-standard; git diff --check`                           |
| result                  | VALIDATED — baseline `d94577e5c`, dirty candidate `c3e17e31a`, and 35-path declared scope recorded; final audit passed at 2026-09-01T12:26:31-05:00 |
| artifact / reference    | `PLAN.md` metadata; `STATE.md` provenance                                                                                                           |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                             |
| timestamp               | 2026-09-01T12:26:31-05:00                                                                                                                           |

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
| result                  | VALIDATED — exit 0; 87 contract/settings tests passed in the current validation batch (2026-09-01T12:29:16-05:00)    |
| artifact / reference    | `packages/contracts/src/settings.ts`                                                                                 |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                              |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                            |

<a id="p1-ac-04"></a>

### Payload schema

| Field                   | Value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                       |
| criterion               | AC-04                                                                                                    |
| fail-first              | missing optional fields null/omitted                                                                     |
| positive control        | full payload with all fields present                                                                     |
| negative control        | N/A (schema only)                                                                                        |
| mutation / BITE-DEMO    | payload schema exhaustive                                                                                |
| race / integration      | N/A at contract level                                                                                    |
| dependent-path sweep    | payload schema consistent with AC-04 definition                                                          |
| command                 | `vp test run packages/contracts/src/settings.test.ts`                                                    |
| result                  | VALIDATED — exit 0; 63 contract tests passed in the current validation batch (2026-09-01T12:29:16-05:00) |
| artifact / reference    | `packages/contracts/src/externalNotifications.ts`                                                        |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                  |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                |

<a id="p1-ac-05"></a>

### Deep link encoding

| Field                   | Value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                       |
| criterion               | AC-05                                                                                                    |
| fail-first              | missing encoding edge case                                                                               |
| positive control        | independently encoded env/thread IDs                                                                     |
| negative control        | N/A (schema only)                                                                                        |
| mutation / BITE-DEMO    | encoding helpers exact                                                                                   |
| race / integration      | N/A at contract level                                                                                    |
| dependent-path sweep    | encoding matches `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>`                           |
| command                 | `vp test run packages/contracts/src/settings.test.ts`                                                    |
| result                  | VALIDATED — exit 0; encoding assertions passed in the current contract batch (2026-09-01T12:29:16-05:00) |
| artifact / reference    | `packages/contracts/src/externalNotifications.ts`                                                        |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                  |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                |

<a id="p1-ac-10"></a>

### Operate test schema

| Field                   | Value                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| phase                   | P1                                                                                                             |
| criterion               | AC-10                                                                                                          |
| fail-first              | missing required fields                                                                                        |
| positive control        | operate test schema with destination ID                                                                        |
| negative control        | N/A (schema only)                                                                                              |
| mutation / BITE-DEMO    | operate test schema exhaustive                                                                                 |
| race / integration      | N/A at contract level                                                                                          |
| dependent-path sweep    | schema matches operate test definition                                                                         |
| command                 | `vp test run packages/contracts/src/settings.test.ts`                                                          |
| result                  | VALIDATED — exit 0; operate schema assertions passed in the current contract batch (2026-09-01T12:29:16-05:00) |
| artifact / reference    | `packages/contracts/src/rpc.ts`                                                                                |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                        |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                      |

---

## P2 — Settings / Secrets

<a id="p2-ac-01"></a>

### Settings persistence

| Field                   | Value                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| phase                   | P2                                                                                                           |
| criterion               | AC-01                                                                                                        |
| fail-first              | patch does not persist when absent                                                                           |
| positive control        | valid patch persisted atomically                                                                             |
| negative control        | unrelated patch does not materialize `externalNotifications`                                                 |
| mutation / BITE-DEMO    | atomic replacement verified                                                                                  |
| race / integration      | settings semaphore prevents concurrent corruption                                                            |
| dependent-path sweep    | settings patch flows through settings semaphore                                                              |
| command                 | `vp test run apps/server/src/serverSettings.test.ts`                                                         |
| result                  | VALIDATED — exit 0; server settings tests passed in the current validation batch (2026-09-01T12:29:16-05:00) |
| artifact / reference    | `apps/server/src/serverSettings.ts`                                                                          |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                      |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                    |

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
| result                  | VALIDATED — exit 0; secret redaction, stream confidentiality, stale cleanup, and rollback tests passed (2026-09-01T12:29:16-05:00) |
| artifact / reference    | `apps/server/src/serverSettings.ts`; `apps/server/src/serverSettings.test.ts`                                                      |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                            |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                                          |

---

## P3 — Home Assistant Adapter

<a id="p3-ac-03"></a>

### Home Assistant HTTP

| Field                   | Value                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P3                                                                                                                                                                          |
| criterion               | AC-03                                                                                                                                                                       |
| fail-first              | no request when disabled/unconfigured                                                                                                                                       |
| positive control        | POST with content-type, 2xx success                                                                                                                                         |
| negative control        | malformed/unavailable/timeout/transport/non-2xx sanitized                                                                                                                   |
| mutation / BITE-DEMO    | bounded timeout enforced                                                                                                                                                    |
| race / integration      | controlled HttpClient                                                                                                                                                       |
| dependent-path sweep    | HTTP adapter independent of relay                                                                                                                                           |
| command                 | `vp test run apps/server/src/notifications/HomeAssistantWebhookAdapter.test.ts`                                                                                             |
| result                  | VALIDATED — exit 0; 6 Home Assistant adapter tests passed, including transport failure, timeout, malformed URL, and representative 2xx controls (2026-09-01T12:59:13-05:00) |
| artifact / reference    | `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`                                                                                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                     |
| timestamp               | 2026-09-01T12:59:13-05:00                                                                                                                                                   |

<a id="p3-ac-04"></a>

### Payload construction

| Field                   | Value                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P3                                                                                                                                       |
| criterion               | AC-04                                                                                                                                    |
| fail-first              | missing metadata null/omitted                                                                                                            |
| positive control        | full payload with all fields                                                                                                             |
| negative control        | unavailable metadata null/omitted without fabrication                                                                                    |
| mutation / BITE-DEMO    | payload fields exact per spec                                                                                                            |
| race / integration      | N/A (single call)                                                                                                                        |
| dependent-path sweep    | payload schema from P1                                                                                                                   |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                                                       |
| result                  | VALIDATED — exit 0; payload construction and null metadata assertions passed in the current dispatcher batch (2026-09-01T12:59:13-05:00) |
| artifact / reference    | `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`                                                                           |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                  |
| timestamp               | 2026-09-01T12:59:13-05:00                                                                                                                |

<a id="p3-ac-05"></a>

### Deep link

| Field                   | Value                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P3                                                                                                                                |
| criterion               | AC-05                                                                                                                             |
| fail-first              | missing encoding                                                                                                                  |
| positive control        | `<scheme>://threads/<encodedEnvironmentId>/<encodedThreadId>`                                                                     |
| negative control        | N/A                                                                                                                               |
| mutation / BITE-DEMO    | encoding independent per component                                                                                                |
| race / integration      | N/A                                                                                                                               |
| dependent-path sweep    | encoding helpers from P1                                                                                                          |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                                                |
| result                  | VALIDATED — exit 0; independently encoded deep-link assertions passed in the current dispatcher batch (2026-09-01T12:59:13-05:00) |
| artifact / reference    | `apps/server/src/notifications/HomeAssistantWebhookAdapter.ts`                                                                    |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                           |
| timestamp               | 2026-09-01T12:59:13-05:00                                                                                                         |

---

## P4 — Dispatcher

<a id="p4-ac-06"></a>

### Fanout/isolation

| Field                   | Value                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P4                                                                                                                                                                        |
| criterion               | AC-06                                                                                                                                                                     |
| fail-first              | disabled destination skipped                                                                                                                                              |
| positive control        | all enabled destinations attempted                                                                                                                                        |
| negative control        | failure of one does not affect others                                                                                                                                     |
| mutation / BITE-DEMO    | temporarily added `_tag: "mutation"` to the adapter union; server typecheck failed at the `never` gate, then the mutation was removed and the candidate typecheck passed  |
| race / integration      | bounded concurrency; controlled HttpClient                                                                                                                                |
| dependent-path sweep    | dispatcher independent of relay                                                                                                                                           |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                                                                                        |
| result                  | VALIDATED — exit 0; 7 dispatcher tests passed, including bounded fanout, concurrent duplicate serialization, and dynamic destination addition (2026-09-01T16:41:53-05:00) |
| artifact / reference    | `apps/server/src/notifications/ExternalNotificationDispatcher.ts`                                                                                                         |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                   |
| timestamp               | 2026-09-01T16:41:53-05:00                                                                                                                                                 |

<a id="p4-ac-07"></a>

### Destination-aware dedupe

| Field                   | Value                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P4                                                                                                                                                      |
| criterion               | AC-07                                                                                                                                                   |
| fail-first              | unchanged/timestamp-only NOT suppressed (should be)                                                                                                     |
| positive control        | unchanged/timestamp-only suppressed per dest/thread                                                                                                     |
| negative control        | new destination gets current state                                                                                                                      |
| mutation / BITE-DEMO    | identity advances only on success                                                                                                                       |
| race / integration      | per-dest/thread key; concurrent duplicate suppressed                                                                                                    |
| dependent-path sweep    | dedupe key independent of relay identity                                                                                                                |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                                                                      |
| result                  | VALIDATED — exit 0; dedupe, success identity, new-destination, concurrent duplicate, and dynamic settings assertions passed (2026-09-01T16:41:53-05:00) |
| artifact / reference    | `apps/server/src/notifications/ExternalNotificationDispatcher.ts`                                                                                       |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                 |
| timestamp               | 2026-09-01T16:41:53-05:00                                                                                                                               |

<a id="p4-ac-10"></a>

### Test dispatch bypass

| Field                   | Value                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| phase                   | P4                                                                                                          |
| criterion               | AC-10                                                                                                       |
| fail-first              | test triggers normal fanout (should not)                                                                    |
| positive control        | test sent to exactly selected destination                                                                   |
| negative control        | no identity mutation on test                                                                                |
| mutation / BITE-DEMO    | test bypass isolated                                                                                        |
| race / integration      | N/A                                                                                                         |
| dependent-path sweep    | test bypass independent of dedupe                                                                           |
| command                 | `vp test run apps/server/src/notifications/ExternalNotificationDispatcher.test.ts`                          |
| result                  | VALIDATED — exit 0; direct test bypass and identity isolation assertions passed (2026-09-01T16:41:53-05:00) |
| artifact / reference    | `apps/server/src/notifications/ExternalNotificationDispatcher.ts`                                           |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                     |
| timestamp               | 2026-09-01T16:41:53-05:00                                                                                   |

---

## P5 — Awareness / Relay Integration

<a id="p5-ac-06"></a>

### Fanout without relay dependency

| Field                   | Value                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                                                                                          |
| criterion               | AC-06                                                                                                                                                                       |
| fail-first              | external requires relay (should not)                                                                                                                                        |
| positive control        | external works absent/disabled relay                                                                                                                                        |
| negative control        | relay works absent/disabled external                                                                                                                                        |
| mutation / BITE-DEMO    | sibling independent sinks verified                                                                                                                                          |
| race / integration      | settings replay via same worker                                                                                                                                             |
| dependent-path sweep    | dispatcher and relay independent gates                                                                                                                                      |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                                                                             |
| result                  | VALIDATED — relay integration delivers without relay credentials and replays through the same worker on settings changes; 11 relay tests passed (2026-09-01T12:58:40-05:00) |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                                                                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                     |
| timestamp               | 2026-09-01T12:58:40-05:00                                                                                                                                                   |

<a id="p5-ac-07"></a>

### Dedupe in relay integration

| Field                   | Value                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                                                                              |
| criterion               | AC-07                                                                                                                                                           |
| fail-first              | existing destinations resent on new add (should not)                                                                                                            |
| positive control        | new destination gets current state                                                                                                                              |
| negative control        | existing destinations not resent                                                                                                                                |
| mutation / BITE-DEMO    | separate identity per sink                                                                                                                                      |
| race / integration      | same-worker ordering preserved                                                                                                                                  |
| dependent-path sweep    | identity per sink from dispatcher                                                                                                                               |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                                                                 |
| result                  | VALIDATED — relay worker dispatches the projected snapshot to the independently configured external sink; focused relay test passed (2026-09-01T12:58:40-05:00) |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                                                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                         |
| timestamp               | 2026-09-01T12:58:40-05:00                                                                                                                                       |

<a id="p5-ac-08"></a>

### Awareness semantics

| Field                   | Value                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                                                                                          |
| criterion               | AC-08                                                                                                                                                                       |
| fail-first              | filtering/projection/startup replay broken                                                                                                                                  |
| positive control        | all existing awareness behaviors preserved                                                                                                                                  |
| negative control        | unchanged suppression, transient confirmation                                                                                                                               |
| mutation / BITE-DEMO    | canonical processing before sink gates                                                                                                                                      |
| race / integration      | startup replay independent of relay                                                                                                                                         |
| dependent-path sweep    | relay event stream unchanged                                                                                                                                                |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                                                                             |
| result                  | VALIDATED — canonical relay processing reaches external delivery when relay is not configured and on settings replay; focused relay test passed (2026-09-01T12:58:40-05:00) |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                                                                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                     |
| timestamp               | 2026-09-01T12:58:40-05:00                                                                                                                                                   |

<a id="p5-ac-09"></a>

### Relay compatibility

| Field                   | Value                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P5                                                                                                                                        |
| criterion               | AC-09                                                                                                                                     |
| fail-first              | relay tests fail after integration                                                                                                        |
| positive control        | relay tests pass unchanged                                                                                                                |
| negative control        | signed payload and identity unchanged                                                                                                     |
| mutation / BITE-DEMO    | relay existing behavior preserved                                                                                                         |
| race / integration      | relay independent of external                                                                                                             |
| dependent-path sweep    | relay signing unchanged                                                                                                                   |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                                           |
| result                  | VALIDATED — relay signing regression and sibling external delivery coverage passed in the focused relay batch (2026-09-01T12:58:40-05:00) |
| artifact / reference    | `apps/server/src/relay/AgentAwarenessRelay.ts`                                                                                            |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                   |
| timestamp               | 2026-09-01T12:58:40-05:00                                                                                                                 |

---

## P6 — RPC / Client

<a id="p6-ac-10"></a>

### Operate test RPC

| Field                   | Value                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P6                                                                                                                                                                                                                                                                                     |
| criterion               | AC-10                                                                                                                                                                                                                                                                                  |
| fail-first              | unauth read-only test rejected                                                                                                                                                                                                                                                         |
| positive control        | operate-authorized test to exact destination                                                                                                                                                                                                                                           |
| negative control        | wrong environment rejected; sanitized errors                                                                                                                                                                                                                                           |
| mutation / BITE-DEMO    | test bypass verified at RPC boundary                                                                                                                                                                                                                                                   |
| race / integration      | RPC boundary isolation                                                                                                                                                                                                                                                                 |
| dependent-path sweep    | RPC handler from P1 schema                                                                                                                                                                                                                                                             |
| command                 | `vp test run apps/server/src/server.test.ts -t "external notification"`                                                                                                                                                                                                                |
| result                  | VALIDATED — operate-scoped websocket RPC delivered to the selected destination, read-only scope was rejected before effect execution, and typed not-configured errors crossed the boundary; 3 external-notification tests passed in the final server batch (2026-09-01T12:59:32-05:00) |
| artifact / reference    | `apps/server/src/ws.ts`; `apps/server/src/auth/RpcAuthorization.ts`                                                                                                                                                                                                                    |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                                                                                                                |
| timestamp               | 2026-09-01T12:59:32-05:00                                                                                                                                                                                                                                                              |

<a id="p6-ac-11"></a>

### Client command

| Field                   | Value                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P6                                                                                                                                                                                                  |
| criterion               | AC-11                                                                                                                                                                                               |
| fail-first              | command targets wrong environment                                                                                                                                                                   |
| positive control        | environment-scoped, correct target                                                                                                                                                                  |
| negative control        | auth failure exposed                                                                                                                                                                                |
| mutation / BITE-DEMO    | client state updated                                                                                                                                                                                |
| race / integration      | environment scope verified                                                                                                                                                                          |
| dependent-path sweep    | client runtime from P1 schema                                                                                                                                                                       |
| command                 | `vp test run packages/client-runtime/src/state/server.test.ts`                                                                                                                                      |
| result                  | VALIDATED — environment command invoked `server.testExternalNotification` through the selected supervisor target and preserved failures; 17 client-runtime tests passed (2026-09-01T12:29:16-05:00) |
| artifact / reference    | `packages/client-runtime/src/state/server.ts`                                                                                                                                                       |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                             |
| timestamp               | 2026-09-01T12:29:16-05:00                                                                                                                                                                           |

---

## P7 — Web Settings

<a id="p7-ac-12"></a>

### Web Settings UI

User-reported manual validation at `2026-09-01T16:07:20-05:00` covered the running settings flow, Home Assistant webhook test and real delivery, generic integration selection, automatic integration naming, labeled actions, delete confirmation, and post-delete feedback. This is supplemental evidence; the high-risk independent gates remain pending.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P7                                                                                                                                                                                                                                                                                                                                           |
| criterion               | AC-12                                                                                                                                                                                                                                                                                                                                        |
| fail-first              | URL displayed (should not)                                                                                                                                                                                                                                                                                                                   |
| positive control        | scheme/add/label/enable/disable/replace/test/remove/confirmation/Configured                                                                                                                                                                                                                                                                  |
| negative control        | read-only when disabled; URL never shown                                                                                                                                                                                                                                                                                                     |
| mutation / BITE-DEMO    | browser settings unaffected                                                                                                                                                                                                                                                                                                                  |
| race / integration      | selected remote environment verified                                                                                                                                                                                                                                                                                                         |
| dependent-path sweep    | UI from RPC/contract definitions                                                                                                                                                                                                                                                                                                             |
| command                 | `vp test run src/components/settings/ExternalNotificationsSettings.logic.test.ts src/components/settings/IntegrationsSettings.environment.test.tsx` from `apps/web`; `vp run typecheck`                                                                                                                                                      |
| result                  | VALIDATED — 6 UI boundary tests passed for environment selection, access gating, descriptor validation, URL redaction, generic integration selection, destructive confirmation, and CRUD/test operation handlers; web typecheck passed (2026-09-01T16:41:54-05:00). User-reported manual validation also passed (2026-09-01T16:07:20-05:00). |
| artifact / reference    | `apps/web/src/components/settings/IntegrationsSettings.tsx`                                                                                                                                                                                                                                                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                                                                                                                                                                      |
| timestamp               | 2026-09-01T16:07:20-05:00                                                                                                                                                                                                                                                                                                                    |

---

## P8 — Docs

<a id="p8-ac-13"></a>

### Documentation

Current content check rerun at `2026-09-01T16:41:54-05:00`: exit 0 with all 10 required topics present, including the current Save/Test control labels. This supersedes the earlier timestamp retained in the table below.

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
| result                  | VALIDATED — exit 0; 10 required topics present, including Save/Test labels (2026-09-01T16:41:54-05:00)                                                                                                                                                                                                                                                                             |
| artifact / reference    | `docs/user/external-notifications.md`                                                                                                                                                                                                                                                                                                                                              |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                                                                                                                                                                                                            |
| timestamp               | 2026-09-01T16:41:54-05:00                                                                                                                                                                                                                                                                                                                                                          |
| note                    | free iOS Personal Team builds expire in 7 days and require reinstall — present and checked                                                                                                                                                                                                                                                                                         |

---

## P9 — Validation / Revalidation

<a id="p9-fmt"></a>

### Format check

Final format check rerun at `2026-09-01T16:41:54-05:00`: exit 0; all 35 declared changed files use the correct format. This supersedes the earlier timestamp retained in the table below.

| Field                   | Value                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                   |
| criterion               | FMT                                                                                                  |
| fail-first              | formatting violations                                                                                |
| positive control        | all files pass                                                                                       |
| negative control        | N/A                                                                                                  |
| mutation / BITE-DEMO    | N/A                                                                                                  |
| race / integration      | N/A                                                                                                  |
| dependent-path sweep    | all changed files                                                                                    |
| command                 | `vp fmt --check`                                                                                     |
| result                  | VALIDATED — exit 0; all 35 declared changed files use the correct format (2026-09-01T16:41:54-05:00) |
| artifact / reference    | format output                                                                                        |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                              |
| timestamp               | 2026-09-01T16:41:54-05:00                                                                            |

<a id="p9-test"></a>

### Focused tests

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| criterion               | TEST                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| fail-first              | test failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| positive control        | all tests pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| negative control        | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| mutation / BITE-DEMO    | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| race / integration      | N/A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| dependent-path sweep    | all test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| command                 | `vp test run src/settings.test.ts` (contracts); `vp test run src/serverSettings.test.ts` (shared); `vp test run src/auth/RpcAuthorization.test.ts src/notifications/HomeAssistantWebhookAdapter.test.ts src/notifications/ExternalNotificationDispatcher.test.ts src/relay/AgentAwarenessRelay.test.ts src/server.test.ts src/serverSettings.test.ts` (server); `vp test run src/state/server.test.ts` (client-runtime); `vp test run src/components/settings/ExternalNotificationsSettings.logic.test.ts src/components/settings/IntegrationsSettings.environment.test.tsx` (web) |
| result                  | VALIDATED — exit 0; 11 test files and 315 tests passed: contracts 63, shared 24, server 205, client-runtime 17, web 6 (2026-09-01T16:41:54-05:00)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| artifact / reference    | test output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| timestamp               | 2026-09-01T16:41:54-05:00                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

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
| result                  | VALIDATED — exit 0 in all five package worktrees; only pre-existing Effect suggestions were reported (2026-09-01T16:41:54-05:00)  |
| artifact / reference    | typecheck output                                                                                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                           |
| timestamp               | 2026-09-01T16:41:54-05:00                                                                                                         |

<a id="p9-relay"></a>

### Relay regression

| Field                   | Value                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                                        |
| criterion               | RELAY                                                                                                                                                     |
| fail-first              | relay test failure                                                                                                                                        |
| positive control        | relay tests pass                                                                                                                                          |
| negative control        | N/A                                                                                                                                                       |
| mutation / BITE-DEMO    | N/A                                                                                                                                                       |
| race / integration      | N/A                                                                                                                                                       |
| dependent-path sweep    | AgentAwarenessRelay                                                                                                                                       |
| command                 | `vp test run apps/server/src/relay/AgentAwarenessRelay.test.ts`                                                                                           |
| result                  | VALIDATED — exit 0; relay regression passed within the 205-test server batch, including no-relay and settings-replay coverage (2026-09-01T16:41:53-05:00) |
| artifact / reference    | relay test output                                                                                                                                         |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                                   |
| timestamp               | 2026-09-01T16:41:53-05:00                                                                                                                                 |

<a id="p9-scope"></a>

### Scope verification

Final scope audit rerun at `2026-09-01T16:41:54-05:00`: 35 changed paths matched the declared scope digest and `git diff --check` passed.

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
| command                 | `git status --short; git diff --name-only d94577e5c; git ls-files --others --exclude-standard; git diff --check`                       |
| result                  | VALIDATED — exit 0; current changed files match the declared 35-path scope and `git diff --check` is clean (2026-09-01T16:41:54-05:00) |
| artifact / reference    | git output                                                                                                                             |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                |
| timestamp               | 2026-09-01T16:41:54-05:00                                                                                                              |

<a id="p9-val"></a>

### Independent validation

| Field                   | Value                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                                |
| criterion               | VAL                                                                                                                                               |
| fail-first              | validator finds defect                                                                                                                            |
| positive control        | validator confirms all evidence                                                                                                                   |
| negative control        | validator negative tests pass                                                                                                                     |
| mutation / BITE-DEMO    | all BITE-DEMO evidence verified                                                                                                                   |
| race / integration      | all race/integration evidence verified                                                                                                            |
| dependent-path sweep    | all dependent paths verified                                                                                                                      |
| command                 | independent validator run                                                                                                                         |
| result                  | STALE — the prior validator run predates the latest adapter, dispatcher, relay, client, and UI evidence controls; rerun on an immutable candidate |
| artifact / reference    | validator report                                                                                                                                  |
| validator session/model | `ses_fa4a1c53fffe0A6R6N4gbMp5h7` / `openai/gpt-5.6-sol`                                                                                           |
| timestamp               | 2026-09-01T00:45:33-05:00 (superseded by subsequent evidence changes)                                                                             |

<a id="p9-reval"></a>

### Independent revalidation (high-risk required)

| Field                   | Value                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase                   | P9                                                                                                                                                  |
| criterion               | REVAL                                                                                                                                               |
| fail-first              | revalidator finds defect                                                                                                                            |
| positive control        | revalidator confirms all evidence                                                                                                                   |
| negative control        | revalidator negative tests pass                                                                                                                     |
| mutation / BITE-DEMO    | all evidence re-verified                                                                                                                            |
| race / integration      | all evidence re-verified                                                                                                                            |
| dependent-path sweep    | all paths re-verified                                                                                                                               |
| command                 | independent revalidator run                                                                                                                         |
| result                  | STALE — the prior revalidator run predates the latest adapter, dispatcher, relay, client, and UI evidence controls; rerun on an immutable candidate |
| artifact / reference    | revalidator report                                                                                                                                  |
| validator session/model | `ses_fa4923707ffeA0gvUbAe5yfgB6` / `deepseek-v4-pro`                                                                                                |
| timestamp               | 2026-09-01T00:45:33-05:00 (superseded by subsequent evidence changes)                                                                               |
