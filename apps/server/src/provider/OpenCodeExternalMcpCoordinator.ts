import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { validateExternalOpenCodeUrl } from "./OpenCodeExternalMcpUrl.ts";

export interface OpenCodeExternalMcpTarget {
  readonly serverUrl: string;
  readonly directory: string;
}

export interface OpenCodeExternalMcpLease {
  readonly target: OpenCodeExternalMcpTarget;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly generation: string;
}

export interface OpenCodeExternalMcpAcquireInput {
  readonly target: OpenCodeExternalMcpTarget;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}

export const normalizeExternalOpenCodeTarget = (
  input: OpenCodeExternalMcpTarget,
): OpenCodeExternalMcpTarget => ({
  serverUrl: validateExternalOpenCodeUrl(input.serverUrl),
  directory: input.directory,
});

export class OpenCodeExternalMcpCoordinatorError extends Data.TaggedError(
  "OpenCodeExternalMcpCoordinatorError",
)<{
  readonly operation: "normalize" | "acquire";
  readonly detail: string;
  readonly target?: OpenCodeExternalMcpTarget;
  readonly cause?: unknown;
}> {}

interface CoordinatorState {
  readonly leases: ReadonlyMap<string, OpenCodeExternalMcpLease>;
  readonly counter: number;
}

const targetKey = (target: OpenCodeExternalMcpTarget): string =>
  `${target.serverUrl}\u0000${target.directory}`;

const sameLease = (left: OpenCodeExternalMcpLease, right: OpenCodeExternalMcpLease): boolean =>
  left.generation === right.generation &&
  left.target.serverUrl === right.target.serverUrl &&
  left.target.directory === right.target.directory &&
  left.environmentId === right.environmentId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.threadId === right.threadId;

export interface OpenCodeExternalMcpCoordinatorShape {
  readonly acquire: (
    input: OpenCodeExternalMcpAcquireInput,
  ) => Effect.Effect<OpenCodeExternalMcpLease, OpenCodeExternalMcpCoordinatorError>;
  readonly isCurrent: (lease: OpenCodeExternalMcpLease) => Effect.Effect<boolean>;
  readonly release: (lease: OpenCodeExternalMcpLease) => Effect.Effect<void>;
}

export class OpenCodeExternalMcpCoordinator extends Context.Service<
  OpenCodeExternalMcpCoordinator,
  OpenCodeExternalMcpCoordinatorShape
>()("t3/provider/OpenCodeExternalMcpCoordinator") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const processNonce = yield* crypto.randomUUIDv4;
  const state = yield* Ref.make<CoordinatorState>({ leases: new Map(), counter: 0 });

  const acquire: OpenCodeExternalMcpCoordinatorShape["acquire"] = Effect.fn(
    "OpenCodeExternalMcpCoordinator.acquire",
  )(function* (input) {
    const target = yield* Effect.try({
      try: () => normalizeExternalOpenCodeTarget(input.target),
      catch: (cause) =>
        new OpenCodeExternalMcpCoordinatorError({
          operation: "normalize",
          detail: cause instanceof Error ? cause.message : String(cause),
          target: input.target,
          cause,
        }),
    });
    const result = yield* Ref.modify(state, (current) => {
      const key = targetKey(target);
      if (current.leases.has(key)) {
        return [undefined, current] as const;
      }
      const counter = current.counter + 1;
      const lease: OpenCodeExternalMcpLease = {
        target,
        environmentId: input.environmentId,
        providerInstanceId: input.providerInstanceId,
        threadId: input.threadId,
        generation: `${processNonce}-${counter}`,
      };
      const leases = new Map(current.leases);
      leases.set(key, lease);
      return [lease, { leases, counter }] as const;
    });
    if (result === undefined) {
      return yield* new OpenCodeExternalMcpCoordinatorError({
        operation: "acquire",
        detail: `Another T3 session already manages external OpenCode URL '${target.serverUrl}' and directory '${target.directory}'.`,
        target,
      });
    }
    return result;
  });

  const isCurrent: OpenCodeExternalMcpCoordinatorShape["isCurrent"] = (lease) =>
    Ref.get(state).pipe(
      Effect.map((current) => {
        const existing = current.leases.get(targetKey(lease.target));
        return existing !== undefined && sameLease(existing, lease);
      }),
    );

  const release: OpenCodeExternalMcpCoordinatorShape["release"] = Effect.fn(
    "OpenCodeExternalMcpCoordinator.release",
  )(function* (lease) {
    yield* Ref.update(state, (current) => {
      const existing = current.leases.get(targetKey(lease.target));
      if (existing === undefined || !sameLease(existing, lease)) return current;
      const leases = new Map(current.leases);
      leases.delete(targetKey(lease.target));
      return { ...current, leases };
    });
  });

  return OpenCodeExternalMcpCoordinator.of({ acquire, isCurrent, release });
});

export const layer = Layer.effect(OpenCodeExternalMcpCoordinator, make);
