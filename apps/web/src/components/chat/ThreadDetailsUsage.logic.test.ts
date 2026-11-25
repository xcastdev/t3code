import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import type { LimitAccount, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
  resolveThreadUsage,
  type ThreadDetailsLimits,
} from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("claudeAgent");

function limitsAt(usedPercent: number): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

interface HubAccountInput {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly models?: readonly string[];
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  origin = "http://127.0.0.1:8317",
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    origin,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.models ? { models: account.models } : {}),
      usageLimits: account.limits,
    })),
  };
}

function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  model: string | null,
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    model,
    [claudeInstance(own)],
    sources,
    now,
  );
  if (resolved?.kind !== "pool") return resolved;
  return {
    kind: resolved.kind,
    rows: resolved.windows.map((window) => ({
      label: window.label,
      left: window.remainingPercent,
      accounts: window.members.length,
      from: poolSources(window),
    })),
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("keeps an instance's failed reading instead of a hub it is not sent to", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const direct = { ...claudeInstance(failed), auth: { status: "authenticated" as const } };
    const elsewhere = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    const otherHub = hub("Other", [{ id: "a.json", limits: limitsAt(20) }], "http://hub");
    expect(resolveThreadDetailsLimits(instanceId, null, [direct], [readableHub], now)).toEqual({
      kind: "instance",
      limits: failed,
    });
    expect(resolveThreadDetailsLimits(instanceId, null, [elsewhere], [otherHub], now)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });

  it("pools only the accounts the hub routes the model to, even of another driver", () => {
    const sources = [
      hub("Hub", [
        { id: "a.json", models: ["claude-opus-5-5"], limits: limitsAt(10) },
        { id: "c.json", driver: codex, models: ["gpt-5.6-sol"], limits: limitsAt(30) },
      ]),
    ];
    expect(shown(unsupported, sources, "gpt-5.6-sol[1m]")).toEqual({
      kind: "pool",
      rows: [{ label: "Session", left: 70, accounts: 1, from: { hubs: ["Hub"], signedIn: false } }],
    });
  });
});

describe("resolveThreadHttpQuotas", () => {
  it("shows only the quota accounts bound to the thread's provider instance", () => {
    const window = { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 } as const;
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("quota"),
      kind: "http",
      label: "Quota server",
      checkedAt,
      accounts: [],
      quotaAccounts: [
        { id: "bound", label: "Work plan", providerInstanceId: instanceId, windows: [window] },
        { id: "unbound", label: "Unbound", windows: [window] },
        {
          id: "other",
          label: "Other plan",
          providerInstanceId: ProviderInstanceId.make("other"),
          windows: [window],
        },
      ],
    };
    expect(
      resolveThreadHttpQuotas(instanceId, [source]).map((quota) => quota.accountLabel),
    ).toEqual(["Work plan"]);
    expect(resolveThreadHttpQuotas(null, [source])).toEqual([]);
  });
});

describe("resolveThreadUsage", () => {
  const environmentId = EnvironmentId.make("environment");
  const account = (key: string): LimitAccount => ({
    key,
    driver: claude,
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [{ environmentId, label: "" }],
    sourceLabel: null,
    redeem: null,
    limits: limitsAt(40),
  });
  const own = account(`${environmentId}:${instanceId}`);
  // Another login of the driver, or one collectLimitAccounts merged this instance into.
  const other = account(`${environmentId}:claude-personal`);
  const ownWindows: ServerProviderUsageLimits = {
    checkedAt,
    windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 20 }],
  };
  const poolWindow: LimitPoolWindow = {
    id: "pooled",
    kind: "session",
    label: "Session",
    members: [],
    columns: [],
    remainingPercent: 90,
    usedPercent: 10,
    pace: null,
    resets: [],
  };
  const quota = {
    key: "quota",
    accountLabel: "Work plan",
    window: { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 },
  } as const;
  const shown = (
    accounts: readonly LimitAccount[],
    ownLimits: ThreadDetailsLimits | null,
    hasQuotas: boolean,
  ) => {
    const usage = resolveThreadUsage(accounts, {
      environmentId,
      instanceId,
      driver: claude,
      ownLimits,
      quotas: hasQuotas ? [quota] : [],
      now,
    });
    return {
      account: usage.account?.key ?? null,
      pool: usage.pool?.map((window) => window.id) ?? null,
      notice: usage.notice !== null,
      windows: usage.windows.map((window) => window.id),
      summary: usage.summaryWindows.map((window) => window.id),
    };
  };

  it.each([
    {
      name: "borrows another account while the instance has no quota rows",
      accounts: [other],
      ownLimits: { kind: "instance", limits: unsupported },
      quotas: false,
      expected: {
        account: other.key,
        pool: null,
        notice: false,
        windows: ["five_hour"],
        summary: ["five_hour"],
      },
    },
    {
      name: "explains an instance with no limits, no quota rows and no account",
      accounts: [],
      ownLimits: { kind: "instance", limits: unsupported },
      quotas: false,
      expected: { account: null, pool: null, notice: true, windows: [], summary: [] },
    },
    {
      name: "shows the instance's own windows beside its quota rows",
      accounts: [other],
      ownLimits: { kind: "instance", limits: ownWindows },
      quotas: true,
      expected: {
        account: null,
        pool: null,
        notice: false,
        windows: ["weekly"],
        summary: ["weekly"],
      },
    },
    {
      name: "shows a hub's pool beside the instance's quota rows",
      accounts: [other],
      ownLimits: { kind: "pool", windows: [poolWindow] },
      quotas: true,
      expected: {
        account: null,
        pool: ["pooled"],
        notice: false,
        windows: [],
        summary: ["pooled"],
      },
    },
    {
      name: "shows quota rows alone when the instance reports nothing",
      accounts: [other],
      ownLimits: null,
      quotas: true,
      expected: { account: null, pool: null, notice: false, windows: [], summary: ["monthly"] },
    },
    {
      name: "keeps the instance's own account beside its quota rows",
      accounts: [other, own],
      ownLimits: { kind: "instance", limits: ownWindows },
      quotas: true,
      expected: {
        account: own.key,
        pool: null,
        notice: false,
        windows: ["five_hour"],
        summary: ["five_hour"],
      },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    accounts: readonly LimitAccount[];
    ownLimits: ThreadDetailsLimits | null;
    quotas: boolean;
    expected: ReturnType<typeof shown>;
  }>)("$name", ({ accounts, ownLimits, quotas, expected }) => {
    expect(shown(accounts, ownLimits, quotas)).toEqual(expected);
  });
});
