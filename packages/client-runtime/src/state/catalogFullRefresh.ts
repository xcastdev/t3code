import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

type CatalogContext = {
  readonly environmentId: EnvironmentId;
  readonly input: object;
};

const contextId = (input: object, field: string): string | undefined => {
  if (!(field in input)) return undefined;
  const value = Reflect.get(input, field);
  return typeof value === "string" ? value : undefined;
};

function matchesContext(query: CatalogContext, subscription: CatalogContext): boolean {
  if (query.environmentId !== subscription.environmentId) return false;
  for (const field of ["providerInstanceId", "projectId", "threadId"]) {
    const queryId = contextId(query.input, field);
    const subscriptionId = contextId(subscription.input, field);
    if (queryId && subscriptionId && queryId !== subscriptionId) return false;
  }
  const threadId = contextId(subscription.input, "threadId");
  const projectId = contextId(subscription.input, "projectId");
  const queryThreadId = contextId(query.input, "threadId");
  const queryProjectId = contextId(query.input, "projectId");
  if (threadId && !queryThreadId && queryProjectId && !projectId) return false;
  if (projectId && !threadId && queryThreadId && queryProjectId !== projectId) return false;
  return true;
}

/** Full notices describe the authenticated destination; their source domains were coalesced. */
export function makeCatalogFullRefreshSignals() {
  const active = new WeakMap<
    AtomRegistry.AtomRegistry,
    Map<
      symbol,
      {
        readonly target: CatalogContext;
        readonly signal: Atom.Writable<string>;
      }
    >
  >();
  let arrival = 0;
  return {
    refresh(target: CatalogContext) {
      const token = Symbol();
      const signal = Atom.make("");
      return Atom.make((get) => {
        let mounted = active.get(get.registry);
        if (!mounted) {
          mounted = new Map();
          active.set(get.registry, mounted);
        }
        mounted.set(token, { target, signal });
        get.addFinalizer(() => mounted.delete(token));
        return get(signal);
      });
    },
    publish(
      target: CatalogContext,
      eventId: string | undefined,
      registry: AtomRegistry.AtomRegistry,
    ) {
      const identity = eventId ?? `legacy-arrival:${++arrival}`;
      // A signal update can synchronously dispose/re-register a query's dependency.
      const mounted = [...(active.get(registry)?.values() ?? [])];
      for (const entry of mounted) {
        if (matchesContext(entry.target, target)) registry.set(entry.signal, identity);
      }
    },
  };
}
