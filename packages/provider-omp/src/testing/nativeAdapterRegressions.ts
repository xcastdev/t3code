// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { constrainNativeSettings, importNative } from "../server/runtimeLauncher.ts";
import { registerApprovalUI } from "../server/runtimePolicyHooks.ts";

export async function proveAdapterRegressions(root: string) {
  const { Settings } = await importNative(root, "config/settings");
  const { ExtensionToolWrapper, RegisteredToolAdapter } = await importNative(
    root,
    "extensibility/extensions/wrapper",
  );
  const { CustomToolAdapter } = await importNative(root, "extensibility/custom-tools/wrapper");
  const { HookToolWrapper } = await importNative(root, "extensibility/hooks/tool-wrapper");
  const { wrapToolWithMetaNotice } = await importNative(root, "tools/output-meta");
  const { customToolToDefinition } = await importNative(root, "sdk");
  const failures: string[] = [];
  let cases = 0;
  for (const route of [
    "registered",
    "meta-registered",
    "sdk-custom",
    "custom-adapter",
    "hook-registered",
  ]) {
    for (const timing of ["pending", "no-prompt"]) {
      for (const variant of [
        "unchanged-static",
        "unchanged-callable",
        "executor-replacement",
        "callable-replacement",
        "closure-change",
        "late-executor",
        "late-context",
        "owned-input",
        "definition-receiver",
        "meta-target-replacement",
      ]) {
        if (
          (route === "registered" || route === "custom-adapter") &&
          variant === "meta-target-replacement"
        )
          continue;

        const authority = Settings.isolated({ "tools.approval": { blocked: "deny" } });
        const boundary = await constrainNativeSettings(
          root,
          authority,
          timing === "pending" ? "approval-required" : "full-access",
          {
            providerSession: "adapter",
            environment: "e",
            project: "p",
            session: "s",
            cwd: process.cwd(),
            agentDir: authority.getAgentDir(),
            generation: ++cases,
          },
        );
        boundary.epoch.open();
        let original = 0,
          replacement = 0,
          changed = false,
          prompts = 0;
        const input = { nested: { value: "approved" }, unknown: { extra: [1, 2] } };
        const toolContext = {
          settings: boundary.settings,
          toolCall: {
            index: 0,
            toolCalls: [],
            providerMetadata: { type: "proof", nested: { value: "approved" } },
          },
        };
        const opened = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<"once">();
        const target = {
          name: "adapterProof",
          label: "proof",
          description: "proof",
          parameters: { type: "object" },
          marker: "receiver",
          approval:
            variant === "unchanged-callable" ||
            variant === "callable-replacement" ||
            variant === "closure-change" ||
            variant === "owned-input"
              ? function (this: { marker: string }, args?: typeof input) {
                  NodeAssert.equal(this.marker, "receiver");
                  NodeAssert.equal(this, target);
                  return {
                    tier: "exec",
                    policyKey:
                      changed || (variant === "owned-input" && args?.nested.value !== "approved")
                        ? "blocked"
                        : "initial",
                  };
                }
              : "exec",
          execute: async function (this: { marker: string }, _id: string, params: typeof input) {
            NodeAssert.equal(this.marker, "receiver");
            NodeAssert.equal(this, target);
            NodeAssert.deepEqual(params, {
              nested: { value: "approved" },
              unknown: { extra: [1, 2] },
            });
            NodeAssert.notEqual(params, input);
            NodeAssert.notEqual(params.nested, input.nested);
            original++;
            return { content: [], details: {} };
          },
        };
        if (variant === "unchanged-callable")
          Object.assign(target, {
            approvalCacheTargets: function (this: { marker: string }) {
              NodeAssert.equal(this.marker, "receiver");
              NodeAssert.equal(this, target);
              return [];
            },
            approvalRestrictionPaths: function (this: { marker: string }) {
              NodeAssert.equal(this.marker, "receiver");
              NodeAssert.equal(this, target);
              return [];
            },
            formatApprovalDetails: function (this: { marker: string }) {
              NodeAssert.equal(this.marker, "receiver");
              NodeAssert.equal(this, target);
              return ["proof"];
            },
          });
        const definition = route === "sdk-custom" ? customToolToDefinition(target) : target;
        const registered = { definition };
        let adapted: InstanceType<typeof RegisteredToolAdapter>;
        const mutate = () => {
          if (variant === "executor-replacement")
            target.execute = async () => {
              replacement++;
              return { content: [], details: {} };
            };
          if (variant === "callable-replacement")
            target.approval = function () {
              return { tier: "exec", policyKey: "initial" };
            };
          if (variant === "closure-change") changed = true;
          if (variant === "definition-receiver") {
            if (route === "custom-adapter") Reflect.set(adapted, "tool", { ...target });
            else registered.definition = { ...definition };
          }
          if (variant === "meta-target-replacement") {
            const key = Object.getOwnPropertySymbols(adapted).find(
              (key) => key.description === "OutputMeta.UnwrappedExecute",
            );
            NodeAssert.ok(key);
            Object.defineProperty(adapted, key, {
              value: async () => {
                replacement++;
                return { content: [], details: {} };
              },
            });
          }
        };
        const ui = {
          approve: () => {
            prompts++;
            opened.resolve();
            return answer.promise;
          },
        };
        registerApprovalUI(boundary.epoch, ui);
        const runner = {
          sessionSettings: boundary.settings,
          cwd: process.cwd(),
          sessionId: "s",
          consumeLoopToolCall: () => false,
          consumeToolCallEmitted: () => false,
          hasHandlers: () => false,
          hasSessionApproval: () => false,
          hasUI: () => true,
          getUIContext: () => ui,
          getNativeDelegationGuidance: () => undefined,
          runScoped: (f: () => unknown) => {
            if (timing === "no-prompt") mutate();
            return f();
          },
          createContext: (_model: unknown, delegation: { context: typeof toolContext }) => {
            if (variant === "late-executor")
              target.execute = async () => {
                replacement++;
                return { content: [], details: {} };
              };
            if (variant === "late-context")
              delegation.context.toolCall.providerMetadata.nested.value = "changed";
            if (variant === "owned-input") input.nested.value = "caller changed";
            return {
              settings: boundary.settings,
              cwd: process.cwd(),
              toolCall: delegation.context.toolCall,
            };
          },
        };
        adapted =
          route === "custom-adapter"
            ? new CustomToolAdapter(target, () => {
                if (variant === "late-executor")
                  target.execute = async () => {
                    replacement++;
                    return { content: [], details: {} };
                  };
                if (variant === "owned-input") input.nested.value = "caller changed";
                return {
                  settings: variant === "late-context" ? {} : boundary.settings,
                  cwd: process.cwd(),
                };
              })
            : new RegisteredToolAdapter(registered, runner);
        if (route === "hook-registered")
          adapted = new HookToolWrapper(adapted, {
            hasHandlers: (name: string) => name === "tool_call",
            emitToolCall: async () => undefined,
          });
        if (route !== "registered" && route !== "custom-adapter")
          adapted = wrapToolWithMetaNotice(adapted);
        const outcome = new ExtensionToolWrapper(adapted, runner)
          .execute(
            "adapter-call",
            input,
            undefined,
            undefined,
            route === "custom-adapter" &&
              ["late-executor", "late-context", "owned-input"].includes(variant)
              ? undefined
              : toolContext,
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        if (timing === "pending") {
          await Promise.race([
            opened.promise,
            outcome.then((error: unknown) => {
              throw error ?? new Error("completed before approval");
            }),
          ]);
          mutate();
          answer.resolve("once");
        }
        const error = await outcome;
        const allowed = variant.startsWith("unchanged") || variant === "owned-input";
        if (
          original !== (allowed ? 1 : 0) ||
          replacement !== 0 ||
          (allowed ? error !== undefined : error === undefined) ||
          prompts !== (timing === "pending" ? 1 : 0)
        )
          failures.push(
            `${route}:${timing}:${variant} original=${original} replacement=${replacement} error=${String(error)}`,
          );
        boundary.dispose();
        authority.cancelPendingSaves();
      }
    }
  }
  await proveDelegationRegressions(root);
  for (const failure of failures) process.stderr.write(failure + "\n");
  NodeAssert.equal(failures.length, 0, "native adapter authorization regressions");
  process.stdout.write(
    JSON.stringify({ nativeAdapterRegressions: "PASS", cases, inference: 0 }) + "\n",
  );
}

async function proveDelegationRegressions(root: string) {
  const { Settings } = await importNative(root, "config/settings");
  const { ExtensionToolWrapper, RegisteredToolAdapter } = await importNative(
    root,
    "extensibility/extensions/wrapper",
  );
  const { ExtensionRunner } = await importNative(root, "extensibility/extensions/runner");
  const { wrapToolWithMetaNotice } = await importNative(root, "tools/output-meta");
  let cases = 0;
  const failures: string[] = [];
  for (const mode of ["approval-required", "full-access"]) {
    for (const variant of [
      "unchanged",
      "callable",
      "new-input",
      "static-native",
      "fallback-context",
      "fallback-scope",
      "fallback-cwd",
      "sequential",
      "concurrent",
      "detached",
      "direct-native",
      "direct-runner",
      "executor",
      "target",
      "resolver",
      "closure",
      "callable-replacement",
      "epoch",
      "scope",
      "context",
      "arbitrary-meta",
      "saved",
      "saved-during-next",
      "deny",
      "prompt",
      "delegate-pending-executor",
      "delegate-pending-epoch",
      "delegate-pending-parent",
      "delegate-pending-closure",
      "delegate-pending-input",
      "delegate-pending-native-closure",
      "delegate-pending-resolver",
      "delegate-pending-scope",
      "delegate-pending-supplied-cwd",
      "delegate-pending-fallback-cwd",
      "delegate-pending-supplied-cwd-control",
      "delegate-pending-fallback-cwd-control",
    ]) {
      const authority = Settings.isolated({
        "tools.approval": { blocked: "deny", prompted: "prompt" },
      });
      const boundary = await constrainNativeSettings(root, authority, mode, {
        providerSession: "delegate",
        environment: "e",
        project: "p",
        session: "s",
        cwd: process.cwd(),
        agentDir: authority.getAgentDir(),
        generation: ++cases,
      });
      boundary.epoch.open();
      let nativeExecuted = 0,
        replacement = 0,
        executed = 0,
        prompts = 0,
        blocked = false,
        parentBlocked = false,
        session = "s",
        contextCwd = process.cwd();
      let observedCwd: string | undefined;
      const input = { nested: { value: "approved" }, unknown: { extra: [1, 2] } };
      const ctx = {
        settings: boundary.settings,
        sessionManager: { getSessionId: () => "s", getCwd: () => contextCwd },
        toolCall: {
          index: 0,
          toolCalls: [],
          providerMetadata: { type: "proof", nested: { value: "approved" } },
        },
      };
      const manager = { getCwd: () => process.cwd(), getSessionId: () => session };
      const actualRunner = new ExtensionRunner(
        [],
        {},
        process.cwd(),
        manager,
        {},
        undefined,
        boundary.settings,
      );
      const nativeTarget = {
        name: "read",
        marker: "native-receiver",
        approval:
          variant === "static-native"
            ? "read"
            : function () {
                return {
                  tier: "read",
                  policyKey:
                    blocked || variant === "deny"
                      ? "blocked"
                      : variant === "prompt" ||
                          variant === "detached" ||
                          variant.startsWith("delegate-pending")
                        ? "prompted"
                        : "initial",
                };
              },
        execute: async function (
          this: object,
          _id: string,
          params: typeof input,
          _signal: unknown,
          _update: unknown,
          context: typeof ctx,
        ) {
          NodeAssert.equal(this, nativeTarget);
          NodeAssert.deepEqual(params, {
            nested: { value: variant === "new-input" ? "delegated" : "approved" },
            unknown: { extra: [1, 2] },
          });
          NodeAssert.notEqual(params, input);
          NodeAssert.deepEqual(context.toolCall, ctx.toolCall);
          observedCwd = context.sessionManager.getCwd();
          nativeExecuted++;
          return { content: [], details: {} };
        },
      };
      let native = wrapToolWithMetaNotice(nativeTarget);
      const resolver = (name: string) =>
        name === "read" ? { tool: native, makeContext: () => ctx } : undefined;
      actualRunner.setNativeToolResolver(resolver);
      let saved: { invokeTool: (params: typeof input) => Promise<unknown> } | undefined;
      const detachedAnswer = Promise.withResolvers<"once">();
      const detachedOpened = Promise.withResolvers<void>();
      let detached: Promise<unknown> | undefined;
      const definition = {
        name: "read",
        description: "proof",
        parameters: { type: "object" },
        approval:
          variant === "callable" || variant === "delegate-pending-closure"
            ? () => ({ tier: "exec", policyKey: parentBlocked ? "blocked" : "initial" })
            : "exec",
        execute: async (
          _id: string,
          params: typeof input,
          _signal: unknown,
          _update: unknown,
          context: { invokeTool: (params: typeof input) => Promise<unknown> },
        ) => {
          executed++;
          if (variant === "saved" || (variant === "saved-during-next" && executed === 1)) {
            saved = context;
            return { content: [], details: {} };
          }
          if (variant === "saved-during-next") return saved!.invokeTool(params);
          if (variant === "executor") {
            const key = Object.getOwnPropertySymbols(nativeTarget).find(
              (key) => key.description === "OutputMeta.UnwrappedExecute",
            )!;
            Object.defineProperty(nativeTarget, key, {
              value: async () => {
                replacement++;
                return { content: [], details: {} };
              },
            });
          }
          if (variant === "target")
            native = wrapToolWithMetaNotice({
              ...nativeTarget,
              execute: async () => {
                replacement++;
                return { content: [], details: {} };
              },
            });
          if (variant === "resolver")
            actualRunner.setNativeToolResolver((name: string) => resolver(name));
          if (variant === "closure") blocked = true;
          if (variant === "callable-replacement")
            nativeTarget.approval = function () {
              return { tier: "read", policyKey: "initial" };
            };
          if (variant === "epoch") boundary.epoch.invalidate("delegation revoked");
          if (variant === "scope") session = "other";
          if (variant === "context") Reflect.set(ctx, "settings", {});
          if (variant === "fallback-scope")
            Reflect.set(ctx, "sessionManager", { getSessionId: () => "other" });
          if (variant === "fallback-cwd")
            Reflect.set(ctx, "sessionManager", { getSessionId: () => "s", getCwd: () => "/other" });
          if (variant === "direct-native")
            return native.execute("direct", params, undefined, undefined, ctx);
          if (variant === "direct-runner")
            return actualRunner.invokeNativeTool("read", params, { callerContext: ctx });
          if (variant === "detached") {
            detached = context.invokeTool(params).then(
              () => undefined,
              (error: unknown) => error,
            );
            await detachedOpened.promise;
            return { content: [], details: {} };
          }
          if (variant === "sequential") {
            await context.invokeTool(params);
            return context.invokeTool(params);
          }
          if (variant === "concurrent") {
            await Promise.all([context.invokeTool(params), context.invokeTool(params)]);
            return { content: [], details: {} };
          }
          if (variant === "arbitrary-meta")
            return wrapToolWithMetaNotice({
              name: "read",
              execute: async () => {
                replacement++;
                return { content: [], details: {} };
              },
            }).execute("unrelated", params, undefined, undefined, ctx);
          delegatedInput = params;
          return context.invokeTool(
            variant === "new-input" ? { ...params, nested: { value: "delegated" } } : params,
          );
        },
      };
      let delegatedInput: typeof input | undefined;
      const ui = {
        approve: async () => {
          prompts++;
          if (variant === "detached" && prompts === (mode === "approval-required" ? 2 : 1)) {
            detachedOpened.resolve();
            return detachedAnswer.promise;
          }
          if (
            variant.startsWith("delegate-pending") &&
            prompts === (mode === "approval-required" ? 2 : 1)
          ) {
            await Promise.resolve();
            if (variant === "delegate-pending-executor") {
              const key = Object.getOwnPropertySymbols(nativeTarget).find(
                (key) => key.description === "OutputMeta.UnwrappedExecute",
              )!;
              Object.defineProperty(nativeTarget, key, {
                value: async () => {
                  replacement++;
                  return { content: [], details: {} };
                },
              });
            }
            if (variant === "delegate-pending-epoch")
              boundary.epoch.invalidate("pending native delegation revoked");
            if (variant === "delegate-pending-parent")
              definition.execute = async () => {
                replacement++;
                return { content: [], details: {} };
              };
            if (variant === "delegate-pending-closure") parentBlocked = true;
            if (variant === "delegate-pending-input") delegatedInput!.nested.value = "changed";
            if (variant === "delegate-pending-native-closure") blocked = true;
            if (variant === "delegate-pending-resolver")
              actualRunner.setNativeToolResolver((name: string) => resolver(name));
            if (variant === "delegate-pending-scope") session = "other";
            if (
              variant === "delegate-pending-supplied-cwd" ||
              variant === "delegate-pending-fallback-cwd"
            )
              contextCwd = "/other";
          }
          return "once";
        },
      };
      registerApprovalUI(boundary.epoch, ui);
      const runner = {
        sessionSettings: boundary.settings,
        cwd: process.cwd(),
        sessionId: "s",
        consumeLoopToolCall: () => false,
        consumeToolCallEmitted: () => false,
        hasHandlers: () => false,
        hasSessionApproval: () => false,
        hasUI: () => true,
        getUIContext: () => ui,
        runScoped: (f: () => unknown) => f(),
        createContext: actualRunner.createContext.bind(actualRunner),
        getNativeDelegationGuidance: () => undefined,
      };
      const wrapped = new ExtensionToolWrapper(
        wrapToolWithMetaNotice(new RegisteredToolAdapter({ definition }, runner)),
        runner,
      );
      let error: unknown;
      try {
        await wrapped.execute(
          "delegate",
          input,
          undefined,
          undefined,
          [
            "context",
            "fallback-context",
            "fallback-scope",
            "fallback-cwd",
            "delegate-pending-fallback-cwd",
            "delegate-pending-fallback-cwd-control",
          ].includes(variant)
            ? undefined
            : ctx,
        );
        if (variant === "detached") {
          detachedAnswer.resolve("once");
          error = await detached;
        }
        if (variant === "saved") await saved!.invokeTool(input);
        if (variant === "saved-during-next")
          await wrapped.execute("next", input, undefined, undefined, ctx);
      } catch (cause) {
        error = cause;
      }
      const allowed = [
        "unchanged",
        "callable",
        "new-input",
        "prompt",
        "static-native",
        "fallback-context",
        "sequential",
        "concurrent",
        "delegate-pending-supplied-cwd-control",
        "delegate-pending-fallback-cwd-control",
      ].includes(variant);
      if (
        nativeExecuted !==
          (allowed ? (["sequential", "concurrent"].includes(variant) ? 2 : 1) : 0) ||
        replacement !== 0 ||
        (allowed && observedCwd !== process.cwd()) ||
        prompts !==
          (mode === "approval-required" ? (variant === "saved-during-next" ? 2 : 1) : 0) +
            (variant === "prompt" ||
            variant === "detached" ||
            variant.startsWith("delegate-pending")
              ? 1
              : 0) ||
        (allowed ? error !== undefined : error === undefined) ||
        executed !== (variant === "saved-during-next" ? 2 : 1)
      )
        failures.push(
          `${mode}:${variant} executed=${executed} native=${nativeExecuted} replacement=${replacement} prompts=${prompts} observedCwd=${observedCwd} error=${String(error)}`,
        );
      boundary.dispose();
      authority.cancelPendingSaves();
      actualRunner.clearManagedTimers();
    }
  }
  for (const failure of failures) process.stderr.write(failure + "\n");
  NodeAssert.equal(failures.length, 0, "native same-tool delegation regressions");
  process.stdout.write(
    JSON.stringify({ nativeDelegationRegressions: "PASS", cases, inference: 0 }) + "\n",
  );
}
