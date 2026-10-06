import {
  ExternalNotificationPayload,
  ProjectWorkAttentionReason,
  ProjectWorkTaskState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeWorkNotification = Schema.decodeUnknownOption(
  Schema.Struct({
    schemaVersion: ExternalNotificationPayload.fields.schemaVersion,
    environmentId: ExternalNotificationPayload.fields.environmentId,
    projectWork: ExternalNotificationPayload.fields.projectWork,
  }),
);
const isKnownTaskState = Schema.is(ProjectWorkTaskState);
const isKnownAttentionReason = Schema.is(ProjectWorkAttentionReason);

function isExactNotificationIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

function projectWorkDeepLink(data: Record<string, unknown>): string | null {
  const context = data.projectWork;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    return null;
  }
  const work = context as Record<string, unknown>;
  if (
    !isExactNotificationIdentity(data.environmentId) ||
    !isExactNotificationIdentity(work.projectId) ||
    !isExactNotificationIdentity(work.taskId)
  ) {
    return null;
  }
  const notification = Option.getOrNull(decodeWorkNotification(data));
  if (
    !notification?.projectWork ||
    !isKnownTaskState(notification.projectWork.state) ||
    (notification.projectWork.reason !== undefined &&
      !isKnownAttentionReason(notification.projectWork.reason)) ||
    !Number.isSafeInteger(notification.projectWork.revision) ||
    notification.projectWork.revision < 0
  ) {
    return null;
  }
  try {
    // A notification only opens the task; current state and authority come from its screen.
    return `/work/${encodeURIComponent(notification.environmentId)}/${encodeURIComponent(notification.projectWork.projectId)}/tasks/${encodeURIComponent(notification.projectWork.taskId)}`;
  } catch {
    return null;
  }
}

function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const content = (request as { readonly content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const data = (content as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const identifier = (request as { readonly identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  // A malformed work hint must not redirect to an obsolete or unrelated provider thread.
  if (data && "projectWork" in data) {
    return projectWorkDeepLink(data);
  }
  const deepLink = data?.deepLink;
  if (typeof deepLink === "string") {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string") {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(deepLink);
  }
}
