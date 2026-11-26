import { openRelayOriginRegistry } from "./RelayOriginRegistry.ts";
import { makeStaticRelayEdge } from "@t3tools/relay-core/RelayTunnelTransport";

export function makeRelayProofEdge(
  options: Omit<Parameters<typeof makeStaticRelayEdge>[0], "admission"> & {
    readonly authorityPath: string;
    readonly environmentId: string;
  },
) {
  const { authorityPath, environmentId, ...edgeOptions } = options;
  const registry = openRelayOriginRegistry(authorityPath);

  try {
    const edge = makeStaticRelayEdge({
      ...edgeOptions,
      admission: () => {
        try {
          const record = registry.lookup(options.publicOrigin);
          return record.status !== "unknown" && record.environmentId === environmentId
            ? record.status
            : "unknown";
        } catch {
          return "unknown";
        }
      },
    });

    return {
      ...edge,
      retire: () => {
        registry.retire(options.publicOrigin, environmentId);
        edge.revoke();
      },
      [Symbol.dispose]: () => {
        edge.revoke();
        registry[Symbol.dispose]();
      },
    };
  } catch (error) {
    registry[Symbol.dispose]();
    throw error;
  }
}
