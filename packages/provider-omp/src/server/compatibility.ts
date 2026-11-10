// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ompRecipe, ompBoundaryFingerprints } from "./recipe.ts";

export const requiredGuards = Object.keys(ompRecipe);
export function verifyInstallation(root: string, runtime: string) {
  if (runtime !== "1.4.4")
    throw new Error(`Unsupported OMP Bun runtime: ${runtime}; requires 1.4.4`);
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  if (
    manifest.name !== "@oh-my-pi/pi-coding-agent" ||
    manifest.version !== "18.16.0" ||
    manifest.bin?.omp !== "dist/cli.js" ||
    manifest.exports?.["."]?.import !== "./src/index.ts"
  )
    throw new Error("Unsupported OMP package layout; requires source-bearing 18.16.0");
  for (const [name, hash] of Object.entries({ ...ompRecipe, ...ompBoundaryFingerprints })) {
    const path = NodeFS.realpathSync(NodePath.join(root, "src", name));
    const rel = NodePath.relative(NodeFS.realpathSync(root), path);
    if (rel.startsWith("..") || NodePath.isAbsolute(rel))
      throw new Error("OMP module escaped package root");
    verifySource(name, NodeFS.readFileSync(path, "utf8"), hash);
  }
}
function verifySource(
  name: string,
  source: string,
  hash: string | undefined = ompRecipe[name as keyof typeof ompRecipe],
) {
  if (!hash || NodeCrypto.createHash("sha256").update(source).digest("hex") !== hash)
    throw new Error(`Unsupported OMP source fingerprint: ${name}`);
}
export function replaceOnce(source: string, anchor: string, replacement: string) {
  if (source.split(anchor).length !== 2) throw new Error("OMP transformation count mismatch");
  return source.replace(anchor, replacement);
}
export function transformNativeModule(name: string, source: string, hooksUrl: string) {
  verifySource(name, source);
  let out = source;
  const replace = (a: string, b: string) => {
    out = replaceOnce(out, a, b);
  };
  switch (name) {
    case "eval/js/tool-bridge.ts": {
      const anchor =
        "export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {";
      replace(anchor, `${anchor}\n t3.denyHelper(name);`);
      break;
    }
    case "extensibility/extensions/wrapper.ts": {
      replace(
        "applyToolProxy(registeredTool.definition, this);",
        "applyToolProxy(registeredTool.definition, this);\n t3.registerExecutionBoundary(this,'registered',registeredTool.definition,()=>({target:this.registeredTool.definition,receiver:this.registeredTool.definition,execute:this.registeredTool.definition.execute,owner:this.runner}));",
      );
      replace(
        "\t\treturn this.registeredTool.definition.execute(\n\t\t\ttoolCallId,\n\t\t\tparams,\n\t\t\tsignal,\n\t\t\tonUpdate,\n\t\t\tthis.runner.createContext(undefined, {\n\t\t\t\ttoolName: this.registeredTool.definition.name,\n\t\t\t\tcontext,\n\t\t\t\tsignal,\n\t\t\t\tonUpdate,\n\t\t\t}),\n\t\t);",
        "        const t3Context = this.runner.createContext(undefined, {toolName:this.registeredTool.definition.name,context,signal,onUpdate});\n        const t3Call = t3.assertExecutionBoundary({adapter:this,kind:'registered',target:this.registeredTool.definition,params,context,owner:this.runner,derivedContext:t3Context});\n        return t3Call.execute.call(t3Call.receiver,toolCallId,t3Call.input,signal,onUpdate,t3Call.context);",
      );
      const anchor = "const approvalSettings = context?.settings ?? this.runner.sessionSettings;";
      replace(
        anchor,
        `${anchor}\n const t3Settings = approvalSettings;\n const t3Scope = () => t3.nativeScope(t3Settings, this.runner);\n const t3Context = () => t3.nativeContext(t3Settings, this.runner, context);\n t3Context();\n const t3Token = t3.enterNativeCall(t3Settings, {nativeCallId:toolCallId, kind:'tool',scope:t3Scope()});\n signal = t3.nativeSignal(t3Token,signal);`,
      );
      const capture = "context?.xdevTierResolved?.(resolved.tier);";
      replace(
        capture,
        `const t3Auth = t3.captureAuthorization(t3Token, {subject:this.tool,effectiveInput:effectiveParams,executionContext:t3Context(),disposition:'pending',decision:{mode:approvalMode,decision:resolved},resolveDecision:(t3Input,t3CurrentContext=context)=>{const latest=resolveApprovalFromContext(t3CurrentContext ?? {settings:t3Settings});return {mode:latest.approvalMode,decision:resolveApproval(this.tool,approvalArgs(t3Input,t3CurrentContext),latest.approvalMode,latest.userPolicies,approvalGrants,approvalRestrictions(t3Settings,this.runner.cwd),t3CurrentContext)};}});\n ${capture}`,
      );
      replace(
        "const answer = await requestApproval(uiContext, this.tool, resolvedArgs, {",
        "const answer = await t3.withAuthorization(t3Auth, () => requestApproval(uiContext, this.tool, resolvedArgs, {",
      );
      replace("grants: cacheTargets,\n\t\t\t\t});", "grants: cacheTargets,\n\t\t\t\t}));");
      replace(
        "// Execute the actual tool",
        "t3.finalizeAuthorization(t3Auth, approvalCheck.required ? 'once' : 'allow');\n // Execute the actual tool",
      );
      replace(
        "this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context)",
        "t3.invokeAuthorizedTool(t3Auth, {settings:context?.settings ?? this.runner.sessionSettings,subject:this.tool,effectiveInput:effectiveParams,executionContext:t3Context(),scope:t3Scope()},context,this.runner,(t3Execute,t3Receiver,t3Input,t3OwnedContext)=>t3Execute.call(t3Receiver,toolCallId,t3Input,signal,onUpdate,t3OwnedContext))",
      );
      break;
    }
    case "eval/preludes.ts": {
      replace(
        'if (resolved.policy === "deny") throw denyError(resolved, definition.name);',
        't3.capturePolicyDecision({mode,decision:resolved});\n if (resolved.policy === "deny") throw denyError(resolved, definition.name);',
      );
      replace(
        "let definition = findEnabledEvalPrelude(context.session, name);",
        "const t3Settings = context.context?.settings ?? context.session.settings;\n const t3Scope = () => t3.nativeScope(t3Settings, context.session);\n const t3Context = () => t3.nativeContext(t3Settings, context.session, context.context);\n t3Context();\n const t3Token = t3.enterNativeCall(t3Settings, {nativeCallId:context.toolCallId,kind:'prelude',scope:t3Scope()});\n context = {...context,signal:t3.nativeSignal(t3Token,context.signal)};\n let definition = findEnabledEvalPrelude(context.session, name);",
      );
      replace(
        "await approvePreludeInvocation(definition, parameters, context);\n\tcontext.signal?.throwIfAborted();",
        "const t3Auth = t3.captureAuthorization(t3Token,{subject:definition,effectiveInput:parameters,executionContext:t3Context(),disposition:'pending',resolveDecision:(t3Input)=>{const latest=resolveApprovalFromContext(context.context ?? {settings:t3Settings});const subject={name:definition.name,...(definition.approval !== undefined ? {approval:definition.approval}:{})};return {mode:latest.approvalMode,decision:resolveApproval(subject,t3Input,latest.approvalMode,latest.userPolicies,undefined,approvalRestrictions(t3Settings,context.session.cwd))};}});\n await t3.withAuthorization(t3Auth, () => approvePreludeInvocation(definition, parameters, context));\n context.signal?.throwIfAborted();",
      );
      replace(
        "definition = current;",
        "throw new Error('OMP prelude identity changed; fresh authorization required');\n definition = current;",
      );
      replace(
        "return definition.invoke(parameters, context);",
        "t3.finalizeAuthorization(t3Auth,'once');\n return definition.invoke(t3.assertBeforeInvoke(t3Auth,{settings:context.context?.settings ?? context.session.settings,subject:definition,effectiveInput:parameters,executionContext:t3Context(),scope:t3Scope()}), {...context,context:t3.ownedNativeContext(context.context)});",
      );
      break;
    }
    case "config/settings.ts":
      replace(
        "#notifyChange(setting: AnySetting): void {",
        "#notifyChange(setting: AnySetting): void {\n t3.settingChanged(this, setting.id);",
      );
      replace(
        "async reloadForCwd(cwd: string): Promise<void> {",
        "async reloadForCwd(cwd: string): Promise<void> {\n t3.scopeTransition(this);",
      );
      replace(
        "async reloadFromDisk(options?: { includeParents?: boolean }): Promise<void> {",
        "async reloadFromDisk(options?: { includeParents?: boolean }): Promise<void> {\n t3.scopeTransition(this);",
      );
      break;
    case "session/agent-session.ts":
      replace(
        "#beginSessionTransition(): Disposable {",
        "#beginSessionTransition(): Disposable {\n t3.scopeTransition(this.settings);",
      );
      for (const anchor of [
        "async newSession(options?: NewSessionOptions): Promise<boolean> {",
        "async fork(entryId?: string, options?: { requireIdle?: boolean }): Promise<boolean> {",
        "async moveSession(newCwd: string, targetSessionDir?: string): Promise<void> {",
        "async resume(): Promise<void> {",
      ])
        replace(anchor, `${anchor}\n t3.scopeTransition(this.settings);`);
      replace(
        "): Promise<boolean> {\n\t\tconst explicitModel = options?.model;",
        "): Promise<boolean> {\n t3.scopeTransition(this.settings);\n\t\tconst explicitModel = options?.model;",
      );
      break;
    case "session/session-manager.ts":
      for (const anchor of [
        "async setSessionFile(sessionFile: string): Promise<void> {",
        "async newSession(options?: NewSessionOptions): Promise<string | undefined> {",
        "async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {",
        "async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {",
        "setCwdWithoutRelocation(newCwd: string): void {",
      ])
        replace(anchor, `${anchor}\n t3.sessionManagerTransition(this);`);
      break;
    case "extensibility/extensions/user-wait.ts":
      replace("return new Proxy(ui, {", "return t3.deriveApprovalUI(ui, new Proxy(ui, {");
      replace("\t});\n}", "\t}));\n}");
      break;
    case "extensibility/extensions/runner.ts":
      out = 'import { ExtensionToolWrapper as T3NativeToolWrapper } from "./wrapper";\n' + out;
      replace(
        "return (await resolved.tool.execute(",
        "return (await t3.invokeNativeDelegation(this,name,resolved,options?.callerContext,(t3Tool,t3Runner,t3Context)=>new T3NativeToolWrapper(t3Tool,t3Runner).execute(",
      );
      replace(
        "options?.callerContext ?? resolved.makeContext(),\n\t\t)) as AgentToolResult<TDetails>;",
        "t3Context,\n\t\t))) as AgentToolResult<TDetails>;",
      );
      replace(
        "? (params, options) =>\n\t\t\t\t\t\t\tthis.invokeNativeTool(delegation.toolName, params, {",
        "? t3.bindNativeDelegation(this,delegation.toolName,delegation.context,()=>{const resolved=this.#nativeToolResolver?.(delegation.toolName);return {resolver:this.#nativeToolResolver,...resolved};},(params, options) =>\n\t\t\t\t\t\t\tthis.invokeNativeTool(delegation.toolName, params, {",
      );
      replace(
        "callerContext: delegation.context,\n\t\t\t\t\t\t\t})",
        "callerContext: delegation.context,\n\t\t\t\t\t\t\t}))",
      );
      replace("return new Proxy(ui, {", "return t3.deriveApprovalUI(ui, new Proxy(ui, {");
      replace(
        "delegatedMethods.set(property, delegated);\n\t\t\treturn delegated;\n\t\t},\n\t});",
        "delegatedMethods.set(property, delegated);\n\t\t\treturn delegated;\n\t\t},\n\t}));",
      );
      break;
    case "tools/approval.ts":
      replace(
        "): Promise<ExtensionApprovalAnswer> {\n\tconst { reason, appendix = [], sessionSubject } = options;",
        "): Promise<ExtensionApprovalAnswer> {\n t3.assertApprovalUI(ui);\n\tconst { reason, appendix = [], sessionSubject } = options;",
      );
      break;
    case "extensibility/custom-tools/wrapper.ts":
      replace(
        "applyToolProxy(tool, this);",
        "applyToolProxy(tool, this);\n t3.registerExecutionBoundary(this,'custom',tool,()=>({target:this.tool,receiver:this.tool,execute:this.tool.execute,owner:this.getContext}));",
      );
      replace(
        "return this.tool.execute(toolCallId, params, onUpdate, context ?? this.getContext(), signal);",
        "const t3Context = context ?? this.getContext();\n const t3Call = t3.assertExecutionBoundary({adapter:this,kind:'custom',target:this.tool,params,context,derivedContext:t3Context});\n return t3Call.execute.call(t3Call.receiver,toolCallId,t3Call.input,onUpdate,t3Call.context,signal);",
      );
      break;
    case "extensibility/hooks/tool-wrapper.ts":
      replace(
        "applyToolProxy(tool, this);",
        "applyToolProxy(tool, this);\n t3.registerExecutionBoundary(this,'hook',tool,()=>({target:this.tool,receiver:this.tool,execute:this.tool.execute,owner:this.hookRunner}));",
      );
      replace(
        "const result = await this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context);",
        "const t3Call = t3.assertExecutionBoundary({adapter:this,kind:'hook',target:this.tool,params:effectiveParams,context});\n const result = await t3Call.execute.call(t3Call.receiver,toolCallId,t3Call.input,signal,onUpdate,t3Call.context);",
      );
      break;
    case "extensibility/tool-proxy.ts":
      replace("return value.bind(tool);", "return t3.bindNativeCallable(value,tool);");
      break;
    case "tools/output-meta.ts":
      replace(
        "return Object.defineProperties(tool, {",
        "const t3Wrapped = Object.defineProperties(tool, {",
      );
      replace(
        "writable: true,\n\t\t},\n\t});\n}",
        "writable: true,\n\t\t},\n\t});\n t3.registerExecutionBoundary(tool,'meta',tool,()=>({target:tool,receiver:tool,execute:tool[kUnwrappedExecute]}));\n return t3Wrapped;\n}",
      );
      replace(
        "const originalExecute = this[kUnwrappedExecute];",
        "const t3Call = t3.assertExecutionBoundary({adapter:this,kind:'meta',target:this,params,context});",
      );
      replace(
        "originalExecute.call(this, toolCallId, params, signal, onUpdate, context)",
        "t3Call.execute.call(t3Call.receiver,toolCallId,t3Call.input,signal,onUpdate,t3Call.context)",
      );
      break;
    case "sdk.ts":
      out =
        'import "./extensibility/custom-tools/wrapper";\nimport "./extensibility/hooks/tool-wrapper";\n' +
        out;
      replace(
        "execute: (toolCallId, params, signal, onUpdate, ctx) =>\n\t\t\ttool.execute(toolCallId, params, onUpdate, createCustomToolContext(ctx), signal),",
        "execute: (toolCallId, params, signal, onUpdate, ctx) => {\n const t3Context = createCustomToolContext(ctx);\n const t3Call = t3.assertExecutionBoundary({adapter:definition,kind:'sdk-custom',target:tool,params,derivedContext:t3Context});\n return t3Call.execute.call(t3Call.receiver,toolCallId,t3Call.input,onUpdate,t3Call.context,signal);\n },",
      );
      replace(
        "[TOOL_DEFINITION_MARKER]: true,\n\t};\n\treturn definition;",
        "[TOOL_DEFINITION_MARKER]: true,\n\t};\n t3.registerExecutionBoundary(definition,'sdk-custom',tool,()=>({target:tool,receiver:tool,execute:tool.execute}));\n\treturn definition;",
      );
      replace(
        "const speculativeToolExecution = createSpeculativeToolExecutionConfig(settings, toolSession, extensionRunner);",
        "const speculativeToolExecution = undefined;",
      );
      break;
    case "modes/rpc/rpc-mode.ts":
      // The public callback must attach approve to this same native UI object.
      replace(
        "setToolUIContext?.(rpcUiContext, true);",
        "setToolUIContext?.(rpcUiContext, true);\n if (!rpcUiContext.approve) throw new Error('OMP typed approval UI hook missing');",
      );
      break;
    default:
      throw new Error(`Undeclared OMP module transformation: ${name}`);
  }
  return `import * as t3 from ${JSON.stringify(hooksUrl)};\n${out}\nt3.acknowledge(${JSON.stringify(name)});\n`;
}
