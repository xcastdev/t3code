import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SelfHostedRelayRevokeEnvironmentInput,
  SelfHostedRelaySessionCredential,
} from "@t3tools/contracts/selfHostedRelay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import { RelayListenPort } from "../relay/relayListenPort.ts";

const homeDirectory = Flag.String("home-dir").pipe(
  Flag.withDescription("Explicit path to the relay data directory."),
);
const encodeCredential = Schema.encodeEffect(
  Schema.fromJsonString(SelfHostedRelaySessionCredential),
);

const storageUnavailable = (error: { readonly reason: string }) =>
  new CliError.UserError({
    cause: error.reason,
    userMessage:
      error.reason === "ownership-conflict"
        ? "This relay home is in use. Stop its relay before opening it again."
        : "Could not open relay storage. Check the relay home and its permissions.",
  });

const resolveHomeDirectory = Effect.fn("RelayCli.resolveHomeDirectory")(function* (value: string) {
  if (value.trim().length === 0) {
    return yield* new CliError.UserError({
      cause: "missing_home_directory",
      userMessage: "Supply a relay data directory with --home-dir.",
    });
  }
  const path = yield* Path.Path;
  return path.resolve(value);
});

const serve = Command.make("serve", {
  homeDirectory,
  forwardingConfig: Flag.String("forwarding-config").pipe(
    Flag.withDescription(
      "Provisioned HTTPS ingress, publisher control, and optional public hooks manifest.",
    ),
    Flag.optional,
  ),
  port: Flag.Int("port").pipe(
    Flag.withSchema(RelayListenPort),
    Flag.withDescription("Loopback port, or 0 for an OS-selected port."),
    Flag.withDefault(0),
  ),
}).pipe(
  Command.withDescription(
    "Run a standalone self-hosted relay on loopback. A forwarding manifest enables separate HTTPS listeners.",
  ),
  Command.withHandler(
    Effect.fn("RelayCli.serve")(function* (flags) {
      const directory = yield* resolveHomeDirectory(flags.homeDirectory);
      const { layer } = yield* Effect.promise(
        () => import("../relay/SelfHostedRelayApplication.ts"),
      );
      const forwardingConfigPath = Option.getOrUndefined(flags.forwardingConfig);
      return yield* Layer.launch(
        layer({
          homeDirectory: directory,
          port: flags.port,
          ...(forwardingConfigPath === undefined ? {} : { forwardingConfigPath }),
        }),
      ).pipe(
        Effect.catchTags({
          RelayStorageError: (error) => Effect.fail(storageUnavailable(error)),
          SelfHostedRelayConfigError: (error) =>
            Effect.fail(
              new CliError.UserError({
                cause: "invalid_forwarding_config",
                userMessage: error.message,
              }),
            ),
        }),
      );
    }),
  ),
);

const ownerCommand = (command: "bootstrap-owner" | "recover-owner", description: string) =>
  Command.make(command, { homeDirectory }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      Effect.fn("RelayCli.owner")(function* (flags) {
        const directory = yield* resolveHomeDirectory(flags.homeDirectory);
        const { RelayRuntime, relayRuntimeLayer } = yield* Effect.promise(
          () => import("@t3tools/relay-core/RelayRuntime"),
        );
        const credential = yield* Effect.gen(function* () {
          const runtime = yield* RelayRuntime;
          return yield* command === "bootstrap-owner"
            ? runtime.bootstrapOwner()
            : runtime.recoverOwner();
        }).pipe(
          Effect.provide(relayRuntimeLayer({ homeDirectory: directory })),
          Effect.catchTags({
            RelayStorageError: (error) => Effect.fail(storageUnavailable(error)),
            RelayRuntimeStateError: (error) =>
              Effect.fail(
                new CliError.UserError({
                  cause: error.reason,
                  userMessage: error.message,
                }),
              ),
          }),
        );
        const output = yield* encodeCredential(credential).pipe(
          Effect.mapError(
            () =>
              new CliError.UserError({
                cause: "invalid_owner_credential_output",
                userMessage: "Could not encode the owner credential.",
              }),
          ),
        );
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              process.stdout.write(`${output}\n`, (error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
          catch: () =>
            new CliError.UserError({
              cause: "owner_credential_output_failed",
              userMessage: "Could not write the owner credential to stdout.",
            }),
        });
      }),
    ),
  );

const withOriginHome = Effect.fn("RelayCli.withOriginHome")(function* (
  home: string,
  action: "initialize" | "register" | "retire",
  operate: (directory: string) => void,
) {
  const directory = yield* resolveHomeDirectory(home);
  const { RelayRuntime, relayRuntimeLayer } = yield* Effect.promise(
    () => import("@t3tools/relay-core/RelayRuntime"),
  );
  yield* RelayRuntime.pipe(
    Effect.andThen(
      Effect.try({
        try: () => operate(directory),
        catch: () =>
          new CliError.UserError({
            cause: "origin_authority_operation_failed",
            userMessage: `Could not ${action} relay origin authority. Check the authority and the supplied options.`,
          }),
      }),
    ),
    Effect.provide(relayRuntimeLayer({ homeDirectory: directory })),
    Effect.catchTags({ RelayStorageError: (error) => Effect.fail(storageUnavailable(error)) }),
  );
});

const originInit = Command.make("init", { homeDirectory }).pipe(
  Command.withDescription("Provision a new independent origin authority offline."),
  Command.withHandler(
    Effect.fn("RelayCli.originInit")(function* (flags) {
      const { initializeRelayHomeOriginRegistry } = yield* Effect.promise(
        () => import("../relay/RelayOriginRegistry.ts"),
      );
      yield* withOriginHome(flags.homeDirectory, "initialize", initializeRelayHomeOriginRegistry);
    }),
  ),
);

const isRelayEnvironmentId = Schema.is(SelfHostedRelayRevokeEnvironmentInput.fields.environmentId);
const originChange = (operation: "register" | "retire", description: string) =>
  Command.make(operation, {
    homeDirectory,
    origin: Flag.String("origin").pipe(Flag.withDescription("Canonical HTTPS origin.")),
    environmentId: Flag.String("environment-id").pipe(
      Flag.withDescription("Identity of the environment bound to the origin."),
    ),
  }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      Effect.fn("RelayCli.originChange")(function* (flags) {
        const { environmentId, origin } = flags;
        if (!isRelayEnvironmentId(environmentId) || environmentId.trim() !== environmentId) {
          return yield* new CliError.UserError({
            cause: "invalid_environment_id",
            userMessage: "Supply a valid relay environment identity with --environment-id.",
          });
        }
        const { openRelayHomeOriginRegistry } = yield* Effect.promise(
          () => import("../relay/RelayOriginRegistry.ts"),
        );
        yield* withOriginHome(flags.homeDirectory, operation, (directory) => {
          using registry = openRelayHomeOriginRegistry(directory);
          if (registry === undefined) throw new Error("Relay origin authority is missing");
          registry[operation](origin, environmentId);
        });
      }),
    ),
  );

const originCommand = Command.make("origin").pipe(
  Command.withDescription("Manage permanent relay origin bindings offline."),
  Command.withSubcommands([
    originInit,
    originChange("register", "Permanently reserve an HTTPS origin for an environment."),
    originChange("retire", "Permanently retire a registered HTTPS origin."),
  ]),
);

export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("Run or administer a self-hosted relay."),
  Command.withSubcommands([
    serve,
    originCommand,
    ownerCommand(
      "bootstrap-owner",
      "Create the initial owner and print its private credential JSON.",
    ),
    ownerCommand(
      "recover-owner",
      "Rotate owner access offline and print its private credential JSON.",
    ),
  ]),
);

export function runRelayCli(args: ReadonlyArray<string>) {
  Command.runWith(relayCommand, { version: packageJson.version })(args).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
