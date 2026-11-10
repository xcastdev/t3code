// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { constrainNativeSettings, importNative } from "../server/runtimeLauncher.ts";
import { registerApprovalUI } from "../server/runtimePolicyHooks.ts";

export async function proveReviewRegressions(root: string, selection = "all") {
  const { Settings } = await importNative(root, "config/settings");
  const { ExtensionToolWrapper } = await importNative(root, "extensibility/extensions/wrapper");
  const { invokeEvalPrelude } = await importNative(root, "eval/preludes");
  const failures: string[] = [];
  let cases = 0;
  if (selection === "all" || selection === "context") {
    for (const kind of ["tool", "prelude"]) {
      for (const mode of ["approval-required", "auto-accept-edits", "full-access"]) {
        for (const variant of ["missing", "registered", "omitted"]) {
          const authority = Settings.isolated({ "tools.approval": { denied: "deny" } });
          const boundary = await constrainNativeSettings(root, authority, mode, {
            providerSession: "review",
            environment: "e",
            project: "p",
            session: "s",
            cwd: process.cwd(),
            agentDir: authority.getAgentDir(),
            generation: ++cases,
          });
          boundary.epoch.open();
          let executed = 0;
          const execute = async () => {
            executed++;
            return { content: [], details: {} };
          };
          const name = variant === "missing" ? "denied" : "allowed";
          const supplied =
            variant === "missing"
              ? {}
              : variant === "registered"
                ? { settings: boundary.settings }
                : undefined;
          const tool = {
            name,
            approval: "read",
            parameters: { type: "object" },
            description: "proof",
            execute,
          };
          const runner = {
            sessionSettings: boundary.settings,
            cwd: process.cwd(),
            sessionId: "s",
            consumeLoopToolCall: () => false,
            consumeToolCallEmitted: () => false,
            hasHandlers: () => false,
            hasSessionApproval: () => false,
            hasUI: () => false,
            runScoped: (f: () => unknown) => f(),
          };
          const definition = {
            name,
            approval: "read",
            documentation: "proof",
            javascript: "",
            python: "",
            exports: [],
            invoke: execute,
          };
          const session = {
            settings: boundary.settings,
            cwd: process.cwd(),
            getEvalPreludes: () => [definition],
          };
          const running =
            kind === "tool"
              ? new ExtensionToolWrapper(tool, runner).execute(
                  "empty-context",
                  {},
                  undefined,
                  undefined,
                  supplied,
                )
              : invokeEvalPrelude(
                  name,
                  {},
                  { session, toolCallId: "empty-context", context: supplied },
                );
          const error = await running.then(
            () => undefined,
            (error: unknown) => error,
          );
          const expected = variant === "missing" ? 0 : 1;
          if (executed !== expected || (expected === 0 && !error) || (expected === 1 && error))
            failures.push(
              `${kind}:${mode}:${variant}-context executed=${executed} expected=${expected}`,
            );
          boundary.dispose();
          authority.cancelPendingSaves();
        }
      }
    }
  }
  if (selection === "all" || selection === "subject") {
    for (const kind of ["tool", "prelude"]) {
      for (const timing of ["pending", "no-prompt"]) {
        for (const variant of [
          "legacy",
          "nested-approval",
          "nested-data",
          "callable-key",
          "callable-tier",
          "unchanged",
        ]) {
          const authority = Settings.isolated({
            "tools.approval": { blockedLegacy: "deny", blockedKey: "deny" },
          });
          const boundary = await constrainNativeSettings(
            root,
            authority,
            timing === "pending" ? "approval-required" : "full-access",
            {
              providerSession: "review",
              environment: "e",
              project: "p",
              session: "s",
              cwd: process.cwd(),
              agentDir: authority.getAgentDir(),
              generation: ++cases,
            },
          );
          boundary.epoch.open();
          let executed = 0,
            changed = false,
            prompts = 0;
          const opened = Promise.withResolvers<void>();
          const answer = Promise.withResolvers<"once">();
          const approval = {
            tier: "exec",
            policyKey: "initial",
            extra: { nested: { value: "approved" } },
          };
          const callable = () => ({
            tier: variant === "callable-tier" && changed ? "read" : "exec",
            policyKey: variant === "callable-key" && changed ? "blockedKey" : "initial",
          });
          const execute = async () => {
            executed++;
            return { content: [], details: {} };
          };
          const subject = {
            name: "review",
            legacyName: "initial",
            approval: variant.startsWith("callable") ? callable : approval,
            parameters: { type: "object" },
            description: "proof",
            documentation: "proof",
            javascript: "",
            python: "",
            exports: [],
            execute,
            invoke: execute,
          };
          const mutate = () => {
            if (variant === "legacy") subject.legacyName = "blockedLegacy";
            else if (variant === "nested-approval") approval.policyKey = "blockedKey";
            else if (variant === "nested-data") approval.extra.nested.value = "changed";
            else if (variant.startsWith("callable")) changed = true;
          };
          const ui = {
            approve: () => {
              prompts++;
              opened.resolve();
              return answer.promise;
            },
          };
          registerApprovalUI(boundary.epoch, ui);
          const context = { settings: boundary.settings, ui, hasUI: true };
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
            runScoped: (f: () => unknown) => {
              if (timing === "no-prompt") mutate();
              return f();
            },
          };
          const session = {
            settings: boundary.settings,
            cwd: process.cwd(),
            getEvalPreludes: () => [subject],
          };
          const running =
            kind === "tool"
              ? new ExtensionToolWrapper(subject, runner).execute(
                  "subject",
                  {},
                  undefined,
                  undefined,
                  context,
                )
              : invokeEvalPrelude("review", {}, { session, toolCallId: "subject", context });
          const outcome = running.then(
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
          } else if (kind === "prelude") mutate();
          const error = await outcome;
          const expected = variant === "unchanged" ? 1 : 0;
          if (
            executed !== expected ||
            (expected === 0 && !error) ||
            (expected === 1 && error) ||
            prompts !== (timing === "pending" ? 1 : 0)
          )
            failures.push(
              `${kind}:${timing}:${variant} executed=${executed} expected=${expected} error=${String(error)}`,
            );
          boundary.dispose();
          authority.cancelPendingSaves();
        }
      }
    }
  }
  for (const failure of failures) process.stderr.write(failure + "\n");
  NodeAssert.equal(
    failures.length,
    0,
    `native review ${selection} regressions must refuse changed authorization`,
  );
  process.stdout.write(
    JSON.stringify({ nativeReviewRegressions: "PASS", selection, cases }) + "\n",
  );
}
