import { AlertCircleIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export function WorkDataNotice({
  stale,
  waiting,
  offline = false,
  error,
  onRetry,
}: {
  readonly stale: boolean;
  readonly waiting: boolean;
  readonly offline?: boolean;
  readonly error?: string | null;
  readonly onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
        {onRetry ? (
          <Button size="xs" variant="outline" onClick={onRetry}>
            <RefreshCwIcon /> Retry
          </Button>
        ) : null}
      </div>
    );
  }
  if (stale) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
        <CloudOffIcon className="size-3.5" />
        <span>Showing the last saved view. Reconnect to refresh project work.</span>
      </div>
    );
  }
  if (waiting) {
    if (offline) {
      return (
        <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
          <CloudOffIcon className="size-3.5" />
          <span>No cached project work is available while offline.</span>
        </div>
      );
    }
    return <p className="text-sm text-muted-foreground">Loading project work…</p>;
  }
  return null;
}

export function WorkCard({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      className={cn("rounded-xl border border-border/70 bg-card/50 p-4 shadow-sm/5", className)}
    >
      {children}
    </section>
  );
}
