import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { formatDayAwareTimestamp, parseTimestampDate } from "../../timestampFormat";
import { SettingsGroup } from "../settings/SettingsGroup";
import { Label } from "../ui/label";

/** A titled Work block: heading row on top, a grouped surface of rows below. */
export function WorkSection({
  title,
  description,
  actions,
  children,
  className,
  grouped = true,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly grouped?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-sm font-medium text-foreground">
            {title}
          </h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {grouped ? <SettingsGroup>{children}</SettingsGroup> : children}
    </section>
  );
}

export function WorkRow({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5 px-3 py-2.5 sm:px-4", className)}
      {...props}
    />
  );
}

export function WorkMeta({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

/** Revisions and hashes are identifiers; tabular mono keeps them comparable at a glance. */
export function WorkRevision({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("font-mono text-xs tabular-nums", className)} {...props} />;
}

export function WorkField({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint ? <WorkMeta>{hint}</WorkMeta> : null}
    </div>
  );
}

export function WorkEmpty({ title, detail }: { readonly title: string; readonly detail?: string }) {
  return (
    <WorkRow className="py-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {detail ? <WorkMeta>{detail}</WorkMeta> : null}
    </WorkRow>
  );
}

/** Inline result line for one form: an error, or why the action is unavailable. */
export function WorkFormStatus({
  message,
  tone = "error",
}: {
  readonly message: string | null;
  readonly tone?: "error" | "muted";
}) {
  if (message === null) return null;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "text-xs",
        tone === "error" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {message}
    </p>
  );
}

export function WorkTime({ value }: { readonly value: string }) {
  const label = parseTimestampDate(value) ? formatDayAwareTimestamp(value, "locale") : value;
  return <time dateTime={value}>{label}</time>;
}
