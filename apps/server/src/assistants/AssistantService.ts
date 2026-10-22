import type {
  AssistantCreateInput,
  AssistantGetInput,
  AssistantUpdateConfigurationInput,
  AssistantLifecycleInput,
  AssistantListInput,
  AssistantDetail,
  AssistantListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Repository from "./AssistantRepository.ts";
import * as Provisioning from "./AssistantProvisioning.ts";
import type { AssistantError } from "./AssistantRepository.ts";

export class AssistantService extends Context.Service<
  AssistantService,
  {
    readonly create: (
      input: AssistantCreateInput,
    ) => Effect.Effect<AssistantDetail, AssistantError>;
    readonly get: (input: AssistantGetInput) => Effect.Effect<AssistantDetail, AssistantError>;
    readonly list: (
      input: AssistantListInput,
    ) => Effect.Effect<AssistantListResult, AssistantError>;
    readonly updateConfiguration: (
      input: AssistantUpdateConfigurationInput,
    ) => Effect.Effect<AssistantDetail, AssistantError>;
    readonly lifecycle: (
      input: AssistantLifecycleInput,
    ) => Effect.Effect<AssistantDetail, AssistantError>;
  }
>()("t3/assistants/AssistantService") {}
const make = Effect.gen(function* () {
  const repository = yield* Repository.AssistantRepository;
  const provisioning = yield* Provisioning.AssistantProvisioning;
  const create = Effect.fn("AssistantService.create")(function* (input: AssistantCreateInput) {
    const record = yield* repository.create(input);
    yield* provisioning.ensure(record).pipe(Effect.ignore);
    return (yield* repository.get(record.detail.summary)).detail;
  });
  const get = Effect.fn("AssistantService.get")(function* (input: AssistantGetInput) {
    return (yield* repository.get(input)).detail;
  });
  const list = Effect.fn("AssistantService.list")(function* (input: AssistantListInput) {
    const records = yield* repository.list(input);
    return {
      assistants: records.map((record) => record.detail.summary),
      nextCursor:
        records.length === input.limit ? records.at(-1)!.detail.summary.assistantId : null,
    };
  });
  const updateConfiguration = Effect.fn("AssistantService.updateConfiguration")(function* (
    input: AssistantUpdateConfigurationInput,
  ) {
    return (yield* repository.updateConfiguration(input)).detail;
  });
  const lifecycle = Effect.fn("AssistantService.lifecycle")(function* (
    input: AssistantLifecycleInput,
  ) {
    let record = yield* repository.lifecycle(input);
    if (input.action === "retry-provisioning") {
      yield* provisioning.ensure(record).pipe(Effect.ignore);
      record = yield* repository.get(input);
    }
    return record.detail;
  });
  return AssistantService.of({ create, get, list, updateConfiguration, lifecycle });
});
export const layer = Layer.effect(AssistantService, make);
