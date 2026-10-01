import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EnvironmentId } from "@t3tools/contracts";
import { seed, scoped } from "../../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { ProjectTerminalService } from "../../../terminal/ProjectTerminalService.ts";
import { TerminalToolkit } from "./tools.ts";
import { TerminalToolkitHandlersLive } from "./handlers.ts";
for (const role of ["investigator", "implementer", "integrator"])
  it.effect(
    `denies actual terminal toolkit for managed ${role} despite broad credential grants`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* seed(role);
          let spawned = 0;
          const service = Layer.mock(ProjectTerminalService)({
            spawn: () => {
              spawned++;
              return Effect.die("Host terminal reached");
            },
          });
          const toolkit = yield* TerminalToolkit.pipe(
            Effect.provide(TerminalToolkitHandlersLive.pipe(Layer.provide(service))),
          );
          const invocation = {
            environmentId: EnvironmentId.make("environment"),
            providerInstanceId: f.principal.managed.providerInstanceId,
            threadId: f.principal.managed.threadId,
            providerSessionId: "issued-session",
            managed: f.principal.managed,
            capabilities: new Set(["terminal" as const]),
            issuedAt: 0,
          };
          const result = yield* toolkit
            .handle("terminal_spawn", { command: "forbidden" })
            .pipe(
              Stream.unwrap,
              Stream.runCollect,
              Effect.provideService(Invocation.McpInvocationContext, invocation),
              Effect.provide(service),
              Effect.result,
            );
          expect(result._tag).toBe("Failure");
          expect(spawned).toBe(0);
        }),
      ),
  );
