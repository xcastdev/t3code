import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  ProjectWorkAttentionReasonRead,
  ProjectWorkTaskId,
  ProjectWorkTaskStateRead,
} from "./projectWork.ts";
import type { ExternalNotificationAppScheme } from "./settings.ts";
import { RelayAgentActivityState, RelayAgentAwarenessPhase } from "./relay.ts";

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
  /** Optional durable-work context. Older clients ignore this additive field. */
  projectWork: Schema.optionalKey(
    Schema.Struct({
      projectId: ProjectId,
      taskId: ProjectWorkTaskId,
      state: ProjectWorkTaskStateRead,
      reason: Schema.optionalKey(ProjectWorkAttentionReasonRead),
      revision: Schema.Number,
    }),
  ),
});
export type ExternalNotificationPayload = typeof ExternalNotificationPayload.Type;

export const ExternalNotificationProjectWorkPayload =
  ExternalNotificationPayload.fields.projectWork;

export const ExternalNotificationTestInput = Schema.Struct({ destinationId: Schema.String });
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

export class ExternalNotificationError extends Schema.TaggedError<ExternalNotificationError>()(
  "ExternalNotificationError",
  {
    destinationId: Schema.String,
    reason: ExternalNotificationFailureReason,
    status: Schema.optional(Schema.Int),
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

interface NotificationLinkTarget {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly projectWork?: {
    readonly projectId: ProjectId | string;
    readonly taskId: ProjectWorkTaskId | string;
  };
}

const exactWorkIdentity = (value: string) =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;

function workLinkSegments(input: NotificationLinkTarget) {
  if (input.projectWork === undefined) return undefined;
  if (
    !exactWorkIdentity(input.environmentId) ||
    !exactWorkIdentity(input.projectWork.projectId) ||
    !exactWorkIdentity(input.projectWork.taskId)
  )
    throw new TypeError("Invalid durable Work notification target");
  return [input.environmentId, input.projectWork.projectId, input.projectWork.taskId].map(
    encodeURIComponent,
  );
}

export function buildExternalNotificationRelativeRoute(input: NotificationLinkTarget): string {
  const work = workLinkSegments(input);
  if (work) return `/work/${work[0]}/${work[1]}?taskId=${work[2]}`;
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function buildExternalNotificationDeepLink(
  input: NotificationLinkTarget & {
    readonly appScheme: ExternalNotificationAppScheme;
  },
): string {
  const work = workLinkSegments(input);
  if (work) return `${input.appScheme}://work/${work[0]}/${work[1]}/tasks/${work[2]}`;
  return `${input.appScheme}://threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}
