import * as Schema from "effect/Schema";

export class ProjectWorkVerificationError extends Schema.TaggedError<ProjectWorkVerificationError>()(
  "ProjectWorkVerificationError",
  {
    reason: Schema.Literals([
      "storage",
      "invalid-manifest",
      "changed-target",
      "changed-executable",
      "authority",
      "conflict",
      "missing",
      "transaction",
    ]),
  },
) {}
export const verificationError = (reason: ProjectWorkVerificationError["reason"]) =>
  new ProjectWorkVerificationError({ reason });
