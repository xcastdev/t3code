import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  type LimitAccount,
  type LimitPace,
  type LimitPoolWindow,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  resolveUsageLimitDriver,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";

import { shortPlanLabel, usageSummaryWindows } from "@t3tools/client-runtime/state/thread-details";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { type ReactNode, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironmentSettings, usePrimarySettings } from "~/hooks/useSettings";
import { formatUpcomingTimestamp } from "~/timestampFormat";

import { providerClients } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsRing } from "./ThreadDetailsRing";
import { ThreadDetailsSection, ThreadDetailsSummary } from "./ThreadDetailsSection";
import {
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
  resolveThreadUsage,
} from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

/** One window as room left over a bar; the tick marks even pace, and the row opens the usage page. */
function UsageBarRow(props: {
  readonly label: string;
  readonly left: number;
  readonly color: string;
  readonly resetsIn: string | null;
  /** Time left in the window, where the bar would sit at an even pace. */
  readonly tick?: number | null;
  readonly tooltip: ReactNode;
}) {
  const gt = useGT();
  const tick = props.tick ?? null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/usage"
            aria-label={
              props.resetsIn
                ? gt("{label}: {left}% left, resets in {resetsIn}", {
                    label: props.label,
                    left: props.left,
                    resetsIn: props.resetsIn,
                  })
                : gt("{label}: {left}% left", { label: props.label, left: props.left })
            }
            className="group -mx-1.5 flex flex-col gap-1 rounded-md px-1.5 py-0.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="flex items-center gap-2 text-xs">
          <span className="min-w-0 truncate text-muted-foreground group-hover:text-foreground">
            {props.label}
          </span>
          <span className="ms-auto shrink-0 font-medium text-foreground/85 tabular-nums">
            <T>
              <Var>{props.left}</Var>% left
            </T>
          </span>
          {props.resetsIn ? (
            <span className="shrink-0 text-muted-foreground tabular-nums">{props.resetsIn}</span>
          ) : null}
        </span>
        <span aria-hidden className="relative block h-1.5 rounded-full bg-muted">
          <span
            className="block h-full rounded-full"
            style={{ width: `${props.left}%`, backgroundColor: props.color }}
          />
          {tick !== null ? (
            <span
              className="absolute -top-[2px] h-[10px] w-px -translate-x-1/2 bg-foreground/75"
              style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          {props.tooltip}
          <span className="text-muted-foreground">{gt("Open usage")}</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function LimitWindowRow(props: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string;
  readonly now: number;
  readonly accountLabel?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { window } = props;
  const left = remainingPercent(window);
  const pace = paceOf(window, props.now);
  const timeLeft = paceRemainingPercent(window, props.now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const resetsIn =
    window.resetsAt && resetsAt > props.now ? formatDuration(resetsAt - props.now, m) : null;
  return (
    <UsageBarRow
      label={window.label}
      left={left}
      color={props.color}
      resetsIn={resetsIn}
      tick={timeLeft}
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {props.accountLabel ? (
            <span className="text-muted-foreground">{props.accountLabel}</span>
          ) : null}
          {pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && resetsIn ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: resetsIn,
                time: formatUpcomingTimestamp(
                  window.resetsAt,
                  timestampFormat,
                  props.now,
                  undefined,
                  m,
                ),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** A hub's pooled window: the accounts it routes this thread's model to, read as one. */
function PoolWindowRow(props: {
  readonly window: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { window } = props;
  const left = window.remainingPercent;
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, props.now);
  const resetsAt = next?.member.window.resetsAt;
  const reset =
    next && resetsAt
      ? {
          duration: formatDuration(next.at - props.now, m),
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, props.now, undefined, m),
        }
      : null;
  return (
    <UsageBarRow
      label={window.label}
      left={left}
      color={props.color}
      resetsIn={reset?.duration ?? null}
      tooltip={
        <>
          <span className="text-foreground">
            {accounts > 1
              ? gt("{label}: {left}% left across {accounts} accounts", {
                  label: window.label,
                  left,
                  accounts,
                })
              : gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {window.pace ? (
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {next && reset ? (
            <span className="text-muted-foreground">
              {accounts > 1
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

function AccountHeader(props: {
  readonly driver: ServerProvider["driver"];
  readonly name: string | null;
  readonly plan: string | undefined;
}) {
  const driverLabel = providerClients.get(props.driver)?.label ?? String(props.driver);
  const plan = props.plan ? shortPlanLabel(props.plan, driverLabel) : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProviderInstanceIcon
        driverKind={props.driver}
        displayName={driverLabel}
        className="size-4"
        iconClassName="size-3.5 text-foreground/80"
      />
      <span className="min-w-0 truncate text-sm font-medium text-foreground/85">
        {props.name ?? driverLabel}
      </span>
      {plan ? (
        <span className="ms-auto shrink-0 text-2xs text-muted-foreground">{plan}</span>
      ) : null}
    </div>
  );
}

function AccountLimits(props: { readonly account: LimitAccount; readonly now: number }) {
  const { account } = props;
  return (
    <div className="flex flex-col gap-1.5">
      <AccountHeader driver={account.driver} name={account.displayName} plan={account.plan} />
      {account.limits.windows.map((window) => (
        <LimitWindowRow
          key={window.id}
          window={window}
          color={barColor(account.driver)}
          now={props.now}
        />
      ))}
    </div>
  );
}

/** The thread provider's plan limits first; the environment's other accounts behind a toggle. */
export default function ThreadDetailsUsageSection(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: readonly ServerProvider[];
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  readonly providerInstanceId: ProviderInstanceId | null;
  /** The thread's model: a hub routes accounts, and Antigravity reads limits, per model. */
  readonly model: string | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const mapping = useEnvironmentSettings(props.environmentId, (settings) =>
    props.providerInstanceId === null
      ? undefined
      : settings.usageLimitMappings[props.providerInstanceId],
  );
  const [showAll, setShowAll] = useState(false);
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
  const provider = props.providers.find((entry) => entry.instanceId === props.providerInstanceId);
  const resolved = resolveThreadDetailsLimits(
    props.providerInstanceId,
    props.model,
    props.providers,
    props.usageLimitSources,
    now,
  );
  const quotas = resolveThreadHttpQuotas(props.providerInstanceId, props.usageLimitSources);
  const usage = resolveThreadUsage(accounts, {
    environmentId: props.environmentId,
    instanceId: props.providerInstanceId,
    driver: resolveUsageLimitDriver({ provider, mapping }),
    ownLimits: resolved,
    quotas,
    now,
  });
  const threadAccount = usage.account;
  const pool = usage.pool;
  const ownNotice = usage.notice === null ? null : limitsNotice(usage.notice, m);
  const threadDriver = threadAccount?.driver ?? provider?.driver ?? null;
  const showsThread = usage.shown;
  const summaryWindows = usageSummaryWindows(usage.summaryWindows);
  const others = showsThread
    ? accounts.filter((account) => account.key !== threadAccount?.key)
    : [];
  const threadDriverLabel =
    threadDriver === null
      ? null
      : (providerClients.get(threadDriver)?.label ?? String(threadDriver));
  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage", { $context: "thread details section: plan usage limits" })}
      collapsedSummary={
        threadDriver && threadDriverLabel && summaryWindows.length > 0 ? (
          <ThreadDetailsSummary>
            <ProviderInstanceIcon
              driverKind={threadDriver}
              displayName={threadDriverLabel}
              className="size-3.5"
              iconClassName="size-3 text-foreground/80"
            />
            {summaryWindows.map((window) => {
              const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
              return (
                <span key={window.id} className="flex shrink-0 items-center gap-1">
                  <ThreadDetailsRing
                    percent={remainingPercent(window)}
                    color={barColor(threadDriver)}
                    label={gt("{provider} {window}: {left}% left", {
                      provider: threadDriverLabel,
                      window: window.label,
                      left: remainingPercent(window),
                    })}
                  />
                  {Number.isFinite(resetsAt) ? (
                    <span>{formatDuration(resetsAt - now, m)}</span>
                  ) : null}
                </span>
              );
            })}
          </ThreadDetailsSummary>
        ) : null
      }
    >
      {!showsThread && accounts.length === 0 ? (
        <p className="px-2.5 py-1 text-2xs text-muted-foreground">
          <T>No provider here reports plan limits.</T>
        </p>
      ) : (
        <div className="flex flex-col gap-3 px-2.5 pt-0.5">
          {showsThread && threadDriver !== null ? (
            <div className="flex flex-col gap-1.5">
              <AccountHeader
                driver={threadDriver}
                name={threadAccount?.displayName ?? provider?.displayName ?? null}
                plan={threadAccount?.plan}
              />
              {pool !== null ? (
                pool.map((window) => (
                  <PoolWindowRow
                    key={window.id}
                    window={window}
                    color={barColor(threadDriver)}
                    now={now}
                  />
                ))
              ) : ownNotice !== null ? (
                <Link
                  to="/usage"
                  className="rounded-md text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {ownNotice}
                </Link>
              ) : (
                usage.windows.map((window) => (
                  <LimitWindowRow
                    key={window.id}
                    window={window}
                    color={barColor(threadDriver)}
                    now={now}
                  />
                ))
              )}
              {quotas.map(({ key, accountLabel, window }) => (
                <LimitWindowRow
                  key={key}
                  window={window}
                  accountLabel={accountLabel}
                  color={barColor(threadDriver)}
                  now={now}
                />
              ))}
            </div>
          ) : null}
          {(showsThread ? (showAll ? others : []) : accounts).map((account) => (
            <AccountLimits key={account.key} account={account} now={now} />
          ))}
          {showsThread && others.length > 0 ? (
            <ThreadDetailsControl
              part="meta"
              className="self-start"
              aria-expanded={showAll}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? (
                <T>Show less</T>
              ) : (
                <T>
                  Show <Var>{others.length}</Var> more
                </T>
              )}
            </ThreadDetailsControl>
          ) : null}
        </div>
      )}
    </ThreadDetailsSection>
  );
}
