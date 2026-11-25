import {
  EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  antigravityWindowLimitsModel,
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  displayLimitWindows,
  findThreadLimitAccount,
  hubRoutes,
  instanceHubs,
  type LimitAccount,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "pool"; readonly windows: readonly LimitPoolWindow[] };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits;
  if (!own) return null;
  const hubs = instanceHubs(provider, sources);
  if (limitsNotice(own) === null || hubs.length === 0) return { kind: "instance", limits: own };
  // An instance sent to a hub reads no limits of its own; its hub pools the accounts it spends.
  return hubPool(provider.driver, model, providers, hubs, now) ?? { kind: "instance", limits: own };
}

export function resolveThreadHttpQuotas(
  providerInstanceId: ProviderInstanceId | null,
  sources: UsageLimitSourceSnapshots,
) {
  if (providerInstanceId === null) return [];
  return sources.flatMap((source) =>
    source.kind === "http"
      ? (source.quotaAccounts ?? []).flatMap((account) =>
          account.providerInstanceId === providerInstanceId
            ? account.windows.map((window) => ({
                key: JSON.stringify([source.id, account.id, window.id]),
                accountLabel: account.label,
                window,
              }))
            : [],
        )
      : [],
  );
}

/**
 * What the thread's usage shows, for the collapsed summary and the section alike. Another
 * same-driver account stands in only while the instance has no HTTP quota rows of its own; with
 * them, only the instance's own account counts, else its own limits and rows show.
 */
export function resolveThreadUsage(
  accounts: readonly LimitAccount[],
  input: {
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId | null;
    readonly driver: ProviderDriverKind | null;
    readonly ownLimits: ThreadDetailsLimits | null;
    readonly quotas: ReturnType<typeof resolveThreadHttpQuotas>;
    readonly now: number;
  },
) {
  const { ownLimits, quotas } = input;
  const ownKey = `${input.environmentId}:${input.instanceId}`;
  const account =
    quotas.length === 0
      ? findThreadLimitAccount(accounts, input)
      : (accounts.find((entry) => entry.key === ownKey && entry.driver === input.driver) ?? null);
  // A hub's pool wins: the instance it routes reads no limits of its own.
  const pool = ownLimits?.kind === "pool" ? ownLimits.windows : null;
  // Without an account, the instance's own snapshot can still show windows or explain why it has none.
  const snapshot =
    pool === null && account === null && ownLimits?.kind === "instance" ? ownLimits.limits : null;
  const readable = snapshot !== null && limitsNotice(snapshot) === null;
  const windows = account?.limits.windows ?? (readable ? snapshot.windows : []);
  // HTTP quota rows answer for the instance, so its "no limits" notice steps aside.
  const notice = snapshot !== null && !readable && quotas.length === 0 ? snapshot : null;
  const summaryWindows: readonly ServerProviderUsageWindow[] =
    pool !== null
      ? pool.map((window) => {
          const reset = nextPoolReset(window, input.now);
          return {
            id: window.id,
            kind: window.kind,
            label: window.label,
            usedPercent: window.usedPercent,
            ...(reset === null ? {} : { resetsAt: new Date(reset.at).toISOString() }),
          };
        })
      : windows.length > 0
        ? windows
        : quotas.map((quota) => quota.window);
  return {
    account,
    pool,
    notice,
    windows,
    summaryWindows,
    shown:
      account !== null ||
      pool !== null ||
      notice !== null ||
      windows.length > 0 ||
      quotas.length > 0,
  };
}

export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

function hubPool(
  driver: ServerProvider["driver"],
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const routes = hubRoutes(sources, driver, model);
  const routed = sources.map((source) => ({
    ...source,
    accounts: source.accounts.filter(routes).map((account) =>
      account.driver === "antigravity"
        ? {
            ...account,
            usageLimits: {
              ...account.usageLimits,
              windows: account.usageLimits.windows.filter((window) =>
                antigravityWindowLimitsModel(window, model),
              ),
            },
          }
        : account,
    ),
  }));
  const readable = routed
    .flatMap((source) => source.accounts)
    .filter((account) => limitsNotice(account.usageLimits) === null);
  if (readable.length === 0) return null;
  // A signed-in login joins the pool only as a fresher reading of an account the hub routes to.
  const signedIn = providers.filter((provider) =>
    readable.some(
      (account) =>
        account.driver === provider.driver &&
        account.workspaceId === provider.auth.workspaceId &&
        account.email !== undefined &&
        account.email.toLowerCase() === provider.auth.email?.toLowerCase(),
    ),
  );
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: signedIn, usageLimitSources: routed },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools.length > 0 ? { kind: "pool", windows: pools.flatMap(displayLimitWindows) } : null;
}

export function poolSources(window: LimitPoolWindow) {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return { hubs: [...new Set(hubs)], signedIn };
}
