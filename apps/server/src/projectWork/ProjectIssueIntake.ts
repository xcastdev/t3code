import { ProjectId, ProjectIssueIdentity, ProjectIssueIntake } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value.replace("Z", ".000Z")
    );
  }),
);
const Observation = Schema.Struct({
  projectId: ProjectId,
  recordId: Text.check(Schema.isMaxLength(256)),
  repository: Schema.Struct({ host: Text, nodeId: Text, nameWithOwner: Text }),
  issue: Schema.Struct({
    nodeId: Text,
    number: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
    title: ProjectIssueIntake.fields.title,
    body: Schema.String.check(Schema.isMaxLength(32_000)),
    state: Schema.Literals(["open", "closed"]),
    updatedAt: Timestamp,
  }),
  observedAt: Timestamp,
  existing: Schema.optionalKey(ProjectIssueIntake),
});
const decodeObservation = Schema.decodeUnknownOption(Observation);
const decodeIntake = Schema.decodeOption(ProjectIssueIntake);
const isTimestamp = Schema.is(Timestamp);
type Rejection = {
  readonly status: "rejected";
  readonly reason: "invalid-input" | "identity-mismatch" | "detached" | "source-conflict";
};
const reject = (reason: Rejection["reason"]): Rejection => ({ status: "rejected", reason });
const sameIssue = (a: ProjectIssueIdentity, b: ProjectIssueIdentity) =>
  a.host === b.host &&
  a.repositoryNodeId === b.repositoryNodeId &&
  a.issueNodeId === b.issueNodeId &&
  a.number === b.number;

/** Merge only external content; linked T3 work and generation always come from the existing record. */
export const mergeIssueObservation = (
  input: unknown,
):
  | Rejection
  | { readonly status: "changed" | "unchanged"; readonly record: ProjectIssueIntake } => {
  const decoded = decodeObservation(input);
  if (Option.isNone(decoded)) return reject("invalid-input");
  const { existing, repository, issue, observedAt, projectId, recordId } = decoded.value;
  const identity = {
    host: repository.host,
    repositoryNodeId: repository.nodeId,
    issueNodeId: issue.nodeId,
    number: issue.number,
  };
  if (existing !== undefined) {
    if (
      existing.projectId !== projectId ||
      existing.recordId !== recordId ||
      !sameIssue(existing.identity, identity)
    )
      return reject("identity-mismatch");
    if (existing.status === "detached") return reject("detached");
    if (!isTimestamp(existing.sourceRevision) || !isTimestamp(existing.observedAt))
      return reject("invalid-input");
    if (issue.updatedAt < existing.sourceRevision) return { status: "unchanged", record: existing };
    if (issue.updatedAt === existing.sourceRevision) {
      if (
        issue.title !== existing.title ||
        issue.body !== existing.body ||
        issue.state !== existing.status
      )
        return reject("source-conflict");
      if (repository.nameWithOwner === existing.repositoryName || observedAt < existing.observedAt)
        return { status: "unchanged", record: existing };
    }
  }
  if (observedAt < issue.updatedAt || (existing !== undefined && observedAt < existing.observedAt))
    return reject("invalid-input");
  const candidate = decodeIntake({
    ...existing,
    kind: "issue",
    projectId,
    recordId,
    revision: existing === undefined ? 0 : existing.revision + 1,
    generation: existing?.generation ?? 0,
    updatedAt: observedAt,
    observedAt,
    status: issue.state,
    identity,
    repositoryName: repository.nameWithOwner,
    title: issue.title,
    body: issue.body,
    sourceRevision: issue.updatedAt,
  });
  if (Option.isNone(candidate)) return reject("invalid-input");
  return { status: "changed", record: candidate.value };
};
