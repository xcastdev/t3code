import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { LinkedTaskProvenance, TaskStage, TaskStageId } from "./taskStages";

/** Recorded task progress with the next step spelled out; each stage jumps to its section. */
export function TaskStageRail({
  stages,
  next,
  onSelect,
}: {
  readonly stages: ReadonlyArray<TaskStage>;
  readonly next: string;
  readonly onSelect: (stage: TaskStageId) => void;
}) {
  return (
    <div className="space-y-2">
      <ol aria-label="Task workflow" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {stages.map((stage, index) => (
          <li key={stage.id} aria-current={stage.status === "current" ? "step" : undefined}>
            <button
              type="button"
              className={cn(
                "flex h-full w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                stage.status === "current"
                  ? "border-primary/50 bg-primary/6"
                  : "border-border/60 bg-background/40",
              )}
              onClick={() => onSelect(stage.id)}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums",
                  stage.status === "done"
                    ? "border-success/40 bg-success/12 text-success-foreground"
                    : stage.status === "current"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground",
                )}
              >
                {stage.status === "done" ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{stage.label}</span>
                <span className="block text-xs text-muted-foreground">{stage.detail}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="text-sm">
        <span className="font-medium">Next step: </span>
        <span className="text-muted-foreground">{next}</span>
      </p>
    </div>
  );
}

/** Replaces the stage rail for linked child tasks with their recorded parent and gate. */
export function LinkedTaskSummary({ provenance }: { readonly provenance: LinkedTaskProvenance }) {
  const kind = provenance.kind
    ? `${provenance.kind.charAt(0).toUpperCase()}${provenance.kind.slice(1)}`
    : "Linked";
  return (
    <div
      role="group"
      aria-label="Linked assignment"
      className="space-y-1 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm"
    >
      <p className="font-medium">{kind} assignment</p>
      <p className="break-all text-muted-foreground">
        Linked to parent task {provenance.parentTaskId}.{" "}
        {provenance.gateId === undefined
          ? "No assignment gate is recorded for this task."
          : provenance.gateStatus === undefined
            ? `Gate ${provenance.gateId} is not recorded for this task and parent.`
            : `Recorded ${provenance.gateKind} gate ${provenance.gateId}: ${provenance.gateStatus}.`}
      </p>
    </div>
  );
}
