import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
  type ExternalNotificationEvent,
  type ExternalNotificationTestEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export type NotificationSample = ExternalNotificationEvent | ExternalNotificationTestEvent;

export const notificationEnvironment = (
  label = Effect.succeed("Test environment"),
  id = "test-environment",
) => {
  const environmentId = EnvironmentId.make(id);
  return Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getLabel: label,
    getDescriptor: label.pipe(
      Effect.map((label): ExecutionEnvironmentDescriptor => ({
        environmentId,
        label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: false },
      })),
    ),
  });
};
