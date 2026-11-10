// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";
import type { PolicyEpoch, PolicyScope } from "./policy.ts";

const epochs = new WeakMap<object, PolicyEpoch>();
const authorities = new WeakMap<object, Set<PolicyEpoch>>();
const nativeSessions = new WeakMap<
  object,
  { settings: object; cwd?: string; sessionManager: { getCwd(): string; getSessionId(): string } }
>();
const sessionManagers = new WeakMap<object, Set<PolicyEpoch>>();
const approvalUIs = new WeakMap<object, { epoch: PolicyEpoch; approve: unknown }>();
const requestContext = new NodeAsyncHooks.AsyncLocalStorage<Authorization>();
const acknowledged = new Set<string>();
type Token = Readonly<{ kind: "omp-call" }>;
type Authorization = Readonly<{ kind: "omp-authorization" }>;
interface CallState {
  epoch: PolicyEpoch;
  settings: object;
  call: { nativeCallId: string; kind: string; scope: PolicyScope };
}
interface AuthorizationState {
  call: CallState;
  subject: object;
  subjectState: ReturnType<typeof subjectState>;
  input: unknown;
  context: unknown;
  disposition: "pending" | "once" | "allow";
  ui?: { object: object; approve: unknown };
  resolveDecision: (input: unknown, context?: NativeContext) => unknown;
  decision: unknown;
  decisionCaptured: boolean;
  delegate?: NativeDelegate;
}
const tokens = new WeakMap<Token, CallState>();
const authorizations = new WeakMap<Authorization, AuthorizationState>();

export function acknowledge(name: string) {
  acknowledged.add(name);
}
export function assertAcknowledged(names: readonly string[]) {
  for (const name of names)
    if (!acknowledged.has(name)) throw new Error(`Missing OMP guard acknowledgement: ${name}`);
}
export function registerEpoch(epoch: PolicyEpoch) {
  epochs.get(epoch.settings)?.invalidate("settings identity replaced");
  epochs.set(epoch.settings, epoch);
  const set = authorities.get(epoch.authority) ?? new Set<PolicyEpoch>();
  set.add(epoch);
  authorities.set(epoch.authority, set);
}
export function invalidateSettings(settings: object, reason: string) {
  epochs.get(settings)?.invalidate(reason);
  for (const epoch of authorities.get(settings) ?? []) epoch.invalidate(reason);
}
export function settingChanged(settings: object, id: string) {
  if (
    id.startsWith("tools.approval") ||
    id.startsWith("tools.restricted") ||
    Object.hasOwn(policyKeys, id)
  ) {
    invalidateSettings(settings, `native setting changed: ${id}`);
  }
}
const policyKeys = {
  "async.enabled": true,
  "bash.autoBackground.enabled": true,
  "eval.autoBackground.enabled": true,
  "launch.enabled": true,
  "task.maxRecursionDepth": true,
  "tools.speculativeExecution.enabled": true,
  "task.speculativeLaunch": true,
};

function assertLiveEpoch(epoch: PolicyEpoch, settings: object) {
  epoch.assert();
  const session = nativeSessions.get(epoch);
  if (
    session &&
    (session.settings !== settings ||
      (session.cwd !== undefined && NodePath.resolve(session.cwd) !== epoch.scope.cwd) ||
      NodePath.resolve(session.sessionManager.getCwd()) !== epoch.scope.cwd ||
      session.sessionManager.getSessionId() !== epoch.scope.session)
  )
    throw new Error("OMP native session scope changed");
}
export function enterNativeCall(
  settings: object,
  call: { nativeCallId: string; kind: string; scope: PolicyScope },
): Token {
  const epoch = epochs.get(settings);
  if (!epoch) throw new Error("OMP unregistered settings");
  assertLiveEpoch(epoch, settings);
  if (!NodeUtil.isDeepStrictEqual(epoch.scope, call.scope)) throw new Error("OMP scope changed");
  const token = Object.freeze({ kind: "omp-call" } as const);
  tokens.set(token, { epoch, settings, call: structuredClone(call) });
  return token;
}

function plainSubjectState(subject: object) {
  const value = subject as {
    name?: unknown;
    approval?: unknown;
    legacyName?: unknown;
    approvalRestrictionPaths?: unknown;
    approvalCacheTargets?: unknown;
    formatApprovalDetails?: unknown;
    execute?: unknown;
    invoke?: unknown;
  };
  return {
    data: owned({
      name: value.name,
      legacyName: value.legacyName,
      approval: typeof value.approval === "function" ? undefined : value.approval,
    }),
    approvalCallable: typeof value.approval === "function" ? value.approval : undefined,
    approvalRestrictionPaths: value.approvalRestrictionPaths,
    approvalCacheTargets: value.approvalCacheTargets,
    formatApprovalDetails: value.formatApprovalDetails,
    execute: value.execute,
    invoke: value.invoke,
  };
}
type Boundary = { target: object; receiver: object; execute: unknown; owner?: object };
type BoundarySnapshot = Boundary & {
  adapter: object;
  kind: string;
  adapterId: symbol;
  targetId: symbol;
  receiverId: symbol;
  ownerId: symbol | undefined;
};
const executionBoundaries = new WeakMap<
  object,
  Map<string, { initialTarget: object; read: () => Boundary }>
>();
const objectIdentities = new WeakMap<object, symbol>();
const boundCallables = new WeakMap<
  object,
  WeakMap<(...args: never[]) => unknown, (...args: never[]) => unknown>
>();
function identity(value: object) {
  let id = objectIdentities.get(value);
  if (!id) {
    id = Symbol();
    objectIdentities.set(value, id);
  }
  return id;
}
export function bindNativeCallable(value: (...args: never[]) => unknown, receiver: object) {
  let methods = boundCallables.get(receiver);
  if (!methods) {
    methods = new WeakMap();
    boundCallables.set(receiver, methods);
  }
  let bound = methods.get(value);
  if (!bound) {
    bound = value.bind(receiver);
    methods.set(value, bound);
  }
  return bound;
}
export function registerExecutionBoundary(
  adapter: object,
  kind: string,
  target: object,
  read: () => Boundary,
) {
  const entries = executionBoundaries.get(adapter) ?? new Map();
  if (entries.has(kind)) throw new Error("OMP native execution boundary already registered");
  entries.set(kind, { initialTarget: target, read });
  executionBoundaries.set(adapter, entries);
}
function subjectState(subject: object) {
  const nodes: Array<{ identity: symbol; subject: ReturnType<typeof plainSubjectState> }> = [];
  const boundaries: BoundarySnapshot[] = [];
  const seen = new Set<object>();
  const visit = (value: object): void => {
    if (seen.has(value)) return;
    seen.add(value);
    nodes.push({ identity: identity(value), subject: plainSubjectState(value) });
    for (const [kind, entry] of executionBoundaries.get(value) ?? []) {
      const boundary = entry.read();
      if (boundary.target !== entry.initialTarget || typeof boundary.execute !== "function")
        throw new Error("OMP native adapter target changed; recreate adapter");
      boundaries.push({
        ...boundary,
        adapter: value,
        kind,
        adapterId: identity(value),
        targetId: identity(boundary.target),
        receiverId: identity(boundary.receiver),
        ownerId: boundary.owner ? identity(boundary.owner) : undefined,
      });
      if (boundary.target !== value) visit(boundary.target);
    }
  };
  visit(subject);
  return { nodes, boundaries };
}

function owned(value: unknown): unknown {
  return structuredClone(value);
}
// The agent loop's ToolCallContext carries a live steering AbortSignal and context
// sink; they stay shared by reference and are compared by identity, not cloned.
function isLiveChannel(value: unknown): value is object {
  return typeof value === "function" || value instanceof AbortSignal;
}
const liveChannelIds = new WeakMap<object, number>();
let liveChannelCount = 0;
function liveChannelId(value: object) {
  let id = liveChannelIds.get(value);
  if (id === undefined) {
    id = ++liveChannelCount;
    liveChannelIds.set(value, id);
  }
  return id;
}
function ownedToolCall<T extends object | undefined>(toolCall: T): T {
  return (
    toolCall &&
    (Object.fromEntries(
      Object.entries(toolCall).map(([key, value]) => [
        key,
        isLiveChannel(value) ? value : owned(value),
      ]),
    ) as T)
  );
}
function toolCallState(toolCall: object | undefined) {
  return (
    toolCall &&
    Object.fromEntries(
      Object.entries(toolCall).map(([key, value]) => [
        key,
        isLiveChannel(value) ? { live: liveChannelId(value) } : { data: owned(value) },
      ]),
    )
  );
}
export function captureAuthorization(
  token: Token,
  input: {
    subject: object;
    effectiveInput: unknown;
    executionContext: unknown;
    disposition: "pending" | "once" | "allow";
    resolveDecision: (input: unknown, context?: NativeContext) => unknown;
    decision?: unknown;
  },
): Authorization {
  const call = tokens.get(token);
  if (!call) throw new Error("OMP invalid call token");
  assertLiveEpoch(call.epoch, call.settings);
  tokens.delete(token);
  const authorization = Object.freeze({ kind: "omp-authorization" } as const);
  const delegate = delegateInvocation.getStore();
  authorizations.set(authorization, {
    call,
    subject: input.subject,
    subjectState: subjectState(input.subject),
    input: owned(input.effectiveInput),
    context: owned(input.executionContext),
    disposition: input.disposition,
    resolveDecision: input.resolveDecision,
    decision: Object.hasOwn(input, "decision") ? ownDecision(input.decision) : undefined,
    decisionCaptured: Object.hasOwn(input, "decision"),
    ...(delegate?.resolution.tool === input.subject ? { delegate } : {}),
  });
  return authorization;
}
function ownDecision(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    !("mode" in value) ||
    !["always-ask", "write", "yolo"].includes(String(value.mode)) ||
    !("decision" in value) ||
    typeof value.decision !== "object" ||
    value.decision === null ||
    !("policy" in value.decision) ||
    !["allow", "prompt", "deny"].includes(String(value.decision.policy)) ||
    !("tier" in value.decision) ||
    !["read", "write", "exec"].includes(String(value.decision.tier))
  )
    throw new Error("OMP invalid policy resolution");
  return owned(value);
}
export function capturePolicyDecision(decision: unknown) {
  const auth = requestContext.getStore();
  const state = auth && authorizations.get(auth);
  if (!state || state.decisionCaptured)
    throw new Error("OMP policy resolution is unregistered or already captured");
  assertLiveEpoch(state.call.epoch, state.call.settings);
  state.decision = ownDecision(decision);
  state.decisionCaptured = true;
}
export function finalizeAuthorization(auth: Authorization, disposition: "once" | "allow") {
  const state = authorizations.get(auth);
  if (!state || state.disposition !== "pending")
    throw new Error("OMP invalid authorization disposition");
  assertLiveEpoch(state.call.epoch, state.call.settings);
  state.disposition = disposition;
}
interface InvocationInput {
  settings: object;
  subject: object;
  effectiveInput: unknown;
  executionContext: unknown;
  scope: PolicyScope;
}
function assertAuthorization(
  state: AuthorizationState,
  input: InvocationInput,
  context?: NativeContext,
) {
  if (state.delegate) assertNativeDelegate(state.delegate, false);
  assertLiveEpoch(state.call.epoch, input.settings);
  if (!state.decisionCaptured) throw new Error("OMP missing authorized policy resolution");
  const decision = ownDecision(state.resolveDecision(input.effectiveInput, context));
  assertLiveEpoch(state.call.epoch, input.settings);
  if (
    epochs.get(input.settings) !== state.call.epoch ||
    input.settings !== state.call.settings ||
    state.subject !== input.subject ||
    !NodeUtil.isDeepStrictEqual(state.subjectState, subjectState(input.subject)) ||
    state.disposition === "pending" ||
    !NodeUtil.isDeepStrictEqual(state.decision, decision) ||
    !NodeUtil.isDeepStrictEqual(input.scope, state.call.call.scope) ||
    !NodeUtil.isDeepStrictEqual(input.effectiveInput, state.input) ||
    !NodeUtil.isDeepStrictEqual(input.executionContext, state.context)
  )
    throw new Error("OMP authorized input/context/scope changed");
  if (
    state.ui &&
    (approvalUIs.get(state.ui.object)?.epoch !== state.call.epoch ||
      (state.ui.object as { approve?: unknown }).approve !== state.ui.approve)
  )
    throw new Error("OMP registered approval UI changed");
  if (state.delegate) assertNativeDelegate(state.delegate, false);
}

export function assertBeforeInvoke(
  auth: Authorization,
  input: InvocationInput,
  context?: NativeContext,
) {
  const state = authorizations.get(auth);
  if (!state) throw new Error("OMP invalid authorization");
  assertAuthorization(state, input, context);
  authorizations.delete(auth);
  return owned(state.input);
}
interface NativeInvocation {
  state: AuthorizationState;
  input: InvocationInput;
  context: NativeContext | undefined;
  consumed: Set<BoundarySnapshot>;
  active: boolean;
  owner: NativeScope;
}
const nativeInvocation = new NodeAsyncHooks.AsyncLocalStorage<NativeInvocation>();
export function invokeAuthorizedTool<T>(
  auth: Authorization,
  input: InvocationInput,
  context: NativeContext | undefined,
  owner: NativeScope,
  invoke: (
    execute: (...args: unknown[]) => Promise<T>,
    receiver: object,
    params: unknown,
    context: NativeContext | undefined,
  ) => Promise<T>,
): Promise<T> {
  const state = authorizations.get(auth);
  if (!state) throw new Error("OMP invalid authorization");
  const ownedContext = ownedNativeContext(context);
  const execute = (input.subject as { execute?: unknown }).execute;
  if (typeof execute !== "function" || execute !== state.subjectState.nodes[0]?.subject.execute)
    throw new Error("OMP native execution target changed");
  const params = assertBeforeInvoke(
    auth,
    {
      ...input,
      executionContext: nativeContext(input.settings, owner, ownedContext),
      scope: nativeScope(input.settings as NativeSettings, owner),
    },
    ownedContext,
  );
  const invocation: NativeInvocation = {
    state,
    input,
    context: ownedContext,
    consumed: new Set(),
    active: true,
    owner,
  };
  try {
    return nativeInvocation
      .run(invocation, () =>
        invoke(execute as (...args: unknown[]) => Promise<T>, input.subject, params, ownedContext),
      )
      .finally(() => {
        invocation.active = false;
      });
  } catch (error) {
    invocation.active = false;
    throw error;
  }
}

function ownedExecutionContext(context: object | undefined): object | undefined {
  if (!context) return context;
  const descriptors = Object.getOwnPropertyDescriptors(context);
  for (const key of ["toolCall", "acpApprovedArgs"]) {
    const descriptor = descriptors[key];
    if (descriptor && "value" in descriptor)
      descriptors[key] = {
        ...descriptor,
        value: key === "toolCall" ? ownedToolCall(descriptor.value) : owned(descriptor.value),
      };
  }
  return Object.create(Object.getPrototypeOf(context), descriptors);
}
export function assertExecutionBoundary(options: {
  adapter: object;
  kind: string;
  target: object;
  params: unknown;
  context?: NativeContext;
  owner?: NativeScope;
  derivedContext?: object;
}) {
  const invocation = nativeInvocation.getStore();
  if (!invocation?.active) throw new Error("OMP native adapter invocation is not authorized");
  const { state } = invocation;
  const bound = state.subjectState.boundaries.find(
    (boundary) => boundary.adapter === options.adapter && boundary.kind === options.kind,
  );
  if (!bound || invocation.consumed.has(bound) || bound.target !== options.target)
    throw new Error("OMP native execution target is not authorized");
  const settings = state.call.settings as NativeSettings;
  const owner = options.owner ?? {
    cwd: state.call.call.scope.cwd,
    sessionId: state.call.call.scope.session,
    sessionSettings: settings,
  };
  const context = options.context ?? invocation.context;
  const derived = options.derivedContext as
    | {
        settings?: object;
        cwd?: string;
        sessionManager?: { getSessionId?: () => string; getCwd?: () => string };
      }
    | undefined;
  if (
    derived &&
    (("settings" in derived && derived.settings !== settings) ||
      (derived.cwd !== undefined && NodePath.resolve(derived.cwd) !== state.call.call.scope.cwd) ||
      (derived.sessionManager?.getSessionId &&
        derived.sessionManager.getSessionId() !== state.call.call.scope.session) ||
      (derived.sessionManager?.getCwd &&
        NodePath.resolve(derived.sessionManager.getCwd()) !== state.call.call.scope.cwd))
  )
    throw new Error("OMP native execution context changed");
  if (
    derived &&
    "toolCall" in derived &&
    !NodeUtil.isDeepStrictEqual(
      toolCallState(derived.toolCall as object | undefined),
      toolCallState(context?.toolCall),
    )
  )
    throw new Error("OMP native execution metadata changed");
  const outputContext = ownedExecutionContext(options.derivedContext ?? context);
  assertAuthorization(
    state,
    {
      ...invocation.input,
      effectiveInput: options.params,
      executionContext: nativeContext(settings, owner, context),
      scope: nativeScope(settings, owner),
    },
    context,
  );
  if (options.kind === "registered" && outputContext && "invokeTool" in outputContext) {
    const delegate = nativeDelegates.get(outputContext.invokeTool as object);
    if (delegate) {
      if (
        delegate.parent ||
        delegate.name !== (bound.target as { name?: unknown }).name ||
        delegate.context !== context
      )
        throw new Error("OMP native delegation context changed");
      assertDelegateScope(delegate, invocation);
      delegate.parent = invocation;
    }
  }
  invocation.consumed.add(bound);
  return {
    execute: bound.execute as (...args: unknown[]) => unknown,
    receiver: bound.receiver,
    input: owned(state.input),
    context: outputContext,
  };
}

interface DelegateResolution {
  resolver: object | undefined;
  tool?: object;
  makeContext?: () => NativeContext;
}
interface NativeDelegate {
  owner: NativeScope;
  name: string;
  context: NativeContext | undefined;
  read: () => DelegateResolution;
  resolution: DelegateResolution & { tool: object };
  subject: ReturnType<typeof subjectState>;
  parent?: NativeInvocation;
}
const nativeDelegates = new WeakMap<object, NativeDelegate>();
const delegateInvocation = new NodeAsyncHooks.AsyncLocalStorage<NativeDelegate>();
export function bindNativeDelegation<TOptions, TResult>(
  owner: NativeScope,
  name: string,
  context: NativeContext | undefined,
  read: () => DelegateResolution,
  invoke: (params: unknown, options: TOptions) => Promise<TResult>,
) {
  const resolution = read();
  if (!resolution.tool) throw new Error("OMP native delegation target missing");
  const delegate: NativeDelegate = {
    owner,
    name,
    context,
    read,
    resolution: { ...resolution, tool: resolution.tool },
    subject: subjectState(resolution.tool),
  };
  const bound = (params: unknown, options: TOptions) => {
    assertNativeDelegate(delegate);
    return delegateInvocation.run(delegate, () => invoke(params, options));
  };
  nativeDelegates.set(bound, delegate);
  return bound;
}
function assertDelegateScope(delegate: NativeDelegate, parent: NativeInvocation) {
  const settings = parent.state.call.settings as NativeSettings;
  if (
    !NodeUtil.isDeepStrictEqual(nativeScope(settings, delegate.owner), parent.state.call.call.scope)
  )
    throw new Error("OMP native delegation scope changed");
  const context = nativeContext(settings, delegate.owner, delegate.context);
  if (!NodeUtil.isDeepStrictEqual(context, parent.state.context))
    throw new Error("OMP native delegation context changed");
}
function assertNativeDelegate(delegate: NativeDelegate, requireParent = true) {
  const parent = delegate.parent;
  if (!parent?.active || (requireParent && nativeInvocation.getStore() !== parent))
    throw new Error("OMP native delegation invocation is not authorized");
  assertDelegateScope(delegate, parent);
  assertAuthorization(
    parent.state,
    {
      ...parent.input,
      effectiveInput: parent.state.input,
      executionContext: nativeContext(parent.state.call.settings, parent.owner, parent.context),
      scope: nativeScope(parent.state.call.settings as NativeSettings, parent.owner),
    },
    parent.context,
  );
  const current = delegate.read();
  if (
    current.resolver !== delegate.resolution.resolver ||
    current.tool !== delegate.resolution.tool ||
    !current.tool ||
    !NodeUtil.isDeepStrictEqual(subjectState(current.tool), delegate.subject)
  )
    throw new Error("OMP native delegation target changed");
  assertLiveEpoch(parent.state.call.epoch, parent.state.call.settings);
  return parent;
}
export function invokeNativeDelegation<TResult>(
  owner: NativeScope,
  name: string,
  resolved: { tool: object; makeContext: () => NativeContext },
  callerContext: NativeContext | undefined,
  invoke: (tool: object, runner: NativeScope, context: NativeContext) => Promise<TResult>,
) {
  const delegate = delegateInvocation.getStore();
  if (
    !delegate ||
    delegate.owner !== owner ||
    delegate.name !== name ||
    resolved.tool !== delegate.resolution.tool ||
    callerContext !== delegate.context
  )
    throw new Error("OMP unrecognized native delegation");
  const parent = assertNativeDelegate(delegate);
  const context = ownedNativeContext(callerContext ?? delegate.resolution.makeContext?.());
  if (!context) throw new Error("OMP native delegation context missing");
  const executionContext = nativeContext(parent.state.call.settings, owner, context);
  if (
    executionContext.session !== parent.state.call.call.scope.session ||
    (context.sessionManager?.getCwd &&
      NodePath.resolve(context.sessionManager.getCwd()) !== parent.state.call.call.scope.cwd)
  )
    throw new Error("OMP native delegation context scope changed");
  assertNativeDelegate(delegate);
  return invoke(delegate.resolution.tool, parent.owner, context);
}

export function withAuthorization<T>(auth: Authorization, f: () => T): T {
  return requestContext.run(auth, f);
}
export function currentAuthorization() {
  const auth = requestContext.getStore();
  const state = auth && authorizations.get(auth);
  if (!state) throw new Error("OMP approval without registered authorization");
  assertLiveEpoch(state.call.epoch, state.call.settings);
  return Object.freeze({
    providerSession: state.call.epoch.scope.providerSession,
    nativeCallId: state.call.call.nativeCallId,
    epoch: state.call.epoch.id,
    session: state.call.epoch.scope.session,
  });
}

interface NativeSettings {
  getCwd(): string;
  getAgentDir(): string;
}
interface NativeScope {
  cwd: string;
  sessionId?: string;
  settings?: object;
  sessionSettings?: object;
}
interface NativeContext {
  settings?: object;
  autoApprove?: boolean;
  sessionManager?: { getSessionId(): string; getCwd?(): string };
  toolCall?: { providerMetadata?: unknown };
  xdevPolicyKey?: string;
  acpApprovedArgs?: unknown;
  providerSafetyApproved?: boolean;
}
export function nativeScope(settings: NativeSettings, owner: NativeScope): PolicyScope {
  const epoch = epochs.get(settings);
  if (!epoch) throw new Error("OMP unregistered settings");
  return {
    ...epoch.scope,
    cwd: NodePath.resolve(owner.cwd),
    agentDir: NodePath.resolve(settings.getAgentDir()),
    session: owner.sessionId ?? epoch.scope.session,
  };
}
export function nativeContext(
  settings: object,
  owner: NativeScope,
  context: NativeContext | undefined,
) {
  if (context?.autoApprove) throw new Error("OMP native autoApprove is forbidden");
  if (
    (context !== undefined && context.settings !== settings) ||
    (owner.settings && owner.settings !== settings) ||
    (owner.sessionSettings && owner.sessionSettings !== settings)
  )
    throw new Error("OMP settings identity changed");
  const managerCwd = context?.sessionManager?.getCwd?.();
  const contextCwd = managerCwd === undefined ? undefined : NodePath.resolve(managerCwd);
  if (contextCwd !== undefined && contextCwd !== epochs.get(settings)?.scope.cwd)
    throw new Error("OMP native context cwd changed");
  return {
    cwd: owner.cwd,
    contextCwd,
    session: context?.sessionManager?.getSessionId() ?? owner.sessionId,
    metadata: toolCallState(context?.toolCall),
    xdevPolicyKey: context?.xdevPolicyKey,
    acpApprovedArgs: context?.acpApprovedArgs,
  };
}
export function scopeTransition(settings: object) {
  invalidateSettings(settings, "native scope transition");
}
export function denyHelper(name: string) {
  if (
    ["__completion__", "__judge__", "__judge_batch__", "__agent__", "__workpool__"].includes(name)
  )
    throw new Error("T3_NATIVE_HELPER_DISABLED");
}

export function ownedNativeContext<T extends NativeContext | undefined>(context: T): T {
  if (!context) return context;
  return {
    ...context,
    ...(context.toolCall ? { toolCall: ownedToolCall(context.toolCall) } : {}),
    ...(Object.hasOwn(context, "acpApprovedArgs")
      ? { acpApprovedArgs: structuredClone(context.acpApprovedArgs) }
      : {}),
  };
}

export function registerNativeSession(
  epoch: PolicyEpoch,
  session: {
    settings: object;
    cwd?: string;
    sessionManager: { getCwd(): string; getSessionId(): string };
  },
) {
  nativeSessions.set(epoch, session);
  const registered = sessionManagers.get(session.sessionManager) ?? new Set<PolicyEpoch>();
  registered.add(epoch);
  sessionManagers.set(session.sessionManager, registered);
}
export function sessionManagerTransition(manager: object) {
  for (const epoch of sessionManagers.get(manager) ?? [])
    epoch.invalidate("native session manager transition");
}
export function nativeSignal(token: Token, signal?: AbortSignal) {
  const state = tokens.get(token);
  if (!state) throw new Error("OMP invalid call token");
  return signal ? AbortSignal.any([signal, state.epoch.signal]) : state.epoch.signal;
}

export function unregisterEpoch(epoch: PolicyEpoch) {
  if (epochs.get(epoch.settings) === epoch) epochs.delete(epoch.settings);
  authorities.get(epoch.authority)?.delete(epoch);
  const session = nativeSessions.get(epoch);
  if (session) sessionManagers.get(session.sessionManager)?.delete(epoch);
  nativeSessions.delete(epoch);
}

export function registerApprovalUI(epoch: PolicyEpoch, ui: { approve?: unknown }) {
  if (typeof ui.approve !== "function") throw new Error("OMP typed approval callback missing");
  approvalUIs.set(ui, { epoch, approve: ui.approve });
}
export function assertApprovalUI(ui: { approve?: unknown }) {
  const auth = requestContext.getStore();
  const state = auth && authorizations.get(auth);
  const registered = approvalUIs.get(ui);
  if (
    !state ||
    !registered ||
    registered.epoch !== state.call.epoch ||
    registered.approve !== ui.approve ||
    typeof ui.approve !== "function" ||
    (state.ui && state.ui.object !== ui)
  )
    throw new Error("OMP unregistered approval UI");
  assertLiveEpoch(state.call.epoch, state.call.settings);
  state.ui = { object: ui, approve: ui.approve };
}

export function deriveApprovalUI<T extends { approve?: unknown }>(
  parent: { approve?: unknown },
  derived: T,
): T {
  const source = approvalUIs.get(parent);
  if (source && source.approve === parent.approve && typeof derived.approve === "function")
    approvalUIs.set(derived, { epoch: source.epoch, approve: derived.approve });
  return derived;
}
