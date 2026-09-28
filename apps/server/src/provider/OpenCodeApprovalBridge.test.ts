import * as NodeAssert from "node:assert/strict";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeOpenCodeApprovalBridge } from "./OpenCodeApprovalBridge.ts";

const decodeBridgeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      plugin: Schema.Array(Schema.String),
    }),
  ),
);

it.layer(NodeServices.layer)("OpenCode approval bridge", (it) => {
  it.effect("adds bounded child approval choices to only their parent prompt", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bridge = yield* makeOpenCodeApprovalBridge(
        '{"model":"anthropic/claude-sonnet-5","plugin":["existing-plugin"]}',
        fs,
        path,
      );
      const config = decodeBridgeConfig(bridge.configContent);
      NodeAssert.equal(config.model, "anthropic/claude-sonnet-5");
      NodeAssert.deepEqual(config.plugin, ["existing-plugin", bridge.pluginPath]);

      const plugin = (yield* Effect.promise(
        () => import(NodeURL.pathToFileURL(bridge.pluginPath).href),
      )) as {
        T3CodeApprovalBridge: () => Promise<{
          "experimental.chat.system.transform": (
            input: { readonly sessionID: string },
            output: { system: Array<string> },
          ) => Promise<void>;
        }>;
      };
      const hooks = yield* Effect.promise(() => plugin.T3CodeApprovalBridge());
      const beforeDecision = { system: ["base parent instructions"] };
      yield* Effect.promise(() =>
        hooks["experimental.chat.system.transform"]({ sessionID: "ses_parent" }, beforeDecision),
      );
      NodeAssert.deepEqual(beforeDecision.system, ["base parent instructions"]);

      yield* bridge.record({
        parentSessionId: "ses_parent",
        childSessionId: "ses_child",
        requestId: "request-collision",
        requestType: "bash",
        decision: "approvedOnce",
      });
      yield* bridge.record({
        parentSessionId: "ses_parent",
        childSessionId: "ses_second_child",
        requestId: "request-collision",
        requestType: "edit",
        decision: "denied",
      });
      yield* bridge.record({
        parentSessionId: "ses_sibling_parent",
        childSessionId: "ses_sibling_child",
        requestId: "request-sibling",
        requestType: "bash",
        decision: "approvedForSession",
      });

      const output = { system: ["base parent instructions"] };
      yield* Effect.promise(() =>
        hooks["experimental.chat.system.transform"]({ sessionID: "ses_parent" }, output),
      );
      const parentPromptFacts = output.system.join("\n");
      NodeAssert.match(parentPromptFacts, /user chose to allow.*once/i);
      NodeAssert.match(parentPromptFacts, /user chose to deny/i);
      NodeAssert.equal((parentPromptFacts.match(/request-collision/g) ?? []).length, 2);
      NodeAssert.match(
        parentPromptFacts,
        /does not establish that the operation ran or succeeded/i,
      );

      const unrelated = { system: ["sibling parent instructions"] };
      yield* Effect.promise(() =>
        hooks["experimental.chat.system.transform"]({ sessionID: "ses_sibling_parent" }, unrelated),
      );
      NodeAssert.match(unrelated.system.join("\n"), /request-sibling/);
      NodeAssert.doesNotMatch(unrelated.system.join("\n"), /request-collision/);
    }).pipe(Effect.scoped),
  );
});
