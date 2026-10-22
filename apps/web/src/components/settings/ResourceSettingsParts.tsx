import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { EnvironmentQueryView } from "../../state/query";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/** Loading, failed or reloading state for one catalog read; nothing while current. */
export function ResourceQueryNotice({
  query,
  subject,
}: {
  query: Pick<EnvironmentQueryView<unknown>, "data" | "error" | "isPending" | "refresh">;
  subject: string;
}) {
  if (query.data === null && query.error === null)
    return (
      <p
        role="status"
        className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground sm:px-4"
      >
        <Spinner className="size-3.5" />
        Loading {subject}…
      </p>
    );
  if (query.error === null) return null;
  return (
    <div className="px-3 py-2 sm:px-4">
      <Alert variant={query.data === null ? "error" : "warning"}>
        <TriangleAlertIcon />
        <AlertTitle>
          {query.data === null ? `Couldn't load ${subject}` : `Showing the last loaded ${subject}`}
        </AlertTitle>
        <AlertDescription>{query.error}</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

export function ResourceFailure({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="text-xs text-destructive-foreground">
      {message}
    </p>
  );
}

export function ResourceHint({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** One catalog entry: identity on the left, state badges and actions on the right. */
export function ResourceRow({
  title,
  meta,
  badges,
  actions,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-slot="settings-row" className="px-3 py-2.5 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
            {title}
            {badges}
          </div>
          {meta ? <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function ResourceEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{children}</p>;
}
