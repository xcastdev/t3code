import { IssueSearchEntry } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  composerIssueItems,
  insertComposerIssueReference,
  parseComposerIssueQuery,
} from "./composerIssueItems.ts";

it("keeps existing bare PR search and opts into issue search through filters", () => {
  expect(parseComposerIssueQuery("123")).toBeNull();
  expect(parseComposerIssueQuery("pr:123")).toBeNull();
  expect(parseComposerIssueQuery("issue: crash")).toBe("crash");
  expect(parseComposerIssueQuery("iss:123")).toBe("123");
});

it("inserts the selected typed issue URL without changing surrounding draft text", () => {
  const issue = IssueSearchEntry.make({
    number: 123,
    title: "Fix crash",
    url: "https://github.com/t3tools/t3code/issues/123",
    state: "open",
  });
  expect(composerIssueItems({ entries: [issue] })[0]).toMatchObject({
    type: "issue",
    label: "#123 Fix crash",
  });
  const insertion = insertComposerIssueReference("Fix #iss:123 next", 4, 12, issue);
  expect(insertion.text).toBe(`Fix ${issue.url} next`);
  expect(insertion.cursor).toBe(4 + issue.url.length);
});
