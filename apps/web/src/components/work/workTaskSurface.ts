import {
  projectWorkSelectionIsCurrent,
  type ProjectWorkScope,
  type ProjectWorkSelection,
} from "@t3tools/client-runtime/project-work";
import {
  CommandId,
  type ProjectTeamRecordRead,
  type ProjectWorkTaskContext,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import type { WorkWriter } from "./useWorkWriter";
import type { WorkTaskModel } from "./workModel";

/** Everything a task section needs to read the task and send reviewed changes. */
export interface WorkTaskSurface {
  readonly scope: ProjectWorkScope;
  readonly current: ProjectWorkSelection;
  readonly context: ProjectWorkTaskContext;
  readonly model: WorkTaskModel;
  /** The task's complete team record set at the reviewed revision. */
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly writer: WorkWriter;
  /** Why writes are off right now; null when the reviewed task can be changed. */
  readonly blocked: string | null;
}

export const newCommandId = () => CommandId.make(randomUUID());

/** Guided intents bind to the revision the user reviewed, not the one current at send time. */
export function guidedFields(surface: WorkTaskSurface, selected: ProjectWorkSelection) {
  return {
    commandId: newCommandId(),
    projectId: surface.scope.projectId,
    taskId: surface.context.task.taskId,
    expectedRevision: selected.revision,
    expectedTaskRevision: selected.taskRevision,
  };
}

/** Team intents also name the scope and plan revisions the user was looking at. */
export function teamFields(surface: WorkTaskSurface, selected: ProjectWorkSelection) {
  return {
    ...guidedFields(surface, selected),
    specRevision: surface.context.task.specRevision,
    planRevision: surface.model.plan?.planRevision ?? 0,
  };
}

/**
 * Holds the selection a form was opened against. When the task moves on, the
 * form keeps its text but cannot send until the user reviews the new revision.
 */
export function useWorkReview(current: ProjectWorkSelection, openInitially = false) {
  const [selected, setSelected] = useState<ProjectWorkSelection | null>(
    openInitially ? current : null,
  );
  return {
    selected,
    open: () => setSelected(current),
    close: () => setSelected(null),
    rebase: () => setSelected(current),
    changed: selected !== null && !projectWorkSelectionIsCurrent(selected, current),
  };
}
