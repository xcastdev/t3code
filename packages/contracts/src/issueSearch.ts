import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const IssueSearchInput = Schema.Struct({
  projectId: ProjectId,
  query: Schema.String.check(Schema.isMaxLength(120)),
});
export type IssueSearchInput = typeof IssueSearchInput.Type;

export const IssueSearchEntry = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  state: Schema.Literals(["open", "closed"]),
});
export type IssueSearchEntry = typeof IssueSearchEntry.Type;

export const IssueSearchResult = Schema.Struct({
  entries: Schema.Array(IssueSearchEntry).check(Schema.isMaxLength(100)),
});
export type IssueSearchResult = typeof IssueSearchResult.Type;
