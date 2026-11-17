import type { ProjectWorkScope, ProjectWorkSelection } from "@t3tools/client-runtime/project-work";
import type {
  ProjectTeamRecordRead,
  ProjectWorkTaskContext,
  ProjectWorkTaskId,
} from "@t3tools/contracts";

import type { WorkWriter } from "./useWork";
import type { WorkTaskModel } from "./workModel";

export interface Surface {
  readonly scope: ProjectWorkScope;
  readonly current: ProjectWorkSelection;
  readonly context: ProjectWorkTaskContext;
  readonly model: WorkTaskModel;
  /** The task's complete team record set at the reviewed revision. */
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly writer: WorkWriter;
  readonly blocked: string | null;
  readonly onOpenTask: (taskId: ProjectWorkTaskId) => void;
}
