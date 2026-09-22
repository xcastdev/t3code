import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import * as CodexErrors from "effect-codex-app-server/errors";
import { describe } from "vite-plus/test";

import { startCodexManagedSkillSession } from "./CodexManagedSkills.ts";
import { openCodexThread } from "./CodexSessionRuntime.ts";

const skillsListResponse: CodexRpc.ClientRequestResponsesByMethod["skills/list"] = {
  data: [
    {
      cwd: "/workspace",
      errors: [],
      skills: [
        {
          name: "deploy",
          description: "Managed deploy",
          enabled: true,
          path: "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md",
          scope: "user",
        },
        {
          name: "deploy",
          description: "Native user deploy",
          enabled: true,
          path: "/home/test/.codex/skills/deploy/SKILL.md",
          scope: "user",
        },
        {
          name: "deploy",
          description: "Native repo deploy",
          enabled: true,
          path: "/workspace/.agents/skills/deploy/SKILL.md",
          scope: "repo",
        },
        {
          name: "review",
          description: "Unrelated native skill",
          enabled: true,
          path: "/home/test/.codex/skills/review/SKILL.md",
          scope: "user",
        },
      ],
    },
  ],
};

const threadStartResponse: CodexRpc.ClientRequestResponsesByMethod["thread/start"] = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  cwd: "/workspace",
  model: "gpt-5.4",
  modelProvider: "openai",
  sandbox: { type: "dangerFullAccess" },
  thread: {
    cliVersion: "0.0.0-test",
    createdAt: 0,
    cwd: "/workspace",
    ephemeral: true,
    id: "provider-thread-1",
    modelProvider: "openai",
    preview: "",
    sessionId: "provider-session-1",
    source: "appServer",
    status: { type: "idle" },
    turns: [],
    updatedAt: 0,
  },
};

const extraRootsSetResponse: CodexRpc.ClientRequestResponsesByMethod["skills/extraRoots/set"] = {};

function responseForMethod<M extends CodexRpc.ClientRequestMethod>(
  method: M,
  listed = skillsListResponse,
): CodexRpc.ClientRequestResponsesByMethod[M] {
  if (method === "skills/list") {
    return listed as CodexRpc.ClientRequestResponsesByMethod[M];
  }
  if (method === "thread/start") {
    return threadStartResponse as CodexRpc.ClientRequestResponsesByMethod[M];
  }
  if (method === "skills/extraRoots/set") {
    return extraRootsSetResponse as CodexRpc.ClientRequestResponsesByMethod[M];
  }
  throw new Error(`Unexpected request method: ${method}`);
}

function makeClient(
  calls: Array<{ readonly method: string; readonly payload: unknown }>,
  options: {
    listed?: typeof skillsListResponse;
    resumeError?: CodexErrors.CodexAppServerError;
  } = {},
) {
  return {
    raw: {
      request: (
        method: "thread/resume",
        payload: CodexRpc.ClientRequestParamsByMethod["thread/resume"],
      ) => {
        calls.push({ method, payload });
        return options.resumeError === undefined
          ? Effect.succeed(threadStartResponse)
          : Effect.fail(options.resumeError);
      },
    },
    request: <M extends CodexRpc.ClientRequestMethod>(
      method: M,
      payload: CodexRpc.ClientRequestParamsByMethod[M],
    ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M]> =>
      Effect.sync(() => {
        calls.push({ method, payload });
        return responseForMethod(method, options.listed);
      }),
  };
}

describe("Codex managed-skill delivery feasibility", () => {
  it.effect(
    "rejects a thread-local managed-path disable even when discovery would report it enabled",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
        const path = "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md";
        const error = yield* startCodexManagedSkillSession({
          client: makeClient(calls),
          cwd: "/workspace",
          extraRoot: "/tmp/t3-runtime/session-1/codex",
          managedSkills: [{ key: "deploy", path }],
          threadStart: {
            cwd: "/workspace",
            config: {
              skills: {
                config: [
                  { path, enabled: true },
                  { path, enabled: false },
                ],
              },
            },
          },
        }).pipe(Effect.flip);
        NodeAssert.equal(error._tag, "CodexAppServerRequestError");
        NodeAssert.deepStrictEqual(calls, []);
      }),
  );

  for (const fallback of [false, true]) {
    it.effect(
      `prepares managed roots and collision rules before ${fallback ? "resume fallback" : "resume"}`,
      () =>
        Effect.gen(function* () {
          const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
          const client = makeClient(
            calls,
            fallback
              ? {
                  resumeError: new CodexErrors.CodexAppServerRequestError({
                    code: -32603,
                    errorMessage: "thread not found",
                  }),
                }
              : {},
          );
          const opened = yield* openCodexThread({
            client,
            managedSkillClient: client,
            threadId: ThreadId.make("managed-resume"),
            runtimeMode: "full-access",
            cwd: "/workspace",
            requestedModel: "gpt-5.4",
            serviceTier: undefined,
            resumeThreadId: "old-thread",
            managedSkills: {
              kind: "codex-managed-skills",
              extraRoot: "/tmp/t3-runtime/session-1/codex",
              skills: [{ key: "deploy", path: "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md" }],
            },
          });
          NodeAssert.equal(opened.thread.id, "provider-thread-1");
          NodeAssert.deepStrictEqual(
            calls.map((call) => call.method),
            [
              "skills/extraRoots/set",
              "skills/list",
              "thread/resume",
              ...(fallback ? ["thread/start"] : []),
            ],
          );
          const resumePayload = calls[2]!
            .payload as CodexRpc.ClientRequestParamsByMethod["thread/resume"];
          NodeAssert.deepStrictEqual(resumePayload.config, {
            skills: {
              config: [
                { path: "/home/test/.codex/skills/deploy/SKILL.md", enabled: false },
                { path: "/workspace/.agents/skills/deploy/SKILL.md", enabled: false },
              ],
            },
          });
          NodeAssert.equal(resumePayload.threadId, "old-thread");
          if (fallback) {
            const started = calls[3]!
              .payload as CodexRpc.ClientRequestParamsByMethod["thread/start"];
            NodeAssert.deepStrictEqual(started.config, resumePayload.config);
            NodeAssert.equal("threadId" in started, false);
          }
        }),
    );
  }

  const entry = skillsListResponse.data[0]!;
  const failedCatalogs: Array<[string, typeof skillsListResponse]> = [
    ["missing managed path", { data: [{ ...entry, skills: entry.skills.slice(1) }] }],
    [
      "disabled managed path",
      {
        data: [
          {
            ...entry,
            skills: entry.skills.map((skill, index) =>
              index === 0 ? { ...skill, enabled: false } : skill,
            ),
          },
        ],
      },
    ],
    ["wrong cwd", { data: [{ ...entry, cwd: "/another-project" }] }],
    ["duplicate cwd", { data: [entry, entry] }],
    [
      "per-cwd errors",
      {
        data: [
          {
            ...entry,
            errors: [{ path: "/workspace/broken/SKILL.md", message: "invalid frontmatter" }],
          },
        ],
      },
    ],
  ];
  for (const [label, listed] of failedCatalogs) {
    for (const resumeThreadId of [undefined, "old-thread"]) {
      it.effect(
        `refuses ${label} before ${resumeThreadId === undefined ? "start" : "resume"}`,
        () =>
          Effect.gen(function* () {
            const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
            const client = makeClient(calls, { listed });
            const error = yield* openCodexThread({
              client,
              managedSkillClient: client,
              threadId: ThreadId.make("managed-invalid"),
              runtimeMode: "full-access",
              cwd: "/workspace",
              requestedModel: undefined,
              serviceTier: undefined,
              resumeThreadId,
              managedSkills: {
                kind: "codex-managed-skills",
                extraRoot: "/tmp/t3-runtime/session-1/codex",
                skills: [
                  { key: "deploy", path: "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md" },
                ],
              },
            }).pipe(Effect.flip);
            NodeAssert.equal(error._tag, "CodexAppServerRequestError");
            NodeAssert.deepStrictEqual(
              calls.map((call) => call.method),
              ["skills/extraRoots/set", "skills/list"],
            );
          }),
      );
    }
  }

  it.effect("uses managed delivery in the real fresh-thread open path", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const opened = yield* openCodexThread({
        client: makeClient(calls),
        threadId: ThreadId.make("thread-managed"),
        runtimeMode: "full-access",
        cwd: "/workspace",
        requestedModel: "gpt-5.4",
        serviceTier: undefined,
        resumeThreadId: undefined,
        managedSkills: {
          kind: "codex-managed-skills",
          extraRoot: "/tmp/t3-runtime/session-1/codex",
          skills: [
            {
              key: "deploy",
              path: "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md",
            },
          ],
        },
        managedSkillClient: makeClient(calls),
      });

      NodeAssert.equal(opened.thread.id, "provider-thread-1");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["skills/extraRoots/set", "skills/list", "thread/start"],
      );
      NodeAssert.equal(
        calls.some((call) => call.method === "skills/config/write"),
        false,
      );
    }),
  );

  it.effect("sets the extra root, reloads skills, and starts with path-local disables", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const client = makeClient(calls);

      yield* startCodexManagedSkillSession({
        client,
        cwd: "/workspace",
        extraRoot: "/tmp/t3-runtime/session-1/codex",
        managedSkills: [
          {
            key: "deploy",
            path: "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md",
          },
        ],
        threadStart: {
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      });

      NodeAssert.deepStrictEqual(calls, [
        {
          method: "skills/extraRoots/set",
          payload: { extraRoots: ["/tmp/t3-runtime/session-1/codex"] },
        },
        {
          method: "skills/list",
          payload: { cwds: ["/workspace"], forceReload: true },
        },
        {
          method: "thread/start",
          payload: {
            cwd: "/workspace",
            model: "gpt-5.4",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            config: {
              skills: {
                config: [
                  {
                    path: "/home/test/.codex/skills/deploy/SKILL.md",
                    enabled: false,
                  },
                  {
                    path: "/workspace/.agents/skills/deploy/SKILL.md",
                    enabled: false,
                  },
                ],
              },
            },
          },
        },
      ]);
      NodeAssert.equal(
        calls.some((call) => call.method === "skills/config/write"),
        false,
      );
    }),
  );

  it.effect("preserves caller skill config and appends authoritative path disables", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const client = makeClient(calls);

      yield* startCodexManagedSkillSession({
        client,
        cwd: "/workspace",
        extraRoot: "/tmp/t3-runtime/session-1/codex",
        managedSkills: [
          {
            key: "deploy",
            path: "/tmp/t3-runtime/session-1/codex/deploy/SKILL.md",
          },
        ],
        threadStart: {
          cwd: "/workspace",
          config: {
            model_context_window: 123_456,
            skills: {
              bundled: { enabled: false },
              include_instructions: false,
              config: [
                { path: "/workspace/existing/SKILL.md", enabled: true },
                { path: "/workspace/.agents/skills/deploy/SKILL.md", enabled: true },
              ],
            },
          },
        },
      });

      NodeAssert.deepStrictEqual(calls.at(-1), {
        method: "thread/start",
        payload: {
          cwd: "/workspace",
          config: {
            model_context_window: 123_456,
            skills: {
              bundled: { enabled: false },
              include_instructions: false,
              config: [
                { path: "/workspace/existing/SKILL.md", enabled: true },
                { path: "/workspace/.agents/skills/deploy/SKILL.md", enabled: true },
                { path: "/home/test/.codex/skills/deploy/SKILL.md", enabled: false },
                { path: "/workspace/.agents/skills/deploy/SKILL.md", enabled: false },
              ],
            },
          },
        },
      });
    }),
  );

  for (const [label, skills] of [
    ["null skills", null],
    ["array skills", []],
    ["string skills", "invalid"],
    ["null skills.config", { config: null }],
    ["object skills.config", { config: {} }],
    ["string skills.config", { config: "invalid" }],
  ] as const) {
    it.effect(`rejects ${label} before sending a provider request`, () =>
      Effect.gen(function* () {
        const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
        const client = makeClient(calls);

        const error = yield* Effect.flip(
          startCodexManagedSkillSession({
            client,
            cwd: "/workspace",
            extraRoot: "/tmp/t3-runtime/session-1/codex",
            managedSkills: [],
            threadStart: { cwd: "/workspace", config: { skills } },
          }),
        );

        NodeAssert.equal(error._tag, "CodexAppServerRequestError");
        NodeAssert.equal(error.code, -32602);
        NodeAssert.deepStrictEqual(calls, []);
      }),
    );
  }
});
