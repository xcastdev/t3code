import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExternalNotificationDestinationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
);

const THREAD_NOTIFICATION_EVENTS = [
  "completion",
  "failure",
  "cancelled",
  "update",
  "unknown",
  "needs-input",
  "needs-approval",
] as const;

export const DEFAULT_EXTERNAL_NOTIFICATION_EVENTS = [
  ...THREAD_NOTIFICATION_EVENTS,
  "work-attention",
] as const;

export const ExternalNotificationEventType = Schema.Literals(DEFAULT_EXTERNAL_NOTIFICATION_EVENTS);
export type ExternalNotificationEventType = typeof ExternalNotificationEventType.Type;

const eventFields = {
  environmentId: Schema.String,
  environmentName: Schema.String,
  occurrenceId: TrimmedNonEmptyString,
  timestamp: IsoDateTime,
  title: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(Schema.String),
};

export const ExternalNotificationEvent = Schema.Union([
  Schema.Struct({
    ...eventFields,
    eventType: Schema.Literals(THREAD_NOTIFICATION_EVENTS),
  }),
  Schema.Struct({
    ...eventFields,
    eventType: Schema.Literal("work-attention"),
    reason: Schema.String,
  }),
]);
export type ExternalNotificationEvent = typeof ExternalNotificationEvent.Type;

export const ExternalNotificationTestEvent = Schema.Struct({
  ...eventFields,
  eventType: Schema.Literal("test"),
});
export type ExternalNotificationTestEvent = typeof ExternalNotificationTestEvent.Type;

export const ExternalNotificationTestInput = Schema.Struct({
  destinationId: ExternalNotificationDestinationId,
});
export type ExternalNotificationTestInput = typeof ExternalNotificationTestInput.Type;

export const ExternalNotificationFailureReason = Schema.Literals([
  "unconfigured",
  "malformed-url",
  "transport",
  "timeout",
  "http-status",
]);

export const ExternalNotificationTestResult = Schema.Struct({
  status: Schema.Literals(["delivered", "failed"]),
  reason: Schema.optionalKey(ExternalNotificationFailureReason),
});
export type ExternalNotificationTestResult = typeof ExternalNotificationTestResult.Type;
