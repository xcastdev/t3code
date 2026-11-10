import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { discoverOmp, projectOmpDiscovery } from "./status.ts";
it.effect(
  "discovers native model and thinking defaults without prompting and refuses missing capabilities",
  () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const rpc = {
        request: (r: { type: string }) => {
          seen.push(r.type);
          return Effect.succeed(
            (
              {
                get_available_models: {
                  models: [
                    { id: "m", provider: "p", name: "Model", contextWindow: 32000 },
                    {
                      id: "other",
                      provider: "p",
                      reasoning: true,
                      thinking: { efforts: ["low", "high", "max"] },
                    },
                    {
                      id: "plain",
                      provider: "p",
                      contextWindow: null,
                      reasoning: false,
                      thinking: { efforts: ["high"] },
                    },
                  ],
                },
                get_available_thinking_levels: { levels: ["off", "high"] },
                get_available_commands: { commands: [{ name: "compact", source: "builtin" }] },
                get_state: {
                  model: { id: "m", provider: "p" },
                  thinkingLevel: "high",
                  sessionId: "s",
                  isSettled: true,
                },
              } as Record<string, unknown>
            )[r.type],
          );
        },
      };
      const result = yield* discoverOmp(rpc);
      expect(result.models[0]?.id).toBe("p/m");
      expect(result.models[2]?.contextWindow).toBeNull();
      expect(result.thinking).toEqual(["off", "high"]);
      expect(result.defaultThinking).toBe("high");
      const projected = projectOmpDiscovery(result);
      expect(projected.models[1]?.capabilities).toMatchObject({
        optionDescriptors: [
          {
            id: "thinking",
            options: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
          },
        ],
      });
      expect(projected.models[2]?.capabilities).toMatchObject({
        optionDescriptors: [{ id: "thinking", options: [{ id: "off" }] }],
      });
      expect(seen).not.toContain("prompt");
      const failure = yield* discoverOmp({ request: () => Effect.succeed({}) }).pipe(Effect.flip);
      expect(failure.operation).toBe("discovery");
    }),
);

it.effect(
  "projects native picker choices/defaults and workspace skills, and restores inherited model/thinking after overrides",
  () =>
    Effect.gen(function* () {
      const { projectOmpDiscovery, applyOmpSelection } = yield* Effect.promise(
        () => import("./status.ts"),
      );
      const calls: Record<string, unknown>[] = [];
      const rpc = {
        request: (r: { type: string; [key: string]: unknown }) => {
          calls.push(r);
          return Effect.succeed(
            r.type === "get_available_thinking_levels" ? { levels: ["off", "high"] } : {},
          );
        },
      };
      const discovery = {
        models: [
          { id: "p/base", nativeId: "base", provider: "p", name: "Base" },
          { id: "p/other", nativeId: "other", provider: "p", name: "Other" },
        ],
        thinking: ["off", "high"],
        defaultThinking: "high",
        defaultModel: "p/base",
        commands: [
          { name: "skill:deploy", source: "skill", description: "Deploy" },
          { name: "compact", source: "builtin" },
        ],
        nativeCommands: [],
        state: { sessionId: "s", isSettled: true },
      };
      const projected = projectOmpDiscovery(discovery);
      expect(projected.models[0]).toMatchObject({
        slug: "p/base",
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              currentValue: "high",
              options: [{ id: "off" }, { id: "high", isDefault: true }],
            },
          ],
        },
      });
      expect(projected.skills).toMatchObject([{ name: "deploy", enabled: true }]);
      yield* applyOmpSelection(
        rpc,
        { model: "p/other", options: [{ id: "thinking", value: "off" }] },
        discovery,
      );
      yield* applyOmpSelection(rpc, { model: "default" }, discovery);
      expect(calls.filter((c) => c.type === "set_model")).toEqual([
        { type: "set_model", provider: "p", modelId: "other" },
        { type: "set_model", provider: "p", modelId: "base" },
      ]);
      expect(calls.at(-1)).toEqual({ type: "set_thinking_level", level: "high" });
      expect(
        (yield* applyOmpSelection(
          rpc,
          { model: "p/other", options: [{ id: "thinking", value: "max" }] },
          discovery,
        ).pipe(Effect.flip)).operation,
      ).toBe("selection");
    }),
);
