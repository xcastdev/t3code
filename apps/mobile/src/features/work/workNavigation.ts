import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

export const WORK_PATHS = {
  projects: "work",
  project: "work/:environmentId/:projectId",
  task: "work/:environmentId/:projectId/tasks/:taskId",
} as const;
const decode = Schema.decodeUnknownOption(
  Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId }),
);
export function decodeWorkRoute(params: {
  readonly environmentId?: string;
  readonly projectId?: string;
}) {
  return Option.getOrNull(decode(params));
}
