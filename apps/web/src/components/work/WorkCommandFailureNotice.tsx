import { Button } from "../ui/button";
import { WorkDataNotice } from "./WorkDataNotice";
import type { ProjectWorkCommandFailure } from "./workCommandFailure";

export function WorkCommandFailureNotice({
  failure,
  onRetry,
  onRebase,
  onDiscard,
}: {
  readonly failure: ProjectWorkCommandFailure;
  readonly onRetry: () => void;
  readonly onRebase: () => void;
  readonly onDiscard: () => void;
}) {
  const detail = failure.staleRevision
    ? [
        failure.currentRevision === null ? null : `Current revision ${failure.currentRevision}.`,
        failure.changedFields.length === 0 ? null : `Changed: ${failure.changedFields.join(", ")}.`,
      ]
        .filter(Boolean)
        .join(" ")
    : "The result is uncertain. Retry sends the exact same command and idempotency key.";
  return (
    <div>
      <WorkDataNotice
        stale={false}
        waiting={false}
        error={`${failure.message}${detail ? ` ${detail}` : ""}`}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {failure.staleRevision ? (
          <Button size="sm" variant="outline" onClick={onRebase}>
            Rebase on latest
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry exact command
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}
