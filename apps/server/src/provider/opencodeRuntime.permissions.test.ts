import * as NodeAssert from "node:assert/strict";

import * as RegExpUtils from "effect/RegExp";
import type { QuestionRequest } from "@opencode-ai/sdk/v2";
import { describe, it } from "vite-plus/test";

import {
  buildOpenCodePermissionRules,
  openCodeQuestionId,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
} from "./opencodeRuntime.ts";

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
  target = "*",
) {
  // OpenCode uses the last matching rule. Its wildcards match directory separators.
  return buildOpenCodePermissionRules(runtimeMode).findLast(
    (rule) =>
      (rule.permission === "*" || rule.permission === permission) &&
      new RegExp(`^${RegExpUtils.escape(rule.pattern).replaceAll("\\*", ".*")}$`, "s").test(target),
  )?.action;
}

describe("buildOpenCodePermissionRules", () => {
  it("pre-approves edits once the user has chosen to auto-accept them", () => {
    NodeAssert.equal(actionFor("auto-accept-edits", "edit"), "allow");
  });

  it("still asks before editing when approval is required", () => {
    NodeAssert.equal(actionFor("approval-required", "edit"), "ask");
  });

  // Documented in docs/user/permission-modes.md: providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for "auto".
  it("leaves auto asking, as the docs say it does without a reviewer", () => {
    NodeAssert.equal(actionFor("auto", "edit"), "ask");
  });

  it("allows workspace reads and task updates without asking in supervised modes", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const permission of ["read", "glob", "grep", "lsp", "skill", "todowrite"]) {
        NodeAssert.equal(actionFor(runtimeMode, permission, "src/index.ts"), "allow");
      }
    }
  });

  it("preserves OpenCode's environment-file approval rules", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const target of [
        ".env",
        ".env.local",
        "config/service.env",
        "config/service.env.local",
      ]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "ask");
      }
      for (const target of [".env.example", "config/service.env.example"]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "allow");
      }
    }
  });

  it("still asks before commands, network access, external directories and unknown tools", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "bash"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "webfetch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "websearch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "external_directory"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "doom_loop"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "custom_tool"), "ask");
    }
  });

  it("allows everything only under full access", () => {
    NodeAssert.deepEqual(buildOpenCodePermissionRules("full-access"), [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
  });
});

describe("toOpenCodePermissionReply", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["acceptAlways", "always"],
    ["decline", "reject"],
    ["cancel", "reject"],
  ] as const)("maps %s to %s", (decision, reply) => {
    NodeAssert.equal(toOpenCodePermissionReply(decision), reply);
  });
});

describe("toOpenCodeQuestionAnswers", () => {
  const request: QuestionRequest = {
    id: "question-request",
    sessionID: "session",
    questions: [
      {
        header: "Scope",
        question: "Where should it apply?",
        options: [{ label: "Workspace", description: "Only this workspace." }],
      },
      {
        header: "Reason",
        question: "Why?",
        options: [{ label: "Build", description: "Build task." }],
      },
    ],
  };

  it("preserves empty answers and only turns explicit skip IDs into empty native answers", () => {
    const first = request.questions[0]!;
    const second = request.questions[1]!;
    NodeAssert.deepEqual(
      toOpenCodeQuestionAnswers(request, {
        [openCodeQuestionId(0, first)]: "",
        [openCodeQuestionId(1, second)]: ["Build"],
      }),
      [[""], ["Build"]],
    );
    NodeAssert.deepEqual(
      toOpenCodeQuestionAnswers(request, { Scope: "Workspace" }, [openCodeQuestionId(1, second)]),
      [["Workspace"], []],
    );
  });

  it("rejects absent, unknown, conflicting, and answer-plus-skip values", () => {
    const first = request.questions[0]!;
    const second = request.questions[1]!;
    NodeAssert.throws(() => toOpenCodeQuestionAnswers(request, { Scope: "Workspace" }), /absent/);
    NodeAssert.throws(
      () =>
        toOpenCodeQuestionAnswers(request, { Scope: "Workspace", Other: "x" }, [
          openCodeQuestionId(1, second),
        ]),
      /unknown question/,
    );
    NodeAssert.throws(
      () =>
        toOpenCodeQuestionAnswers(
          request,
          { Scope: "Workspace", [openCodeQuestionId(0, first)]: "Project" },
          [openCodeQuestionId(1, second)],
        ),
      /conflicting answer aliases/,
    );
    NodeAssert.throws(
      () =>
        toOpenCodeQuestionAnswers(
          request,
          { Scope: "Workspace", [openCodeQuestionId(1, second)]: "Build" },
          [openCodeQuestionId(0, first)],
        ),
      /both answered and skipped/,
    );
    NodeAssert.throws(
      () => toOpenCodeQuestionAnswers(request, { Scope: "Workspace" }, ["question-unknown"]),
      /unknown question/,
    );
  });
});
