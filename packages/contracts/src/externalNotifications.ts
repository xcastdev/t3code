import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import type { ExternalNotificationAppScheme } from "./settings.ts";
import { RelayAgentAwarenessPhase, RelayAgentActivityState } from "./relay.ts";

/** The payload sent by an external notification adapter. */
export const ExternalNotificationPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  test: Schema.Boolean,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: Schema.NullOr(RelayAgentActivityState),
  projectTitle: Schema.optionalKey(Schema.String),
  threadTitle: Schema.optionalKey(Schema.String),
  modelTitle: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(RelayAgentAwarenessPhase),
  headline: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  relativeRoute: Schema.String,
  deepLink: Schema.String,
});
export type ExternalNotificationPayload = typeof ExternalNotificationPayload.Type;

export const ExternalNotificationTestInput = Schema.Struct({
  destinationId: Schema.String,
});
export type ExternalNotificationTestInput = typeof ExternalNotificationTestInput.Type;

export const ExternalNotificationTestResult = Schema.Struct({
  destinationId: Schema.String,
  delivered: Schema.Literal(true),
});
export type ExternalNotificationTestResult = typeof ExternalNotificationTestResult.Type;

export const ExternalNotificationFailureReason = Schema.Literals([
  "malformed-url",
  "timeout",
  "transport",
  "http-status",
  "not-configured",
]);
export type ExternalNotificationFailureReason = typeof ExternalNotificationFailureReason.Type;

export class ExternalNotificationError extends Schema.TaggedErrorClass<ExternalNotificationError>()(
  "ExternalNotificationError",
  {
    destinationId: Schema.String,
    reason: ExternalNotificationFailureReason,
    status: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed-url":
        return "The notification destination URL is invalid.";
      case "timeout":
        return "The notification destination did not respond in time.";
      case "transport":
        return "The notification destination could not be reached.";
      case "http-status":
        return `The notification destination rejected the request${this.status === undefined ? "." : ` (HTTP ${this.status}).`}`;
      case "not-configured":
        return "The notification destination is not configured.";
    }
  }
}

export function buildExternalNotificationRelativeRoute(input: {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function buildExternalNotificationDeepLink(input: {
  readonly appScheme: ExternalNotificationAppScheme;
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
}): string {
  return `${input.appScheme}://threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}
