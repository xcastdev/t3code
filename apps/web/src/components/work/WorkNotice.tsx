import { CloudOffIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { WorkReadView } from "./useWorkRead";
import type { WorkPageView, WorkRecordsView } from "./useWorkRecords";
import { WorkMeta, WorkRow } from "./WorkLayout";

function RetryAction({ onRetry }: { onRetry: () => void }) {
  return (
    <AlertAction>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </AlertAction>
  );
}

/** Truthful read state for one Work view: loading, error, disconnected or stale. */
export function WorkNotice({ view, subject }: { view: WorkReadView; subject: string }) {
  const hasValue = view.value !== null;
  if (view.status === "loading" && !hasValue)
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        Loading {subject}…
      </p>
    );
  if (view.status === "disconnected")
    return (
      <Alert variant="warning" role="status">
        <CloudOffIcon />
        <AlertTitle>Disconnected</AlertTitle>
        <AlertDescription>
          {hasValue
            ? `Showing the last loaded ${subject}. Changes are off until this environment reconnects.`
            : `Reconnect this environment to load ${subject}.`}
        </AlertDescription>
      </Alert>
    );
  if (view.error !== null && !hasValue)
    return (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertTitle>Couldn't load {subject}</AlertTitle>
        <AlertDescription>{view.error}</AlertDescription>
        <RetryAction onRetry={view.retry} />
      </Alert>
    );
  if (view.status === "stale")
    return (
      <Alert variant="info" role="status">
        <InfoIcon />
        <AlertDescription>
          {view.error ??
            `${view.label ?? "Work may be stale"}. Showing the last loaded ${subject}.`}
        </AlertDescription>
        {view.error !== null ? <RetryAction onRetry={view.retry} /> : null}
      </Alert>
    );
  return null;
}

/** State of a complete record set: loading, failed, truncated, disconnected or catching up. */
export function WorkRecordsNotice({ set, subject }: { set: WorkRecordsView; subject: string }) {
  if (set.status === "disconnected")
    return (
      <Alert variant="warning" role="status">
        <CloudOffIcon />
        <AlertDescription>
          {set.complete
            ? `Showing the last loaded ${subject}. Changes are off until this environment reconnects.`
            : `Reconnect this environment to load ${subject}.`}
        </AlertDescription>
      </Alert>
    );
  if (set.truncated)
    return (
      <Alert variant="warning" role="status">
        <TriangleAlertIcon />
        <AlertDescription>
          There are more {subject} than Work can check at once. Nothing is inferred from a partial
          list, so changes that depend on them stay off.
        </AlertDescription>
      </Alert>
    );
  if (set.failed)
    return (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertDescription>
          Couldn't load all {subject}.{" "}
          {set.complete ? "Showing the last complete set." : "Changes that depend on them are off."}
        </AlertDescription>
        <RetryAction onRetry={set.retry} />
      </Alert>
    );
  if (!set.complete)
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-3.5" />
        Loading {subject}…
      </p>
    );
  if (set.status !== "ready")
    return (
      <Alert variant="info" role="status">
        <InfoIcon />
        <AlertDescription>Checking for newer {subject}.</AlertDescription>
      </Alert>
    );
  return null;
}

/** Position and Next/Previous for one bounded window of a collection. */
export function WorkPager({
  pager,
  noun,
}: {
  pager: Pick<WorkPageView, "window" | "next" | "previous">;
  noun: string;
}) {
  const { window } = pager;
  if (window.previousOffset === null && window.nextOffset === null) return null;
  return (
    <WorkRow className="flex-row items-center justify-between gap-2 py-2">
      <WorkMeta className="tabular-nums">
        {window.to < window.from ? `No more ${noun}` : `${noun} ${window.from}–${window.to}`}
      </WorkMeta>
      <div className="flex gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={window.previousOffset === null}
          onClick={pager.previous}
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={window.nextOffset === null}
          onClick={pager.next}
        >
          Next
        </Button>
      </div>
    </WorkRow>
  );
}

/** A form opened against an older revision keeps its text until the user reviews again. */
export function WorkReviewChanged({ onReview }: { onReview: () => void }) {
  return (
    <Alert variant="warning" role="status">
      <InfoIcon />
      <AlertDescription>
        This changed while you were reviewing it. Your input is kept; check the current revision
        before sending.
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={onReview}>
          Review current revision
        </Button>
      </AlertAction>
    </Alert>
  );
}
