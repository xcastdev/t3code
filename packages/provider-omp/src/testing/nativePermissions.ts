// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import { importNative, constrainNativeSettings } from "../server/runtimeLauncher.ts";
import { invalidateSettings, registerApprovalUI } from "../server/runtimePolicyHooks.ts";

export async function provePermissions(root: string) {
  const { Settings } = await importNative(root, "config/settings");
  const { cfgToolsApproval, cfgToolsApprovalMode } = await importNative(root, "tools/settings");
  const { resolveApproval } = await importNative(root, "tools/approval");
  const { ExtensionToolWrapper } = await importNative(root, "extensibility/extensions/wrapper");
  const { invokeEvalPrelude } = await importNative(root, "eval/preludes");
  const { callSessionTool } = await importNative(root, "eval/js/tool-bridge");
  const { XdProtocolHandler } = await importNative(root, "internal-urls/xd-protocol");
  const { WriteTool } = await importNative(root, "tools/write");
  let generation = 0;
  let cases = 0;
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"]) {
    for (const target of ["deny", "prompt", "removed", "new-key"]) {
      const authority = Settings.isolated({
        "tools.approval": { canonical: "allow", legacy: "allow", mounted: "allow" },
      });
      const scope = {
        providerSession: "proof",
        environment: "e",
        project: "p",
        session: "s",
        cwd: process.cwd(),
        agentDir: authority.getAgentDir(),
        generation: ++generation,
      };
      let observerBefore = false;
      let old: Awaited<ReturnType<typeof constrainNativeSettings>>;
      const remove = authority.onEffectiveChange([cfgToolsApproval], () => {
        observerBefore = old.epoch.signal.aborted;
      });
      old = await constrainNativeSettings(root, authority, mode, scope);
      old.epoch.open();
      let observerAfter = false;
      const later = authority.onEffectiveChange([cfgToolsApproval], () => {
        observerAfter = old.epoch.signal.aborted;
      });
      const policy =
        target === "removed"
          ? {}
          : target === "new-key"
            ? { fresh: "deny" }
            : { canonical: target, legacy: target, mounted: target };
      cfgToolsApproval.override(authority, policy);
      NodeAssert.ok(old.epoch.signal.aborted);
      NodeAssert.ok(observerBefore);
      NodeAssert.ok(observerAfter);
      old.dispose();
      remove();
      later();
      const fresh = await constrainNativeSettings(root, authority, mode, {
        ...scope,
        generation: ++generation,
      });
      fresh.epoch.open();
      for (const key of ["canonical", "legacy", "mounted", "fresh"]) {
        const explicit = policy[key as keyof typeof policy];
        const expected = explicit ?? (mode === "full-access" ? "allow" : "prompt");
        NodeAssert.equal(
          resolveApproval(
            { name: key, approval: "exec" },
            {},
            fresh.mode.native,
            cfgToolsApproval.get(fresh.settings),
          ).policy,
          expected,
        );
      }
      fresh.dispose();
      authority.cancelPendingSaves();
      cases++;
    }
    const authority = Settings.isolated({
      "tools.approval": {
        write: "allow",
        bash: "allow",
        eval: "allow",
        browser: "allow",
        computer: "allow",
        mounted: "allow",
        denied: "deny",
        explicit: "prompt",
      },
    });
    const scope = {
      providerSession: "proof",
      environment: "e",
      project: "p",
      session: "s",
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      generation: ++generation,
    };
    const boundary = await constrainNativeSettings(root, authority, mode, scope);
    boundary.epoch.open();
    for (const [name, tier] of [
      ["read", "read"],
      ["write", "write"],
      ["bash", "exec"],
      ["eval", "exec"],
      ["mounted", "exec"],
      ["browser", "exec"],
      ["computer", "exec"],
    ]) {
      const expected =
        tier === "read" ||
        mode === "full-access" ||
        (mode === "auto-accept-edits" && tier === "write")
          ? "allow"
          : "prompt";
      NodeAssert.equal(
        resolveApproval(
          { name, approval: tier },
          {},
          boundary.mode.native,
          cfgToolsApproval.get(boundary.settings),
        ).policy,
        expected,
      );
      cases++;
    }
    for (const [key, policy] of [
      ["denied", "deny"],
      ["explicit", "prompt"],
    ])
      NodeAssert.equal(
        resolveApproval(
          { name: key, approval: "read" },
          {},
          boundary.mode.native,
          cfgToolsApproval.get(boundary.settings),
        ).policy,
        policy,
      );
    const nativeTier = new XdProtocolHandler().spec.write.tier(
      { href: "xd://mounted", rawHref: "xd://mounted" },
      "{}",
      {
        xdev: {
          tools: new Map([["mounted", { name: "mounted", approval: "exec" }]]),
          mountedNames: new Set(["mounted"]),
          builtInNames: new Set(),
          isActive: () => false,
        },
      },
    );
    NodeAssert.deepEqual(nativeTier, { tier: "exec", policyKey: "mounted" });
    NodeAssert.equal(
      resolveApproval(
        { name: "write", approval: () => nativeTier },
        {},
        boundary.mode.native,
        cfgToolsApproval.get(boundary.settings),
      ).policy,
      mode === "full-access" ? "allow" : "prompt",
    );
    for (const policy of ["deny", "prompt"]) {
      NodeAssert.equal(
        resolveApproval(
          { name: "canonical", legacyName: "legacy", approval: "exec" },
          {},
          boundary.mode.native,
          { legacy: policy },
        ).policy,
        policy,
      );
    }
    const clone = await boundary.settings.cloneForCwd(process.cwd());
    NodeAssert.notEqual(clone, boundary.settings);
    clone.cancelPendingSaves();
    boundary.dispose();
    authority.cancelPendingSaves();
  }
  const dest = NodePath.join(process.cwd(), "destination");
  await NodeFSP.mkdir(dest, { recursive: true });
  for (const kind of ["direct", "eval", "xd", "browser", "computer"]) {
    for (const race of [
      "deny",
      "mode",
      "expire",
      "disconnect",
      "replace",
      "input-pending",
      "input-resolved",
      "context-pending",
      "context-resolved",
      "no-prompt-context",
      "no-prompt-input",
      "no-prompt-revoke",
      "cwd",
      "same-cwd",
      "clone",
    ]) {
      const authority = Settings.isolated({ "tools.approvalMode": "yolo" });
      const scope = {
        providerSession: "proof",
        environment: "e",
        project: "p",
        session: "s",
        cwd: process.cwd(),
        agentDir: authority.getAgentDir(),
        generation: ++generation,
      };
      const boundary = await constrainNativeSettings(
        root,
        authority,
        race.startsWith("no-prompt") ? "full-access" : "approval-required",
        scope,
      );
      boundary.epoch.open();
      const { settings } = boundary;
      const opened = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<"once">();
      let executions = 0;
      const params = {
        nested: { value: "approved" },
        unknown: [1, { path: "relative.txt" }],
        path: "xd://execProof",
        content: JSON.stringify({ nested: { value: "approved" } }),
      };
      const ui = {
        approve: () => {
          opened.resolve();
          return answer.promise.then((value) => {
            if (kind === "browser" || kind === "computer") {
              if (race === "input-resolved") params.nested.value = "changed";
              if (race === "context-resolved")
                context.toolCall.providerMetadata.payload.scope = "changed";
            }
            return value;
          });
        },
      };
      registerApprovalUI(boundary.epoch, ui);
      const context = {
        settings,
        ui,
        hasUI: true,
        toolCall: {
          index: 0,
          toolCalls: [{ id: "other", name: "other", arguments: {} }],
          providerMetadata: { type: "proof", payload: { scope: "approved" } },
        },
      };
      const runner = {
        cwd: process.cwd(),
        sessionSettings: settings,
        sessionId: "s",
        consumeLoopToolCall: () => false,
        consumeToolCallEmitted: () => false,
        hasHandlers: (name: string) =>
          (race === "input-resolved" || race === "context-resolved") &&
          name === "tool_approval_resolved",
        hasSessionApproval: () => false,
        hasUI: () => true,
        getUIContext: () => ui,
        emit: async (event: { type: string }) => {
          if (event.type === "tool_approval_resolved") {
            if (race === "context-resolved")
              context.toolCall.providerMetadata.payload.scope = "changed";
            else params.nested.value = "changed";
          }
        },
        runScoped: (fn: () => unknown) => {
          if (race === "no-prompt-context")
            context.toolCall.providerMetadata.payload.scope = "changed";
          if (race === "no-prompt-input") params.nested.value = "changed";
          if (race === "no-prompt-revoke") invalidateSettings(settings, "revoked before invoke");
          return fn();
        },
      };
      const tool = {
        name: "execProof",
        approval: "exec",
        description: "proof",
        label: "proof",
        parameters: { type: "object", additionalProperties: true },
        execute: async () => {
          executions++;
          return { content: [{ type: "text", text: "ran" }], details: {} };
        },
      };
      const wrapped = new ExtensionToolWrapper(tool, runner);
      const definition = {
        name: kind,
        approval: () => {
          if (race.startsWith("no-prompt"))
            queueMicrotask(() => {
              if (race === "no-prompt-context")
                context.toolCall.providerMetadata.payload.scope = "changed";
              else if (race === "no-prompt-input") params.nested.value = "changed";
              else invalidateSettings(settings, "revoked");
            });
          return "exec";
        },
        documentation: "proof",
        javascript: "",
        python: "",
        exports: [],
        invoke: tool.execute,
      };
      const session = {
        getSessionFile: () => null,
        settings,
        cwd: process.cwd(),
        getEvalPreludes: () => [definition],
        getToolForEvalBridge: () => wrapped,
        getToolContext: () => context,
        xdev: {
          tools: new Map([["execProof", wrapped]]),
          mountedNames: new Set(["execProof"]),
          builtInNames: new Set(),
          isActive: () => false,
        },
      };
      const execution =
        kind === "browser" || kind === "computer"
          ? invokeEvalPrelude(kind, params, { session, toolCallId: "prelude", context })
          : kind === "eval"
            ? callSessionTool("execProof", params, { session })
            : kind === "xd"
              ? new ExtensionToolWrapper(new WriteTool(session), runner).execute(
                  "xd-outer",
                  params,
                  undefined,
                  undefined,
                  context,
                )
              : wrapped.execute("direct", params, undefined, undefined, context);
      const outcome = execution.then(
        () => undefined,
        (e: unknown) => e,
      );
      if (!race.startsWith("no-prompt") && race !== "clone") await opened.promise;
      switch (race) {
        case "deny":
          cfgToolsApproval.override(authority, {
            write: "deny",
            execProof: "deny",
            browser: "deny",
            computer: "deny",
          });
          break;
        case "mode":
          cfgToolsApprovalMode.override(settings, "yolo");
          break;
        case "expire":
          boundary.epoch.invalidate("approval expired");
          break;
        case "disconnect":
          boundary.epoch.invalidate("control disconnected");
          break;
        case "replace":
          context.settings = Settings.isolated();
          break;
        case "context-pending":
          context.toolCall.providerMetadata.payload.scope = "changed";
          break;
        case "input-pending":
          params.nested.value = "changed";
          break;
        case "cwd":
          await settings.reloadForCwd(dest);
          break;
        case "same-cwd":
          await settings.reloadForCwd(process.cwd());
          break;
        case "clone":
          context.settings = await settings.cloneForCwd(process.cwd());
          break;
      }
      answer.resolve("once");
      const error = await outcome;
      NodeAssert.ok(error, `${kind}:${race} must refuse`);
      NodeAssert.equal(executions, 0, `${kind}:${race} executed`);
      if (context.settings !== settings) context.settings.cancelPendingSaves();
      boundary.dispose();
      authority.cancelPendingSaves();
      cases++;
    }
  }
  {
    const authority = Settings.isolated();
    const boundary = await constrainNativeSettings(root, authority, "full-access", {
      providerSession: "proof",
      environment: "e",
      project: "p",
      session: "s",
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      generation: ++generation,
    });
    boundary.epoch.open();
    const started = Promise.withResolvers<void>();
    let cancelled = 0;
    const runner = {
      sessionSettings: boundary.settings,
      cwd: process.cwd(),
      sessionId: "s",
      consumeToolCallEmitted: () => false,
      consumeLoopToolCall: () => false,
      hasHandlers: () => false,
      hasSessionApproval: () => false,
      runScoped: (f: () => unknown) => f(),
    };
    const tool = {
      name: "cancellable",
      approval: "exec",
      description: "proof",
      parameters: { type: "object" },
      execute: (_id: string, _params: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled++;
              reject(signal.reason);
            },
            { once: true },
          );
          started.resolve();
        }),
    };
    const running = new ExtensionToolWrapper(tool, runner).execute("cancellable", {});
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    cfgToolsApproval.override(authority, { cancellable: "deny" });
    NodeAssert.ok(await settled);
    NodeAssert.equal(cancelled, 1);
    boundary.dispose();
    authority.cancelPendingSaves();
    cases++;
  }
  {
    const authority = Settings.isolated();
    const boundary = await constrainNativeSettings(root, authority, "approval-required", {
      providerSession: "proof",
      environment: "e",
      project: "p",
      session: "s",
      cwd: process.cwd(),
      agentDir: authority.getAgentDir(),
      generation: ++generation,
    });
    boundary.epoch.open();
    let selects = 0,
      executions = 0;
    const runner = {
      sessionSettings: boundary.settings,
      cwd: process.cwd(),
      sessionId: "s",
      consumeToolCallEmitted: () => false,
      consumeLoopToolCall: () => false,
      hasHandlers: () => false,
      hasSessionApproval: () => false,
      hasUI: () => true,
      getUIContext: () => ({
        select: async () => {
          selects++;
          return "Approve";
        },
      }),
      runScoped: (f: () => unknown) => f(),
    };
    const tool = {
      name: "unregistered-ui",
      approval: "exec",
      description: "proof",
      parameters: { type: "object" },
      execute: async () => {
        executions++;
        return { content: [], details: {} };
      },
    };
    await NodeAssert.rejects(
      new ExtensionToolWrapper(tool, runner).execute("unregistered-ui", {}),
      /unregistered approval UI/,
    );
    NodeAssert.equal(selects, 0);
    NodeAssert.equal(executions, 0);
    boundary.dispose();
    authority.cancelPendingSaves();
    cases++;
  }
  process.stdout.write(JSON.stringify({ nativePermissionMatrix: "PASS", cases }) + "\n");
}
