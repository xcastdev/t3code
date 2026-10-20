import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { formatDayAwareTimestamp, parseTimestampDate } from "../../timestampFormat";

/** Native selects stay native so keyboard, screen readers and form tests keep working. */
export const workSelectClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm text-foreground shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 dark:bg-input/32";

/** One header row per Work section: title and status on the left, actions on the right. */
export function WorkSectionHeader({
  title,
  status,
  description,
  actions,
  level = 2,
}: {
  readonly title: ReactNode;
  readonly status?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <Heading
          className={cn(
            "break-words font-semibold",
            level === 2 ? "text-lg tracking-tight" : "text-sm",
          )}
        >
          {title}
        </Heading>
        {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Small uppercase label that groups content inside a card. */
export function WorkLabel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <h4 className={cn("text-xs font-medium text-muted-foreground uppercase", className)}>
      {children}
    </h4>
  );
}

/**
 * Progressive disclosure for identifiers, revisions and other record metadata.
 * Native details keeps content in the DOM, so text search and assistive tech still reach it.
 */
export function WorkDetails({
  summary = "Record details",
  children,
  className,
  open,
}: {
  readonly summary?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly open?: boolean;
}) {
  return (
    <details className={cn("group/details text-xs text-muted-foreground", className)} open={open}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 group-open/details:rotate-90" aria-hidden />
        {summary}
      </summary>
      <div className="mt-1.5 space-y-1 break-all pl-4.5">{children}</div>
    </details>
  );
}

/** Disclosure for an optional or advanced form inside a card. */
export function WorkDisclosure({
  summary,
  hint,
  children,
  className,
}: {
  readonly summary: ReactNode;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <details
      className={cn(
        "group/disclosure rounded-lg border border-border/60 bg-background/40",
        className,
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium select-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground group-open/disclosure:rotate-90"
          aria-hidden
        />
        <span className="min-w-0 flex-1">{summary}</span>
        {hint ? (
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">{hint}</span>
        ) : null}
      </summary>
      <div className="space-y-3 border-t border-border/60 px-3 pt-3 pb-3">{children}</div>
    </details>
  );
}

/** Readable local time; the exact recorded value stays available on hover and to assistive tech. */
export function WorkTime({ value }: { readonly value: string }) {
  const label = parseTimestampDate(value) ? formatDayAwareTimestamp(value, "locale") : value;
  return (
    <time dateTime={value} title={value}>
      {label}
    </time>
  );
}

/** Compact counts that skip zeros; the total is always shown so an empty set reads honestly. */
export function WorkCounts({
  counts,
  total,
  label,
}: {
  readonly counts: ReadonlyArray<readonly [string, number]>;
  readonly total: number;
  readonly label: string;
}) {
  const shown = counts.filter(([, count]) => count > 0);
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5 text-xs">
      <li className="rounded-md border border-border/70 px-1.5 py-0.5 font-medium tabular-nums">
        {total} total
      </li>
      {shown.map(([name, count]) => (
        <li
          key={name}
          className="rounded-md bg-muted/60 px-1.5 py-0.5 text-muted-foreground tabular-nums"
        >
          {count} {name}
        </li>
      ))}
    </ul>
  );
}

export function workStateLabel(state: string): string {
  const label = state.replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
