import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  findThreadLimitAccount,
  formatDuration,
  remainingPercent,
  resolveUsageLimitDriver,
} from "@t3tools/shared/usageLimits";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentSettings } from "~/hooks/useSettings";

import { providerClients } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsSection, ThreadDetailsSummary } from "./ThreadDetailsSection";
import { shortPlanLabel } from "./ThreadDetailsUsageSection.logic";

function LimitWindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string;
  readonly now: number;
}) {
  const remaining = remainingPercent(props.window);
  const resetsAt = props.window.resetsAt ? Date.parse(props.window.resetsAt) : Number.NaN;
  const resetsIn = Number.isFinite(resetsAt) ? formatDuration(resetsAt - props.now) : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{props.window.label}</span>
        <span className="ms-auto shrink-0 font-medium text-foreground/85 tabular-nums">
          {remaining}% left
        </span>
        {resetsIn ? (
          <span className="shrink-0 text-muted-foreground tabular-nums">{resetsIn}</span>
        ) : null}
      </div>
      <div
        role="img"
        aria-label={`${props.window.label}: ${remaining}% left${resetsIn ? `, resets in ${resetsIn}` : ""}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: props.color }}
        />
      </div>
    </div>
  );
}

/** Plan limits for every provider account this environment reports, not just the thread's. */
export default function ThreadDetailsUsageSection(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  readonly providerInstanceId: ProviderInstanceId | null;
}) {
  const mapping = useEnvironmentSettings(props.environmentId, (settings) =>
    props.providerInstanceId === null
      ? undefined
      : settings.usageLimitMappings[props.providerInstanceId],
  );
  // The minute tick is a UTC ISO prefix without a zone; parse it as UTC.
  const now = Date.parse(`${useNowMinute()}Z`);
  const accounts = collectLimitAccounts(
    new Map([
      [
        props.environmentId,
        {
          entry: { target: { label: "" } },
          serverConfig: { providers: props.providers, usageLimitSources: props.usageLimitSources },
        },
      ],
    ]),
  ).filter((account) => account.limits.windows.length > 0);
  const threadAccount = findThreadLimitAccount(accounts, {
    environmentId: props.environmentId,
    instanceId: props.providerInstanceId,
    driver: resolveUsageLimitDriver({
      provider: props.providers.find(
        (provider) => provider.instanceId === props.providerInstanceId,
      ),
      mapping,
    }),
  });
  // The tightest window is the one that stops the thread first.
  const tightest = threadAccount?.limits.windows.reduce((lowest, window) =>
    remainingPercent(window) < remainingPercent(lowest) ? window : lowest,
  );
  const tightestResetsAt = tightest?.resetsAt ? Date.parse(tightest.resetsAt) : Number.NaN;
  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage"
      collapsedSummary={
        threadAccount && tightest ? (
          <ThreadDetailsSummary>
            <ProviderInstanceIcon
              driverKind={threadAccount.driver}
              displayName={
                providerClients.get(threadAccount.driver)?.label ?? String(threadAccount.driver)
              }
              className="size-3.5"
              iconClassName="size-3 text-foreground/80"
            />
            <span className="font-medium text-foreground/85">
              {remainingPercent(tightest)}% left
            </span>
            {Number.isFinite(tightestResetsAt) ? (
              <span>{formatDuration(tightestResetsAt - now)}</span>
            ) : null}
          </ThreadDetailsSummary>
        ) : null
      }
    >
      {accounts.length === 0 ? (
        <p className="px-2.5 py-1 text-2xs text-muted-foreground">
          No provider here reports plan limits.
        </p>
      ) : (
        <div className="flex flex-col gap-3 px-2.5 pt-0.5">
          {accounts.map((account) => {
            const driverLabel =
              providerClients.get(account.driver)?.label ?? String(account.driver);
            const plan = account.plan ? shortPlanLabel(account.plan, driverLabel) : null;
            return (
              <div key={account.key} className="flex flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={account.driver}
                    displayName={driverLabel}
                    className="size-4"
                    iconClassName="size-3.5 text-foreground/80"
                  />
                  <span className="min-w-0 truncate text-sm font-medium text-foreground/85">
                    {account.displayName ?? driverLabel}
                  </span>
                  {plan ? (
                    <span className="ms-auto shrink-0 text-2xs text-muted-foreground">{plan}</span>
                  ) : null}
                </div>
                {account.limits.windows.map((window) => (
                  <LimitWindowRow
                    key={window.id}
                    window={window}
                    color={barColor(account.driver)}
                    now={now}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </ThreadDetailsSection>
  );
}
