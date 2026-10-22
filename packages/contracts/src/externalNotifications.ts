import * as Schema from "effect/Schema";
import { ExternalNotificationDestination } from "./settings.ts";

export const ExternalNotificationTestInput = Schema.Struct({
  destinationId: ExternalNotificationDestination.fields.id,
});
export type ExternalNotificationTestInput = typeof ExternalNotificationTestInput.Type;

export const ExternalNotificationTestResult = Schema.Struct({
  status: Schema.Literals(["delivered", "failed"]),
  reason: Schema.optionalKey(
    Schema.Literals(["unconfigured", "malformed-url", "transport", "timeout", "http-status"]),
  ),
});
export type ExternalNotificationTestResult = typeof ExternalNotificationTestResult.Type;
