import type { IssueSearchEntry, IssueSearchResult } from "@t3tools/contracts";
import { replaceTextRange } from "@t3tools/shared/composerTrigger";

/** Existing bare # searches remain PR searches; issue search is an explicit filter. */
export function parseComposerIssueQuery(query: string): string | null {
  const match = /^(?:issue|iss):\s*(.*)$/i.exec(query);
  return match ? (match[1] ?? "") : null;
}

export function composerIssueItems(result: IssueSearchResult) {
  return result.entries.slice(0, 100).map((issue) => ({
    id: `issue:${issue.url}`,
    type: "issue" as const,
    label: `#${issue.number} ${issue.title}`,
    issue,
  }));
}

export function insertComposerIssueReference(
  draft: string,
  rangeStart: number,
  rangeEnd: number,
  issue: IssueSearchEntry,
): { text: string; cursor: number } {
  return replaceTextRange(draft, rangeStart, rangeEnd, issue.url);
}
