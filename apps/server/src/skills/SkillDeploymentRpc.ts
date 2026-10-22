import type {
  ManagedSkillKey,
  SkillContentHash,
  SkillDeploymentChangeInput,
  SkillDeploymentListInput,
  SkillDeploymentTargetSummary,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { SkillRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { SkillCatalogService } from "./SkillCatalogService.ts";
import { SkillDeploymentService } from "./SkillDeploymentService.ts";

import type { SkillInstallTarget } from "./SkillInstallTargets.ts";

export const selectSkillDeploymentChange = Effect.fn("SkillDeploymentRpc.selectChange")(function* (
  input: SkillDeploymentChangeInput,
  source:
    | {
        readonly key: ManagedSkillKey;
        readonly hash: SkillContentHash;
        readonly packagePath: string;
      }
    | undefined,
  targets: ReadonlyArray<SkillInstallTarget>,
) {
  if (input.operation === "install" && (!source || source.hash !== input.expectedHash))
    return yield* new SkillRpcError({
      code: "revision_conflict",
      message: "The skill changed since it was selected.",
    });
  const target = targets.find((candidate) => candidate.id === input.target);
  if (!target)
    return yield* new SkillRpcError({
      code: "install_unavailable",
      message: "That install location is unavailable for this provider and project.",
    });
  const key = source?.key ?? input.key;
  if (!key)
    return yield* new SkillRpcError({
      code: "invalid_request",
      message: "A managed skill source or installed key is required.",
    });
  return { key, target, sourcePath: source?.packagePath ?? "" };
});

export const makeSkillDeploymentRpc = Effect.gen(function* () {
  const catalog = yield* SkillCatalogService;
  const instances = yield* ProviderInstanceRegistry;
  const deployment = yield* SkillDeploymentService;
  const context = Effect.fn("SkillDeploymentRpc.context")(function* (
    input: SkillDeploymentListInput,
    projectRoot?: string,
  ) {
    const instance = yield* instances.getInstance(input.providerInstanceId);
    if (instance === undefined)
      return yield* new SkillRpcError({
        code: "install_unavailable",
        message: "The selected provider is unavailable.",
      });
    const targets =
      instance.resolveSkillInstallTargets === undefined
        ? []
        : yield* instance.resolveSkillInstallTargets(projectRoot).pipe(
            Effect.mapError(
              () =>
                new SkillRpcError({
                  code: "install_unavailable",
                  message: "Provider install targets could not be verified.",
                }),
            ),
          );
    const source =
      input.skillId === undefined ? undefined : yield* catalog.source(input.skillId, projectRoot);
    return { targets, source };
  });
  const status = Effect.fn("SkillDeploymentRpc.status")(
    (
      providerInstanceId: ProviderInstanceId,
      target: SkillInstallTarget,
      key: ManagedSkillKey,
      sourcePath: string,
    ): Effect.Effect<SkillDeploymentTargetSummary> =>
      deployment.status({ providerInstanceId, targetRoot: target.root, key, sourcePath }).pipe(
        Effect.map((value) => ({
          id: target.id,
          key,
          path: target.root,
          readers: target.readers,
          status: value.state,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            id: target.id,
            key,
            path: target.root,
            readers: target.readers,
            status: "blocked" as const,
            detail: error.detail,
          }),
        ),
      ),
  );
  const list = Effect.fn("SkillDeploymentRpc.list")(function* (
    input: SkillDeploymentListInput,
    projectRoot?: string,
  ) {
    const { targets, source } = yield* context(input, projectRoot);
    const rows = yield* Effect.forEach(targets, (target) =>
      source !== undefined
        ? status(input.providerInstanceId, target, source.key, source.packagePath).pipe(
            Effect.map((row) => [row]),
          )
        : deployment
            .listOwned({ providerInstanceId: input.providerInstanceId, targetRoot: target.root })
            .pipe(
              Effect.map((items) =>
                items.map((item) => ({
                  id: target.id,
                  key: item.key,
                  path: target.root,
                  readers: target.readers,
                  status: item.state,
                  ...(item.state === "blocked" ? { detail: item.detail } : {}),
                })),
              ),
              Effect.mapError(
                (error) => new SkillRpcError({ code: error.code, message: error.detail }),
              ),
            ),
    );
    return { targets: rows.flat() };
  });
  const change = Effect.fn("SkillDeploymentRpc.change")(function* (
    input: SkillDeploymentChangeInput,
    projectRoot?: string,
  ) {
    const { targets, source } = yield* context(input, projectRoot);
    const { key, target, sourcePath } = yield* selectSkillDeploymentChange(input, source, targets);
    const deploymentInput = {
      providerInstanceId: input.providerInstanceId,
      targetRoot: target.root,
      key,
      sourcePath,
      ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }),
    };
    yield* (
      input.operation === "install"
        ? deployment.install(deploymentInput)
        : deployment.uninstall(deploymentInput)
    ).pipe(
      Effect.mapError((error) => new SkillRpcError({ code: error.code, message: error.detail })),
    );
    yield* catalog.notifyInstalledSkillChanged(target.readers, key);
    return { status: yield* status(input.providerInstanceId, target, key, sourcePath) };
  });
  return { list, change };
});
