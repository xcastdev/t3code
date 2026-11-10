Github Tracked: false
Status: blocked
Github Issue: none

# Native OMP support

## Problem and desired outcome

Use OMP as a first-party T3 Code provider without ACP. Preserve OMP's foreground coding tools, native conversation history and foreground Python/JavaScript eval. T3 owns detached agents and persistent shell work through its existing delegation and PTY tools.

Use Pi's native integration as the implementation reference where behavior matches. OMP needs a separate provider identity and protocol handling. This spec replaces the earlier proposal for native OMP background-job controls and an upstream OMP extension API addition.

## Confirmed baseline

Source review used [OMP 33ea58aa](https://github.com/can1357/oh-my-pi/tree/33ea58aa7dfd696c1ac419ba51fb915660740ab2), package version 18.16.0, and [Pi 80f7a114](https://github.com/earendil-works/pi/tree/80f7a11494e7e593d13749b867e66701eed94aaf). These are source findings, not runtime acceptance evidence.

- OMP offers native JSONL RPC and `rpc-ui` for builtin tool dialogs. It differs from Pi in framing, command discovery, history payloads and turn completion.
- `prompt_result` correlates a prompt's yield; `session_settled` signals quiescence. OMP does not emit Pi's `agent_settled` event.
- OMP supports per-launch configuration overlays and explicit extension loading. T3 can apply its own policy without editing normal OMP configuration.
- Native task spawning is gated by `task.maxRecursionDepth`. Zero removes the native task tool and rejects native eval spawning through the shared depth guard.
- Eval exposes code execution, ordinary tool calls, native agent helpers, separate model-call helpers and structured live output. Disabling native spawning does not disable completion/judgment helpers.
- Native Python/JS execution now confirms that async/spawn settings and tools.approval deny entries do not block completion/judgment helpers. OMP public extension hooks alone do not intercept these helpers. The selected T3-owned Bun loader inserts guards during module loading, preserving full native eval and leaving installed files unchanged. Full native eval is required; a T3-owned rewrite and thin PTY replacement are excluded.

References: [RPC dialect differences](https://github.com/can1357/oh-my-pi/blob/33ea58aa7dfd696c1ac419ba51fb915660740ab2/docs/rpc.md#L1035-L1071), [eval reference](https://github.com/can1357/oh-my-pi/blob/33ea58aa7dfd696c1ac419ba51fb915660740ab2/docs/tools/eval.md), [spawn guard](https://github.com/can1357/oh-my-pi/blob/33ea58aa7dfd696c1ac419ba51fb915660740ab2/packages/coding-agent/src/task/structured-subagent.ts#L324-L335).

## Scope

In scope:

- A native OMP provider, separate from Pi, with a configurable binary path and launch arguments.
- Native model/reasoning and command discovery, assistant/reasoning/tool streaming, usage/context reporting, native todos, questions and T3 permission modes.
- Native session resume, history, rollback and forks, with same-instance continuation and portable provider handoff.
- OMP-owned foreground coding tools, including hashline edits and supported LSP/browser tools.
- Foreground Python/JavaScript eval with live output and terminal-style input/output presentation.
- T3-owned delegation for detached agents and T3-owned PTY terminals for persistent commands and services.
- Per-launch policy that disables native background execution, native subagents and eval model-call helpers only in T3-launched sessions.
- A version-checked T3-owned SDK launcher and Bun loader plugin, including execution-boundary guards for permission lifecycle. Only the identified compatibility transformations are permitted; no installed-file edits or arbitrary runtime patching.
- Web, desktop and mobile behavior, including local and remote connections.

Out of scope:

- OMP upstream changes, a maintained OMP fork, or modifications to the installed OMP package.
- Native OMP subagent cards, control APIs and transcript drill-down; T3 child threads provide this workflow instead.
- Native OMP background-job listing/cancellation or the previously proposed job-control bridge.
- Terminal widgets, live microphone features, advisor/goal/side-question product surfaces and interactive-only crash restoration.
- Importing arbitrary pre-existing OMP sessions into T3's session browser in the first implementation. Native sessions created by T3 must resume normally.
- Automatic migration or removal of existing ACP provider configurations.

## Execution policy

Apply a temporary launch configuration with:

- `async.enabled: false`
- `bash.autoBackground.enabled: false`
- `eval.autoBackground.enabled: false`
- `launch.enabled: false`
- `task.maxRecursionDepth: 0`

These are separate settings; disabling async alone does not disable every auto-background path. Keep foreground native bash for short commands and foreground eval for computation. Direct persistent commands and services to T3's PTY tools. Direct delegation to T3's existing delegation tools, including child-thread lifecycle, isolation and completion handling.

Disable `completion()`, `judge()`, Python `judge_batch()` and JavaScript `judgeBatch()`, including allocation and batch attachment paths. Removing their documentation is insufficient: calls must not initiate model requests or host-owned judgment batches. Cover both runtimes, retained kernels, resets and stale references. Keep ordinary permitted session-tool calls available from eval.

Do not depend on model instructions alone for these restrictions. Reconcile effective policy with user launch arguments and project configuration. Extensions used by T3 must be loaded explicitly for its process, with session-scoped credentials and cleanup, rather than installed into ambient OMP extension directories.

Use a T3-owned SDK launcher with a Bun preload/onLoad plugin registered before OMP imports. The loader adds narrowly defined helper and permission guards to verified native modules in memory. Fail startup on an unsupported package layout, runtime, source fingerprint, transformation count or missing hook acknowledgement. This selected compatibility shim is the explicit exception to the earlier public-OMP-API-only restriction. Preserve the native evaluator, kernels, helpers other than the disabled families, rich outputs and streaming. OMP upstream and installed package files remain untouched.

This policy controls OMP-provided execution features; it does not introduce an OS sandbox or attempt to prevent arbitrary code from launching processes independently.

## Eval presentation

- Card heading: use `args.title`, then the cell title, with a language-based fallback such as "Python eval" or "JavaScript eval". Do not generate a summary through another model request.
- Live secondary status: the latest `phase` event's `title`. Put `log` event messages in the expandable execution body, separate from program output.
- Input and output: separate, labeled dark terminal-style panes with monospace text, preserved whitespace, bounded scrolling and language-aware highlighting for read-only input code.
- Streaming: consume `tool_execution_update.partialResult` during foreground execution. Treat output as snapshots/tails where appropriate rather than duplicating each snapshot by appending it.
- Scrolling: follow new output only while the user is at the bottom; preserve manual scroll position when reading earlier output.
- Completion: show lifecycle state and available duration/exit information. Make failures and cancellation visible. Preserve truncation notices and access to full artifact output.
- Images: show as execution attachments. Preserve structured view data, but terminal text is the initial output presentation rather than replacing it with tables or JSON trees.
- Performance: bounded live output and coalesced updates; no continuously repainting cursor or animation. Terminal styling does not imply eval uses a PTY.

The relevant payload contains cell `title`, `code`, `language`, `output`, `status`, optional `durationMs`, `exitCode`, views and status events. Status events include `{ op: "phase", title }` and `{ op: "log", message }`. There is no dedicated generated summary field. See [eval rendering contracts](https://github.com/can1357/oh-my-pi/blob/33ea58aa7dfd696c1ac419ba51fb915660740ab2/packages/tui/src/tools/eval.ts#L61-L143).

## Preserved invariants

- Ordinary OMP launches retain their normal configuration and available features.
- Pi and existing ACP integrations continue to work independently.
- Environment-local execution, destination permission checks and session ownership remain authoritative. Do not bake local origins into clients.
- T3 delegation and terminals use the existing services and lifecycle paths. Browser disconnection does not itself cancel detached work.
- OMP's native tool results remain available even when a tool has no specialized T3 renderer.
- Mounted `xd://` tool invocation through write must not be misclassified as a harmless file edit for approval purposes.
- History, usage and model payloads are decoded as OMP data; compatibility with Pi's common structure does not imply identical schemas.

## Acceptance criteria

- [ ] AC-1: OMP is selectable and configurable as a native provider on web, desktop and mobile without requiring ACP. Missing or incompatible executables produce actionable status.
- [ ] AC-2: OMP's discovered models, supported reasoning choices and workspace commands are available. Existing OMP authentication/configuration are respected subject to the explicit T3 execution policy.
- [ ] AC-3: Text, reasoning, tool output and final results stream correctly. RPC request correlation, protocol negotiation, chunk reassembly and bounded output handle malformed/oversized data safely.
- [ ] AC-4: Prompt admission, yield, queue handling, interrupt and session settlement reflect OMP's lifecycle, without relying on Pi-only completion events or completing a turn prematurely.
- [ ] AC-5: T3-launched OMP sessions cannot use OMP-managed async bash/task/eval, automatic backgrounding or managed services through the native feature paths. Persistent shell work uses T3 PTY tools with existing output, stop and completion behavior.
- [ ] AC-6: Native task and eval agent/workpool spawning are unavailable and rejected at execution. T3 delegation creates normal durable child threads with existing lifecycle controls and isolation support.
- [ ] AC-7: Completion and judgment helpers cannot initiate model requests or batches, including through retained references or after an eval reset. Foreground Python/JavaScript and permitted tool calls remain functional.
- [ ] AC-8: No global/project OMP configuration or installed package is modified to enforce T3 policy. A normal OMP run is unaffected. Effective settings and launch overrides cannot silently re-enable restricted native features.
- [ ] AC-9: Eval displays the supplied short title and latest phase, with readable fallback when absent. Input and live output use dark terminal-style panes; logs remain distinguishable from program output.
- [ ] AC-10: Eval output does not duplicate snapshots, remains bounded and preserves manual scrolling. Images, truncation/full output access, successful completion, errors and cancellation remain visible.
- [ ] AC-11: Questions and tool approval requests use T3's existing interactions. Enforcement honors the selected permission mode, including mounted-tool invocations, and does not advertise unsupported capabilities.
- [ ] AC-12: Native session resume, history, rollback and forks preserve the correct branch and workspace. Usage/context and todos update without duplicated accounting or a second synthetic checklist.
- [ ] AC-13: Local and remote clients can operate the provider and T3-owned detached work on the destination environment, subject to existing T3 tool grants and full-access/default PTY requirements. Existing Pi/ACP behavior is preserved.
- [ ] AC-14: T3 loads only a recognized OMP compatibility recipe, confirms every required guard before admitting turns, and refuses missing/changed hooks or unknown settings identities. Normal OMP launches and installed package files are unchanged. Pending approvals from old policy epochs cannot authorize execution after revocation, mode change, restart or settings replacement.

## Decisions and assumptions

- Local work record; GitHub tracking was not requested.
- Implementation decision approved by the maintainer: add a typed `provider-output-artifact { threadId, turnItemId, artifactId }` asset resource because the assumed native artifact resolver does not exist. Resolve decimal IDs through persisted OMP item/session ownership in the destination environment; bind signed downloads to verified file identity. No caller paths, native registry fallback or arbitrary URI dispatch.
- Default provider executable is `omp`. Use `/home/user/.local/share/bun/bin/omp` for this machine's verification; never hardcode that user path into shipped defaults.
- Reuse Pi's proven process ownership, correlation and history patterns where appropriate. Keep OMP's protocol differences explicit rather than creating a broad dialect framework in advance.
- The selected mechanism is a T3-owned Bun loader and native SDK launcher. Native foreground eval is retained; only the denied helpers and stale/unregistered permission executions are rejected.
- Terminal details and fallback labels above are implementation defaults consistent with the approved visual direction. Dark mode applies to every preview and evidence capture.

## Material risks and open technical questions

- The loader depends on native module layout and guarded source content. Supported source-bearing npm installations are the first target; compiled-only installations are unsupported until a reviewed compatibility recipe exists. Reject them without changing or reinstalling the user installation.
- Launch overlays alone are mutable. Use authoritative policy epochs, synchronous admission invalidation and final native execution-boundary guards. Settings clones do not inherit listeners and must not execute until registered.
- T3 tool exposure must work through OMP's actual mounted-tool inventory and preserve permission/catalog updates. The native host-tool protocol is a candidate, not proven integration evidence.
- The supplied OMP executable works with isolated configuration: `omp/18.16.0`. Removing inherited `PI_CODING_AGENT_DIR` alone also resolves the earlier silent startup failure. Preserve intentionally configured per-instance agent directories; do not treat the harness environment as the intended user installation configuration.
- No product implementation, paid model turns or integrated client verification has run. Native helper-loader, fresh-policy and SDK approval mechanism proofs have run; the permission execution-boundary loader still needs a failing/passing native test.

## Validation expectations

Use focused behavior tests for protocol/lifecycle, policy enforcement, model-request rejection, session ancestry and usage. Extend existing tests at the lowest relevant layer. Verify terminal delegation and completion through existing service paths. Run one integrated client pass after implementation and capture visual evidence in dark mode. Follow repository requirements for changed-file checks; do not run repo-wide suites.

## Outcome

Spec and full plan updated for the selected loader-based design. Both requested fresh adversarial reviews completed; six source-verified findings were incorporated in the plan. Native helper blocking has a passing per-process loader proof; permission data and SDK UI mechanisms have focused proofs. Native permission-loader lifecycle enforcement is designed but unproven. Product implementation has not started; P1 native tests remain mandatory before broad implementation.

## Implementation plan

Slug: `native-omp-support`

### Goal, scope and readiness

Implement AC-1–AC-14 as one native provider, without upstream changes, installed-package edits, evaluator rewrites or a PTY replacement for foreground eval. Keep Pi separate and ACP configurations intact. The chosen launcher uses OMP's installed SDK and native RPC; the Bun loader provides narrow compatibility guards before source modules load.

Planning may proceed with this selected mechanism. Implementation starts at P1, whose permission-loader checks must pass before broad adapter/UI work. Do not call all gates cleared: helper-loader feasibility is demonstrated, while native stale-approval/settings-identity guards and complete lifecycle/transport coverage remain required proof. Failure must produce a concrete finding rather than an unrestricted fallback.

### Design and interfaces

**Provider boundary.** Create `packages/provider-omp`, with `driverKind: "omp"`, label `OMP`, and default executable `omp`. Follow provider-pi's client/settings/server package shape, Effect services, instance identity and continuation ownership. Do not import provider-pi internals across packages or parameterize its whole adapter. Reuse small provider-core/shared helpers; extraction of a shared JSONL transport is optional only if it reduces verified duplication without expanding the task.

**Launch/policy boundary.** `src/server/launch.ts` will expose `resolveOmpLaunchArgs(value: string)` as a success/validation-error union, `materializeOmpRuntimeAssets(cacheDir)` as an Effect returning absolute asset paths, and `buildOmpRpcLaunch(input)` returning `{ command, args, env }`. Use public `createAgentSession({ settings: constrainedOverlay, autoApprove: false })` in a T3-owned SDK launcher for reliable session-local permission enforcement. `policy.ts` owns authoritative policy snapshots, invalidate-and-recreate policy epochs and their handshake schema; `runtimePolicyHooks.ts` implements the in-process registered-settings and execution-token boundary; `compatibility.ts` owns reviewed source/layout fingerprints and transformation recipes. Never copy a masked effective map forward into a live child: it can hide a later deny. Install invalidation listeners before SDK consumers receive the settings object. Register `runtimeLoaderSource.ts` before any OMP import, then load `runtimeLauncherSource.ts` against the resolved installed package. Helper dispatch and final native execution guards are mandatory. SDK startup alone is not a policy boundary. Assets are versioned in T3's cache, credentials are per provider session, inherited T3 credentials are cleared, and helper-title generations use the same launch/policy path. No workstation-specific absolute path is shipped.

**Transport boundary.** `src/server/rpc.ts` exposes `makeOmpRpcConnection(options)` returning request/send/events/exited/terminate, matching Pi's public behavior with OMP errors and readiness negotiation. `protocol.ts` owns permissive validated envelope decoding and a bounded v2 chunk decoder. `request()` resolves command acknowledgements; prompt completion remains an event handled by the adapter, because one admitted prompt can later fail with the same ID.

**Projection boundary.** `adapter.ts` translates OMP to existing ProviderAdapter events. `toolItems.ts`, `history.ts`, and `usage.ts` own OMP decoding. Eval remains a `dynamic_tool` with ordinary input and `{content, details}` output, preserving raw structured fields. Do not create an orchestration eval item kind or a new persistence schema just for presentation. Live output needs an explicit compact wire projection; existing dynamic-tool compaction strips stdout/phase/logs. Keep the existing item union and database schema. Add an optional versioned `t3OmpEval` envelope to OMP eval output and preserve only its bounded validated preview during wire projection. Full output remains in existing deferred `getTurnItem` and artifact/image paths. This is an additive structured-output convention, with generic fallbacks for clients that do not understand it.

**Client boundary.** Add a browser-safe shared `packages/client-runtime/src/work-log/ompEval.ts` decoder taking unknown input/output and returning a validated optional eval view (title, language, code, stdout, phase, logs, status, duration, exitCode, truncation and image references). Scope specialization to an OMP-origin marker plus `toolName: "eval"`, not every provider's tool with that name. Persist the origin marker with the item so provider switching does not make historical OMP items depend on the thread's current provider. Generic rendering remains the fallback. Web and mobile consume this decoder rather than duplicate parsing. No assumption that omitted output means empty output: respect lazy body/detail loading. Merge the latest wire preview with fetched detail explicitly; an older fetched running body must never shadow newer live output. Keep the existing single live fetch revision for other tools.

### File/component map

New provider package:

- `packages/provider-omp/{package.json,tsconfig.json}`; `src/{client.ts,settings.ts,server.ts}`.
- `src/server/{driver.ts,status.ts,commands.ts,thinkingCapabilities.ts,rpc.ts,protocol.ts,launch.ts,policy.ts,adapter.ts,toolItems.ts,history.ts,usage.ts,textGeneration.ts}`.
- Create `src/server/{compatibility.ts,runtimeLoaderSource.ts,runtimeLauncherSource.ts,runtimePolicyHooks.ts}` and focused tests. Assets run under Bun in the child process; the T3 server stays on its normal runtime. Keep loader/hook code independent of repo-only imports. A provider-local extension may deliver instructions if needed; it is not the helper-enforcement mechanism or a native job-control service.
- Add `src/testing/nativePolicyProof.ts` as a direct Bun-run native compatibility/integration assertion program, outside the default Vitest test-name glob. Pin the reviewed OMP fixture as a dev-only dependency of provider-omp with lockfile integrity; it is not a shipped runtime OMP copy. Add a dedicated native-policy job in `.github/workflows/ci.yml` with a pinned Bun 1.4.4 runtime and isolated HOME/config, running that program. Normal Node/Vitest shards keep the ordinary unit tests and fake-process launcher checks; they must not silently skip a mandatory native-policy gate because Bun is absent.
- Focused `*.test.ts` beside protocol, launch/policy, adapter, tool/history, status/discovery and usage modules where behavior warrants them. Reuse `packages/provider-testing` fake CLI and test host.

Existing registration/build files:

- `apps/server/src/provider/builtInDrivers.ts`, `src/policy/managedProviders.ts`, `src/settingsSecrets.ts`, `src/usage/usageTestFormats.ts`.
- `packages/client-runtime/src/providerClients.ts`; server/client-runtime dependency manifests and package-manager lockfile.
- `.github/workflows/ci.yml`, `.github/scripts/ci-changes.cjs`, `scripts/check-changed.test.ts`, `scripts/release-smoke.ts` and new `scripts/verify-omp-installed-provider.ts` for native required-check wiring and installed-artifact validation.
- `knip.jsonc` and root `package.json` explicit provider workspace lists, only where the new package requires inclusion. Check server bundle/install packaging rather than assuming workspace development resolution proves a shipped build works.
- Audit provider label/icon/usage maps in web/mobile, adding OMP where the existing driver registry does not supply them. Do not add native-session scanner import support.

Eval presentation:

- New browser-safe `packages/shared/src/ompEval.ts` for validated live-envelope types/readers/bounds, and its package subpath export. Extend `packages/shared/src/toolOutput.ts` to retain that envelope inside the existing compact-output budget.
- Modify `apps/server/src/orchestration-v2/WireProjection.ts` only as needed to integrate bounded preview projection; extend `WireProjection.test.ts` and `ThreadTransportPerformance.test.ts` for wire coverage.
- New `packages/client-runtime/src/work-log/ompEval.ts` and focused decoder/merge tests; update `src/work-log/presentation.ts` and `itemDetail.ts` for title/phase and provider-aware live/final detail selection.
- Web `apps/web/src/components/chat/{V2ItemInspector.tsx,TimelineWorkEntryRow.tsx,ToolCallDetail.tsx}` and new `OmpEvalDetail.tsx`.
- Mobile `apps/mobile/src/features/threads/thread-work-log.tsx` and new `OmpEvalDetail.tsx` in that directory.
- Existing `ToolDetailCard`, `ToolDetailPane(surface="terminal")`, `ToolCode` and output/image rendering are the web reuse points. Extend feature-owned components, not generic UI class overrides. Use existing code/terminal palette tokens; verify evidence in dark mode.

Instructions/docs/evals:

- Provider-local OMP instructions composed with `packages/provider-core/src/server/runtimeInstructions.ts` and `orchestrationInstructions.ts`; only change shared text if actually needed.
- New `docs/user/providers-omp.md`; link from the existing provider guide navigation location discovered during P8.
- `evals/mcp-tool-use/cases/orchestration.ndjson` and the runner/template integration when needed to exercise OMP-specific injected text. Do not score a Codex/Claude prompt and label it native OMP runtime evidence.

### Selected runtime policy design

**Installation/runtime.** Resolve the configured `omp` executable through the existing spawn environment, follow its real package root and confirm the package name/exports. Initial support requires a source-bearing `@oh-my-pi/pi-coding-agent` installation and a supported Bun runtime. Do not locate OMP using T3's workspace node_modules or fetch another OMP copy. Preserve explicitly configured profiles, credentials and agent directories; isolate inherited harness-specific configuration only when it is demonstrably not the configured provider environment. `binaryPath` remains `omp` by default.

**Loader contract.** `compatibility.ts` selects a reviewed recipe from installed package/runtime identity and critical module fingerprints. The loader verifies the actual bytes it transforms, exact package-root containment, unique anchors and expected transform counts. It transforms only the declared helper dispatcher, native tool execution wrapper, eval prelude boundary and any additional execution path P1 proves necessary. An unsupported recipe or a module loaded without its required guard is a provider startup error. Never accept a user-provided hash as permission to bypass checks. The launcher must acknowledge every guard before discovery can invoke tools or user turns are admitted. Bun 1.4.4 and the reviewed source-bearing 18.16.0 recipe are the initial tested baseline; compatible additional fingerprints must be reviewed explicitly. Source-bearing npm distribution is required initially; no compiled-binary fallback and no automatic reinstall.

**Process isolation and packaging.** T3 materializes versioned immutable loader/launcher/hook assets in its own cache. Register the Bun plugin before importing OMP; explicit dynamic imports are required in the launcher. Runtime assets must resolve imports from the installed package while retaining its worker dispatch/dependency behavior. Native JS workers and Python bridge callbacks must return to the guarded host dispatcher; workers that construct native sessions need equivalent policy registration or are refused. Normal OMP runs have no preload and no T3 policy. Do not edit installed source. Run helper-generation/discovery children through the same guarded factory.

**Settings epochs.** `createPolicyEpoch(authoritativeSettings, runtimeMode)` creates a fresh constrained overlay, abort controller and admission state before SDK consumers receive it. Never copy an already masked effective map into the next epoch. Sanitize each epoch's inherited allow policies against T3 mode without losing explicit deny/prompt/removal; preserve default read behavior. Any authoritative policy change, revocation, direct constrained-setting mutation or session identity replacement synchronously closes admission and aborts the old epoch. Dispose/restart the affected native session, reload authoritative settings for the destination cwd/profile and recreate a clean epoch before resuming. Do not repair the active overlay in place. Settings.cloneForCwd has no implicit listener inheritance; every executable settings object must be registered before use. No blanket process-global `api.pi.settings` assumption.

**Scope binding.** Each epoch records environment/project identity, provider/native session identity, normalized destination cwd, profile/agent directory and a monotonic scope generation. Settings identity and effective-policy listeners alone do not detect scope changes: native Settings.reloadForCwd mutates cwd in place and may emit no policy event. Explicitly invalidate at supported native scope/session transition entry before their first await, including reloadForCwd, new/switch/resume/fork, move/cwd and profile rebinding. Add the settings/session transition modules to the compatibility fingerprint/transform recipe. The final guard compares actual native settings/context/session-manager scope with the captured descriptor. Equal-policy cwd transitions invalidate too. A clone is unregistered until the destination authority creates its new epoch. Configuration reload within the same scope still invalidates when authoritative policy changes.

**Execution tokens, approved input and final guard.** Maintain an in-process WeakMap from exact Settings objects to registered epochs. `enterNativeCall(settings, {nativeCallId, kind, scope})` rejects unregistered/inactive settings or aborted policy and returns an opaque token bound to epoch, settings, session and scope generation. Capture it before asynchronous native hooks/preflight/approval work. After legitimate tool-call input revisions, `captureAuthorization(token, {subject, effectiveInput, executionContext, disposition})` records a deep-owned immutable snapshot of the resolved tool/prelude identity, policy key/tier, validated effective arguments, relevant destination context and native allow/approve-once disposition. Capture the input shown for approval before awaiting UI; finalize the disposition against that same snapshot. No-prompt paths still get a snapshot after native resolution. Do not serialize away unknown input fields, share nested objects with handlers, or treat object identity as input equality.

`assertBeforeInvoke(authorization, {settings, subject, effectiveInput, executionContext, scope})` compares current values to that snapshot, checks the active epoch/registered identities/abort state/authority, and returns a separately owned invocation input. Place it inside the native runner/file-session callback immediately adjacent to this.tool.execute, and directly before prelude.invoke, after every awaited approval-resolved handler/preflight step. No await may separate this final check from invocation; invoke with the returned owned input so a handler retaining the original object cannot mutate authorized data after the check. Any changed input, permission or scope refuses execution and requires fresh authorization; never reinterpret an old approval in a new epoch. Bind relative paths to the captured destination scope. Keep native approval and provider safety checks; the guard does not replace them. Cancel already-started operations through native signals/process ownership rather than claiming to undo them.

**Typed approvals.** Use the optional public SDK UI `approve()` callback, with the same object supplied to tool context and extension runtime. Attach approve to the actual native UI object supplied by runRpcMode before forwarding that same object to SDK tool context and extension initialization; returning a separate decorated object would leave one consumer unchanged. The loader scopes requestApproval through an async call-token/authorization-snapshot context when native metadata is needed, so concurrent requests bind to the actual token, not dialog titles or event ordering. The launcher generates a unique native bridge request ID and includes provider session, policy epoch and optional originating item reference. Only explicit once/deny are supported initially; no accidental native session-wide grant. Ordinary select/ask dialogs remain native RPC. The T3 adapter projects requests through existing runtime_request/approval events. Both clients answer through the destination environment service. The first valid answer consumes the request atomically; duplicate, expired, disconnected or old-epoch responses fail closed.

**Control transport.** Keep OMP's JSONL stdout channel native. Use a private local control socket/pipe with per-process credentials for T3 policy/approval messages; do not expose it as a remotely reachable server, put secrets in arguments, or bake localhost into clients. The launcher and adapter exchange versioned decoded envelopes: ready/guard acknowledgement, approval request, approval answer, invalidation and cancel. Host/runtime IDs and epoch are checked before acting. Native RPC is still used for prompts/history/tool streaming; the side channel provides only the T3-owned policy surface. RPC mode's public setToolUIContext callback composes the approve handler before native extension initialization. If any native call falls back to an unregistered UI/settings context, fail closed instead of parsing its select labels.

**Disabled native features.** The fixed native settings remain async=false, both auto-background flags=false, launch=false and maxRecursionDepth=0. Helper dispatch rejects `__completion__`, `__judge__`, `__judge_batch__`, `__agent__` and `__workpool__` before allocation, including batch attach/control and captured function references. Keep native foreground kernels, retained state, ordinary permitted tool bridges, images/views, streaming and other helpers. Disable speculative execution/launch paths during guarded startup unless P1 proves they pass the same admission and pre-invoke checks; otherwise speculative work could bypass a final wrapper check. Persistent shell work and delegation use existing T3 services and their existing grants; shared PTY mutation still requires full-access/default mode. Native foreground eval must remain available through native approvals in supervised modes.

### Evidence already obtained

- Installed OMP 18.16.0 starts successfully with isolated configuration. Removing inherited harness PI_CODING_AGENT_DIR alone also fixes the earlier silent startup failure; this is not authority to discard an intentional provider override.
- `/tmp/t3-omp-loader-proof/{preload.ts,native.ts}` passes against native JS/Python EvalTool: retained state, ordinary tool calls, blocked model/spawn helpers and captured aliases, kernel reset protection, zero model/request/fetch calls, unchanged installed bridge hash. Wrong expected hash refuses before execution. The Python private-name proxy case is blocked by native AttributeError before dispatch, not counted as a loader hit. Proof recipe covers the helper dispatcher only, not permission-loader guards.
- `/tmp/t3-omp-permission-v2/epochs.ts` passes nine mode/transition cases for allow→deny/prompt/removal, canonical/legacy/mounted policy keys, observer ordering and direct child mutation invalidation. This is a focused native settings proof, not every production transition.
- `/tmp/t3-omp-permission-v2/sdk-ui.ts` creates a real SDK session with exact settings identity and public UI; native write and native eval-mediated write receive typed approvals. Concurrent/out-of-order/duplicate/stale answers and a same-looking native select are distinguished. Inference counter is zero; nine initialization/catalog fetch attempts were blocked by its trap. No request was sent externally. It does not prove the final control socket or all session transitions.
- Second adversarial review identified the original stale-mask bug, missing native RPC permission discriminator, and noninherited clone listeners. The selected design addresses them explicitly. Permission-loader assertions after pending UI and all supported transition paths have not yet run.

### P1 — Implement and prove the compatibility/policy boundary (AC-5–AC-8, AC-11, AC-14)

- [ ] Inspect installed package exports and critical source/runtime fingerprints; encode one explicit supported recipe for the tested source-bearing distribution. Record assumptions in compatibility.ts tests, not machine-specific paths in shipped code. Add expected-count/hash/layout failure cases. Prove the actual Bun SDK/worker entry path, not just a successful import.
- [ ] Create policy epoch and typed control-channel interfaces above in provider-local modules, with validation errors defined before adapter implementation. Derive overlays from an authoritative source and install synchronous invalidation before exposing them. Register exact Settings identities; initial startup admission stays closed.
- [ ] Port the helper-loader proof into focused package tests using actual isolated native JS/Python runtimes and a stub credential/inference boundary. Assert no handle/batch allocation, no model calls, captured references, raw reachable names, batch attach, reset, retained state and normal tool calls. Verify images/structured views and output streaming remain native. No replacement dispatcher or evaluator may stand in for the tested native path.
- [ ] Define and test the exact T3 mapping: approval-required → always-ask, auto-accept-edits → write, full-access → yolo. Auto is unsupported; persisted Auto selections use the existing Pi-style supervised normalization with an explicit displayed mode. Cover the full mode/tool matrix: reads, real file edits, bash, native eval, mounted exec tools, browser/computer preludes and explicit native deny/prompt overrides. Keep PTY full-access/default availability separate from native eval approval.
- [ ] Add a failing native permission regression before adding loader guards: open approval, revoke or replace policy/settings, resolve the old approval and assert zero underlying execution. Cover native direct tools, eval-mediated calls, xd:// device dispatch, browser/computer preludes and full-access/no-prompt paths. Then add entry-token, owned authorization-snapshot, request-context and final pre-invoke transformations to exact verified native locations. Include nested argument mutation during pending UI and during tool_approval_resolved handlers, plus no-prompt paths; assert zero invocation on mutation. Bind both native tools and prelude parameters/context, and invoke with separately owned inputs after comparison. Verify no await or speculative side-effect path can bypass the final check; if another native path is discovered, include it in the recipe and proof before declaring coverage.
- [ ] Add native transition cases: allow→deny, allow→prompt, removal, new keys, canonical/legacy/mounted keys; mode change while UI pending; expiration; two clients/duplicate replies; abort/disconnect; existing and newly cloned settings; native create/resume/fork/cwd/profile change; equal-policy reloadForCwd on the same Settings object; pending relative-path approvals while cwd changes; helper-generation sessions. Include observers registered before/after the policy boundary and verify explicit transition invalidation, rather than relying on post-mutation reads or permission-value events. Re-register or recreate before execution. Preserve explicit user deny/prompt in every mode. Native autoApprove stays false.
- [ ] Run a real runRpcMode startup under the public SDK callback and private control channel, exercising simultaneous native dialogs and genuine approvals with identical titles; verify epoch/request correlation, explicit once/deny mapping, startup failure on missing hooks, deterministic shutdown and startup UI without deadlock. No model inference is needed for these tool-driven tests.
- [ ] Add `omp_native_policy` to `.github/workflows/ci.yml` and its required `check.needs`. Add the `omp_native_policy` changes output to `.github/scripts/ci-changes.cjs`, the changes job outputs and its affected-workspace dependency logic; unknown changes/main builds fail open to running it. The existing Check permitted-skip rule then accepts a skipped job only when that exact gate is false. Trigger on provider-omp, provider-core/shared/contracts inputs used by its proof, runtime fixture/lock changes, the native proof/runner, CI setup/detection and packaging changes. Extend `scripts/check-changed.test.ts` for triggering, permitted skips and detection failure; a failing/cancelled mandatory native job must fail Check.
- [ ] CI setup: use setup-ci-deps for the frozen workspace install, including the lockfile-pinned dev-only OMP fixture; install pinned Bun 1.4.4 and Python 3.12 via actions following repository action-pin conventions. Implement nativePolicyProof.ts as an isolation bootstrap with no static OMP import before isolation. It creates unique temporary HOME/cwd/T3/OMP config/session roots and starts the native child with an allowlisted environment (runtime PATH, isolated HOME/TMPDIR, locale/TERM and explicitly selected Python only), excluding ambient provider credentials, model endpoints, agent directories, preload flags and T3 tokens. Native settings select that Python interpreter; missing runtime/interpreter is a gate failure, not a skip. Stub inference/credentials and reject external network at the native boundary before any OMP initialization. Keep a zero-inference assertion separate from the count of blocked catalog-fetch attempts. Clean only the child's tracked processes and temporary roots.
- [ ] P1 passes only after the native permission-loader and helper-loader tests pass together on the supported recipe. Downstream P2–P9 stay conditional until then. If a supported installed layout cannot be guarded without rewriting native eval, report incompatibility; no upstream patch, PTY substitute or unrestricted fallback.

Validation: `vp test run packages/provider-omp/src/server/compatibility.test.ts packages/provider-omp/src/server/runtimePolicyHooks.test.ts packages/provider-omp/src/server/runtimeLauncher.test.ts`. These are new focused files implemented in P1. The dev-only lockfile-pinned OMP fixture is resolved from the provider-omp package in CI, never a global install. Run `bun packages/provider-omp/src/testing/nativePolicyProof.ts --isolated --python python3` in the dedicated Bun job; keep native subprocess assertions out of default Node-only test discovery. Capture outputs and exit codes; fail on missing runtime/fixture/guard. This job uses isolated HOME/config and a stub model/request boundary, with no live credentials or inference. No proof may depend on /tmp scratch files from this session.

### P2 — Provider launch, policy and transport (AC-1, AC-3, AC-5–AC-8)

Depends on P1. Scaffold only the provider package needed by P1 tests first; it remains unregistered until P7.

- [ ] Create provider package exports and settings, default disabled. Validate binaryPath, launchArgs and environment handling using existing provider-core conventions. Add only runtime dependencies required by the proven mechanism; do not bundle a second independent OMP installation.
- [ ] Implement launch/policy using P1's verified SDK/loader/control-channel mechanism. Reserve mode/session/fork/extension-policy controls from user arguments, validate equals forms/short forms and positional prompts, preserve permitted profile/provider/model settings, verify T3-owned policy and preload manifest after user options, and scope credentials/instructions to the process. Reject ways to omit/replace the loader, control channel, policy manifest or required assets. Inspect preload/Bun environment and launch options so inherited flags cannot admit an unguarded OMP import. Discarded settings must not be silently persisted to user config.
- [ ] Implement readiness + v2 negotiation before ordinary discovery, while still servicing extension UI during startup to avoid deadlocks. Read stdout continuously and correlate requests by ID. Negotiate delta-only message updates after readiness.
- [ ] Validate chunk ID/count/index/byte length/base64/strict UTF-8, uninterrupted sequences and advertised reassembly bounds capped by T3's own budget. Reject incomplete/interleaved/oversized frames and fail pending requests cleanly. Do not silently drop a required completion frame or concatenate already compacted history from agent_end.
- [ ] Ensure subprocess scope owns teardown from spawn onward, exit/stdout failure diagnosis, group cleanup, bounded stderr handling and request cancellation. Copy Pi's established process ownership behavior, not its Pi-specific minimum version assumptions.
- [ ] Focused tests before implementation: launch override/config reload failure, ordinary OMP config unchanged, both-language helper rejection/no request counters, retained-reference/reset cases, v2 valid/invalid sequences, immediate exit, partial UTF-8 reads, Unicode line separators and interrupted setup cleanup. Extend the fake CLI fixture, no sleeps/polling.

Validation: `vp test run packages/provider-omp/src/server/launch.test.ts packages/provider-omp/src/server/policy.test.ts packages/provider-omp/src/server/protocol.test.ts packages/provider-omp/src/server/rpc.test.ts`.

### P3 — Discovery, instruction delivery and T3 tools (AC-1, AC-2, AC-5, AC-6, AC-8, AC-11)

Depends on P2.

- [ ] Implement version/capability-aware status and workspace discovery via `get_available_models`, `get_available_thinking_levels`, `get_available_commands`, state and command-update frames. Define the supported OMP floor from the proven installed/public API capability set; don't reuse Pi's version floor. Report incompatible policy capability as unavailable rather than starting an unrestricted session.
- [ ] Project native thinking choices and active configured defaults into existing settings/pickers. Preserve workspace-specific native commands and skills; filter commands that start excluded native agent/service/model-helper features or mutate mandatory execution policy. Reject excluded command dispatch rather than hiding only the picker entry. Do not execute live work during discovery.
- [ ] Use OMP's native `set_host_tools` with host_tool_call/update/result/cancel as the T3 tool bridge if the installed capability is supported. Catalog definitions come from the existing session-scoped MCP catalog, and execution uses its authorized endpoint; never call service internals from a provider. Preserve names/schema/output/images, update removals as well as additions, cancel in-flight HTTP requests and distinguish result errors from transport errors. OMP set_host_tools replaces definitions but does not cancel already pending calls. Track calls against catalog/session generation and endpoint authorization; on revocation cancel work where supported, close out its pending host request, and discard late results from revoked/stale generations. Test removal/revocation during execution and reject subsequent use.
- [ ] Preserve OMP user MCP tools separately; ensure mounted xd:// discovery finds the T3 tool inventory even when tools aren't top-level definitions. Native host tools must not bypass T3 grants or expose credentials in results.
- [ ] Inject T3 role/runtime instructions into the native system context with acknowledgement and no positional-prompt corruption of slash commands. Include guidance for T3 delegation and PTY completion subscriptions, preserving existing orchestration controls. This instruction mechanism follows P1/P2; native host tools alone do not deliver instructions or policy enforcement.
- [ ] Add focused discovery/catalog/instruction tests: startup dialog, project command changes, model unavailable/no credentials, guard/epoch handshake missing, catalog replacement/removal, cancellation, tool errors, image bounds and scope/caller propagation. Check every policy-disallowed native path through the runtime, not only displayed inventory.

Validation: `vp test run packages/provider-omp/src/server/status.test.ts packages/provider-omp/src/server/commands.test.ts packages/provider-omp/src/server/toolBridge.test.ts`. Create `toolBridge.ts`/test for the catalog/native-host-tool adapter; omit runtimeExtensionSource-based MCP reimplementation if native host tools suffice.

### P4 — Orchestration lifecycle, questions and permissions (AC-3–AC-6, AC-11, AC-13)

Depends on P3.

- [ ] Build OmpAdapterV2Driver using Pi's single-owner serialized session model and ID allocator. Preserve prompt IDs across acknowledgement and later prompt_result. Complete local-only commands from their native completion payload, active work using prompt_result/session_settled/isSettled; do not wait on Pi agent_settled or finalize on every agent_end.
- [ ] Decode delta message start/update/end and tool execution start/update/end. Flush final text/tool state before terminal projection. Handle manual/automatic compaction and retries using OMP's event names. Detect protocol errors, native persistence notices and failed prompt admission without leaving a running spinner.
- [ ] Implement steering, queued input and Stop with OMP's queue semantics (`abort_and_restore_queue` where supported). Prevent cancelled queued text from restarting native work. Serialize stop/restart/model/policy transitions so stale responses cannot complete a newer turn.
- [ ] T3 PTY completion and child-agent completion use existing orchestrator continuation delivery. Keep native session identity across ready/running transitions, restart/resume safely when necessary, and dedupe duplicate completion notices. Do not model T3 terminals as OMP native jobs or introduce a second job roster.
- [ ] Enable grouped ask with `set_ask_dialog`; map select/confirm/input/editor/ask, cancellation/expiry and notification methods. Preserve exact selected labels/order, free-text/multi-select semantics and secret-input treatment through existing contracts. Unsupported request forms fail explicitly. Remote clients answer through normal environment RPC.
- [ ] Native permission gate plus loader token/final-invoke guards handle reads, real file edits, commands, eval, native extension tools and eval browser/computer preludes. Treat xd:// writes as tool execution; cover direct tools and eval-mediated calls. Prefer native approval enforcement if it supplies the required boundary. Use P1's native mode mappings, fresh policy epochs and final pre-invoke checks. If implementation invalidates that proof, stop for a spec decision rather than silently reducing required modes. Mode changes may restart and resume like Pi; Auto is not advertised without a native reviewer.
- [ ] Capability flags describe implemented behavior: no provider-native subagent support, no native background-job controls; T3 app-owned delegation remains available through MCP. Exercise tool approval, subagent and terminal tools under destination grants.
- [ ] Extend focused adapter tests for empty/local prompt, late error, repeated settled, compaction, interruption race, stale response, queue restore, startup dialog, cancellation and post-turn T3 continuation. Synchronize with Queues/Deferred or worker drain, never timing loops. Add a minimal integration assertion to existing OrchestratorMcpToolkit/McpTerminalToolkit tests only for behavior the provider tests cannot prove.

Validation: `vp test run packages/provider-omp/src/server/adapter.test.ts apps/server/src/mcp/McpTerminalToolkit.test.ts apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts`.

### P5 — Tools, history, usage, todos and helper generations (AC-3, AC-9–AC-12)

Depends on P4.

- [ ] Decode native bash, hashline edit/write, read/search/browser and unknown tool results into existing item variants. Retain arbitrary args/result/details for generic fallback, including eval status/images/views and artifact metadata. Do not treat mounted device invocation as file modification. Make final results authoritative over live tails.
- [ ] Add the OMP eval live-output convention in `packages/shared/src/ompEval.ts`: `t3OmpEval` has `version: 1`, a nonnegative per-item monotonic `revision`, title, language, lifecycle status, stdout tail, latest phase, bounded log entries, optional duration/exit code and output-truncation indicators. Proposed hard bounds: the envelope is at most 4096 UTF-8 JSON bytes; title/phase at most 160 characters each; stdout tail at most 2048 UTF-8 bytes; at most four log messages of 128 characters each. Validate/reduce by serialized bytes after JSON escaping, not string length alone. No source code, arbitrary native detail, images/base64 or full views go in the live envelope. Input code and full native detail remain on demand. These are implementation budgets, not changes to the approved behavior.
- [ ] Stamp the envelope only on verified OMP eval items, with revisions increasing across start/update/final events for that item. Preserve the native `{content, details}` body alongside it. Extend `compactDynamicToolOutput` to read the envelope directly from the raw root before its ordinary content traversal, preserve it even when large native content exhausts the traversal budget, and validate it again. Maintain the existing 8192-byte total compact metadata cap; trim/drop preview content to fit alongside other metadata rather than lifting the global cap. Unknown tools and other providers retain current projection behavior.
- [ ] In wire projections and reconnect snapshots, retain the newest bounded envelope even when `outputOmitted: true`; final/full body hydration remains separate. Cover corrupted envelopes and stale/regressing revisions without rendering arbitrary native JSON as executable markup. Collapsed rows get title/phase from this preview even while input is summarized. Preserve existing artifact and image references through their established paths.
- [ ] Extend projectTurnItemForDetail for validated OMP eval output, not only projectTurnItemForWire. The current generic >256-KiB conversion to a truncated JSON string loses eval revision/artifact metadata. Preserve a structured OMP envelope containing the validated origin/revision/lifecycle marker, bounded text/cell fields, explicit input/output truncation flags, image references/order and native artifact references. Bound code/stdout fields individually by UTF-8 JSON bytes while respecting the existing total detail budgets; never stringify away the whole metadata object. Oversized input remains `{language,title,code: bounded text,...truncation metadata}`. Retain raw persisted input; show explicit truncation rather than claiming an unavailable full-input artifact exists. Preserve existing authenticated image-index and native output-artifact access paths; no base64 duplication or new arbitrary file access.
- [ ] The shared decoder accepts native full detail and this bounded structured detail. A matching final revision ends hydration/loading even if code/output is truncated. If historical/unsupported output has no recoverable revision marker, terminate the loading state with terminal lifecycle plus a generic bounded fallback and explicit truncation notice; do not spin or refetch indefinitely. Add a >256-KiB final-output/code test with images/artifact metadata, wire terminal arriving before detail and a late stale running fetch. Assert metadata survives and final hydration settles, while generic non-OMP truncation is unchanged.

- [ ] Reconcile append-history by id/parentId/leafId using get_entries/get_messages pagination where available; implement rollback/native fork against OMP semantics. Validate branch result cancellation and session identity. Never point a second live process at an owned source session; obtain a safe native fork without stealing the parent lease. Confirm destination cwd/worktree and retained artifacts, including partial tool batches; don't copy Pi's CLI --fork choreography without proof.
- [ ] Resume sessions created by this driver and preserve provider identity/continuation keys. Handle unknown incremental cursor via documented full resync, branch resets and extra native entry types permissively. No arbitrary-session import/scanner work.
- [ ] Normalize native usage/context with a provider-specific transcript reader, respecting profile/agent-dir/session-dir configuration. Count main requests once; understand model_usage vs assistant usage and auxiliary usage before aggregation. Use fixture records without live user data.
- [ ] Project native todo phases into todo_list events and remove the synthetic-checklist fallback for this provider. Reconcile state after resume/fork and native todo calls, including eval-mediated calls; don't fetch state on every text delta.
- [ ] Text/title generation uses ephemeral, restricted tools-disabled launch through the same policy path and OMP completion semantics. Existing title/handoff plumbing remains supported. Tool-free helper calls cannot accidentally expose eval/native delegates or create retained provider history.
- [ ] Tests before implementation: native hashline formats, eval running/final snapshot replacement, live wire preview under huge output, malformed envelopes, escaped/non-ASCII JSON byte budgets, bounded reconnect snapshots and unchanged generic-tool compaction, unknown tool fallback, leaf ancestry/cursor/reset, fork lease/cwd/batch/artifact preservation, both usage source types without duplicate accounting, todo persistence and empty/title generation.

Validation: `vp test run packages/provider-omp/src/server/toolItems.test.ts packages/provider-omp/src/server/history.test.ts packages/provider-omp/src/server/usage.test.ts packages/provider-omp/src/server/textGeneration.test.ts packages/shared/src/toolOutput.test.ts packages/shared/src/ompEval.test.ts apps/server/src/orchestration-v2/WireProjection.test.ts apps/server/src/orchestration-v2/ThreadTransportPerformance.test.ts`.

### P6 — Eval terminal presentation across clients (AC-9, AC-10, AC-13)

Depends on P5's payload, can precede P7 registration using synthetic fixtures.

- [ ] Implement shared decodeOmpEval(input: unknown, output: unknown) returning a typed optional view. Guard malformed/partial data, unknown status events, python/py/js language differences and absent title/phase/output. Project latest phase and bounded distinct logs; preserve cells/views/image references without transporting base64 copies redundantly. Add an optional provider-aware item wrapper to make OMP selection explicit.
- [ ] Implement `mergeOmpEvalDetail(wireItem, fetchedItem)` in the shared client presentation module. Match native item identity and OMP marker, use wire lifecycle/revision as authoritative for live state, retain full fetched input/code, and prefer the newer validated preview over any older fetched body. On final transition request full detail through the existing terminal-status revision; use it as authoritative only when its eval revision matches or supersedes the final wire revision. Ignore a late running fetch after finalization. While final hydration is pending, keep the final tail/status visible with access/loading state for full output. Do not concatenate snapshots, duplicate logs or refetch full detail on each live delta. Non-OMP tools keep their existing hydration rules.
- [ ] Share title/phase selection with collapsed work-log presentation so the custom heading is visible before expansion. Do not overwrite supplied title with a generated summary. Keep generic inspector fallback for non-OMP eval tools and unsupported shapes.
- [ ] Web: wire both expanded work-log entries and V2ItemInspector to OmpEvalDetail. Reuse ToolDetailCard + two ToolDetailPane(surface="terminal") panes, ToolCode for python/js, existing image and deferred-body fetch components. Show live phase, output and final metadata; do not add a shell '$' prompt to code. Separate logs from stdout.
- [ ] Reuse the existing end-following output component where suitable; otherwise add a minimal component that follows only when at bottom. Ensure snapshot replacement, manual scroll, long lines, lazy fetch races and final output recovery remain correct.
- [ ] Mobile: use the same decoder and merge function in thread-work-log, replacing its unconditional preference for fetched detail only for OMP eval, with equivalent read-only input/output panes, phase/logs and images using native components. No web DOM or syntax-highlighter worker dependency in client-runtime/mobile. Desktop receives web changes with no IPC feature requirement.
- [ ] Decoder logic tests cover malformed/partial/final payloads, fallback title/language, empty vs withheld output, bounded structured detail over 256 KiB, terminal loading completion when history lacks a revision marker, two live snapshots after the first detail fetch, stale live fetch completing after finalization, terminal wire arriving before final hydration, reconnect with a bounded preview, and provider isolation. Assert the shared merge behavior once at this layer; client integration only verifies it is actually used. Extend V2ItemInspector.browser.test.tsx only for behavioral streaming/scroll/lazy-detail races, using disposable render and expect.element/vi.waitFor. Do not write static-markup tests for terminal colors. Capture actual dark-mode presentation as visual proof in P9.

Validation: `vp test run packages/client-runtime/src/work-log/ompEval.test.ts packages/client-runtime/src/work-log/presentation.test.ts apps/web/src/components/chat/V2ItemInspector.browser.test.tsx packages/client-runtime/src/work-log/itemDetail.test.ts`.

### P7 — Registration and shipping paths (AC-1, AC-2, AC-12, AC-13)

Depends on P2–P6.

- [ ] Register OmpDriver and usage reader in builtInDrivers, shared client metadata in providerClients, provider settings in managedProviders/settingsSecrets and usages in usageTestFormats. Preserve defaults as disabled and leave any existing oh-my-pi ACP instance untouched. Use independent continuation identities; no implicit cross-driver native resume.
- [ ] Add workspace dependencies/exports, lockfile and required knip workspace list entries. Verify server bundled entry, production dependency resolution and explicit cache/runtime asset packaging; runtime extension source strings must not rely on resolving repo-only workspace dependencies from the user's installation.
- [ ] Add packages/provider-omp/package.json to scripts/release-smoke.ts workspaceFiles. The fixture's lockfile-only install must resolve the new server/client-runtime workspace dependency. Verify `node scripts/release-smoke.ts`; do not assume package registration alone updates release fixtures.
- [ ] Add scripts/verify-omp-installed-provider.ts. After `vp run --filter t3 build:bundle`, the script stages the built server/package assets outside the checkout and installs/resolves a separately locked source-bearing OMP fixture outside workspace node_modules. Start the built artifact from that external cwd with isolated T3/OMP homes and no source-checkout symlinks. Configure its native provider through the normal settings/service boundary and require installed-package resolution, cache asset materialization, native loader/control/RPC guard acknowledgements and clean shutdown. Stub inference and block external provider access. Verify unavailable/changed source fingerprint fails closed and installed OMP files are unchanged; a --help-only launch is insufficient. Track spawned PIDs and clean only owned state. No source TS driver imports may substitute for this installed-artifact check.
- [ ] Verify settings, model picker, composer, command palette/keybinding entry points and per-instance provider environment secrets use shared registry behavior on all clients. No central provider enum or session-source import enum extension unless actually required by the new driver.
- [ ] Confirm server host process runs OMP and owns auth/tool endpoints in local, desktop-hosted, remote/relay and tunnel modes. No hardcoded HTTP/WS origins or client-local filesystem paths.
- [ ] Focused driver tests demonstrate selection/status refresh, settings snapshot changes, independent Pi/OMP/ACP identities and disabled state. Prefer extending existing registry/driver behavior tests over creating trivial registration-mirror tests.

Validation: `vp test run packages/provider-omp/src/server/driver.test.ts packages/provider-pi/src/server/driver.test.ts packages/provider-pi/src/server/adapter.test.ts scripts/check-changed.test.ts`; `node scripts/release-smoke.ts`; `vp run --filter t3 build:bundle`; `node scripts/verify-omp-installed-provider.ts --server-bin apps/server/dist/bin.mjs --isolated`. The new packaging script resolves the lockfile-pinned fixture through the provider-omp test host and stages it externally; no global OMP path is a test dependency. Final changed-package checks remain in P9.

### P8 — Model instructions, evals and user documentation (AC-5–AC-8, AC-13)

Depends on P3–P7.

- [ ] Read evals/README.md and mcp-tool-use/README.md before changing model-facing text. Add cases for native-task/model-helper avoidance, PTY persistent command + completion subscription, T3 delegation and an ordinary short foreground eval control. Import actual provider-local instruction text into the eval; add a supported OMP-shaped context if existing harness templates cannot represent it, and label any simulated evaluation accurately.
- [ ] First collect baseline on unchanged text, then candidate using the same supported model/cases; do not claim a pre-fix failure from a case run only after the change. Run one sample to validate setup, then the touched cases at normal sample count. No real provider turns for simple UI playback; use Replay (dev).
- [ ] Write docs/user/providers-omp.md explaining server-side installation/auth, binary path, permission modes and T3-managed agents/terminals. Explain retained foreground eval and unavailable completion/judgment helpers. Include actual minimum capability/version only after P1/P3 proof. Update existing navigation and provider text only where guidance would be inaccurate; no internal implementation catalog.

Planned cases: `omp-pty-background`, `omp-delegate-native-disabled`, `omp-eval-model-helpers-disabled`, `omp-foreground-eval-control`.
Validation (from evals): `pnpm mcp-tool-use --model gpt-6.1-sol --case omp-pty-background,omp-delegate-native-disabled,omp-eval-model-helpers-disabled,omp-foreground-eval-control --samples 1 --dry-run --out runs/omp-dry-run`; then same case list with `--model gpt-6.1-sol --samples 2 --out runs/omp-candidate`, and the corresponding baseline before the instruction change. The current runner supports this model ID and comma-separated case parsing. The existing model selects a Codex-shaped template; use the same explicit model/template/context construction in dry-run, baseline and candidate, and label the result as simulated routing evidence. If an OMP-specific template/context extension is introduced, wire it explicitly into all three invocations and assert that the dry-run contains the actual OMP-local instructions. Neither simulated score proves native policy enforcement.

### P9 — Integrated validation and handoff (all ACs)

Depends on P1–P8.

- [ ] Run focused commands from each changed task once after integration; broaden only for new failures or relevant edits. Run `vp run check:changed` as the final changed-file gate. No root `vp check`, root typecheck, recursive test suites or ad hoc npx tsc.
- [ ] Use test-t3-app once after integration against isolated worktree state. Replay fixtures exercise eval title/phase/log/output updates, errors, cancellation, truncation and images without paid inference. Verify rendered dark mode before capture; save evidence outside tracked source. Reuse startup-tracked PIDs; never kill by pattern or touch live T3 userdata.
- [ ] Perform one small real native OMP turn only for native-specific acceptance after P1 resolves executable startup, with the cheapest suitable configured model. Exercise foreground eval, denied helper calls, T3 delegation and a PTY completion wakeup. Use a stub-provider harness for zero-model-request assertions; a model merely choosing not to call a helper is not policy proof. Record model/cost and sanitized transcript.
- [ ] Verify mobile through test-t3-mobile and device tools when available, including dark mode; install missing native dev client through the supported cache/install flow. Verify desktop/web behavior through the shared web surface and shell-specific packaging checks. Report unavailable platform evidence accurately.
- [ ] Exercise remote-browser access to the isolated server and verify environment-owned terminal/delegation operation without baked origins. Use two simultaneous clients to observe one eval; expand one row and keep the other collapsed, disconnect/reconnect mid-execution, and verify both receive the newest phase/tail and final state without duplicate output, unbounded snapshots or per-delta full-body requests. Keep a PTY running across the browser disconnect and verify its existing durable completion subscription wakes the owning thread once. Record which local/desktop/remote/tunnel legs were actually verified; do not infer tunnel operation from localhost alone.
- [ ] Mark each AC using observed focused test results and integrated evidence. No claim that planned commands have passed. Update this single work record's outcome; do not create a second plan/checklist in the repository. Do not commit the local plan, create a PR or push unless separately requested.

### Concurrency, compatibility and rollback

P1–P5 are sequential: policy decisions, transport correlation and projected payloads must settle first. P6 client work can be split into web/mobile only after the shared decoder contract is fixed; each writable scope has one owner. P7 registry edits stay serialized. No additional implementation delegates are required by this planning request; the requested adversarial review is independent and read-only.

No database migration is planned: use existing dynamic_tool, runtime_request, todo and child/terminal services. Full tool body output uses existing hydration/omission rules. Maintain forward-compatible OMP envelopes and explicit capability/version errors. Settings restart only the relevant provider instance. Leave Pi and ACP continuation/usage behavior unchanged.

Rollback is disabling/removing the new native OMP provider registration and its client dependency; existing ACP remains usable. Stop only processes spawned by this driver and remove only its generated cache assets. Never remove users' OMP native sessions or global configuration. No raw job PID control, process-name matching or OS sandbox is introduced.

### Review focus

Fresh reviewers should independently challenge (1) loader registration before every OMP import/worker and handling of same-version source changes; (2) settings identity and policy invalidation after every async approval/preflight, including no-prompt execution; (3) correct once/deny control-channel correlation without title/event-order heuristics; (4) native eval preservation and forbidden allocation under retained references/reset; and (5) wire/hydration/performance and remote-client behavior. Treat helper-loader proof as evidence only for its tested boundary; the planned permission-loader is not yet proven. Reviewers do not edit files, start servers, call paid models or spawn reviewers.

### Validation and review status

Implementation is preserved locally and blocked on the remaining acceptance work below. No commit, push or PR was created. The approved artifact-resource addition is implemented; it no longer needs a design decision.

Implemented: native provider and guarded Bun launcher, exact source recipe, permission epochs and execution-boundary checks, JS/Python helper restrictions, native JSONL transport and owned process supervision, discovery/settings/model/reasoning/commands, authorized host tools, lifecycle/questions/permissions, history/forks/rollback/todos/usage/helpers, bounded eval output and web/mobile presentation, typed output-artifact access, registry/shipping/CI integration and user documentation. The provider is registered with its default disabled. Existing Pi and ACP identities remain independent.

Fresh GPT-6.1-Sol High reviews found and drove fixes for permission/executor/delegation/cwd boundaries, process lifecycle, adapter terminal publication, command admission, local completion, phase/title extraction, live images and oversized structured views. Final scoped audit `/tmp/t3-native-omp-final-review.md` found no new reproducible defect in the final image/view/artifact delta. This is not acceptance of all ACs.

Observed evidence:

- P1 native proof against the pinned fixture and supplied installation passed with zero inference; retained/reset JS/Python execution, forbidden helper allocation, native permission and transition cases, private approval/RPC handshake and staged runtime assets are covered. Exact recipe: OMP 18.16.0, Bun 1.4.4, 29 native file fingerprints and 15 mandatory guarded-module acknowledgements.
- Backend checkpoint: focused 100-test suite and native product/history/policy probes passed. Four checkpoint corrections subsequently passed 18 focused tests plus the oversized-wire case. Final image/view/projection check passed 41 tests; artifact service check passed 18 selected cases and the RPC authorization case. Commands and limits are in `/tmp/t3-native-omp-p3-p5-report.md` and `/tmp/t3-native-omp-artifact-report.md`.
- Client integration: `vp test run packages/client-runtime/src/work-log/ompEval.test.ts packages/client-runtime/src/work-log/itemDetail.test.ts` passed 7 tests. The dark-config repository browser run of `V2ItemInspector.browser.test.tsx` passed 4 tests. Affected client typechecks/lint passed. See `/tmp/t3-native-omp-artifact-client-report.md`.
- `node scripts/release-smoke.ts`, `vp run --filter t3 build:bundle`, and `node scripts/verify-omp-installed-provider.ts --server-bin apps/server/dist/bin.mjs --isolated` passed before the final artifact delta. Staged verification used a separately locked OMP fixture outside the checkout, normal settings/RPC, zero inference, unavailable/changed-fingerprint refusals and unchanged installed OMP files. These shipping checks were not repeated after the artifact delta.
- Four planned P8 routing cases and the actual instruction-import/context seam are implemented. Dry-run generated four requests; three focused tooling tests, typecheck/lint passed. No scored baseline/candidate exists. See `/tmp/t3-native-omp-p8-eval-report.md`.
- Final `vp run check:changed` completed with exit 1 (`/tmp/t3-native-omp-check-changed-retry.log`): format, lint, dependency Knip, GraphQL, all 40 affected typechecks and React compiler passed. Tests: 1004 passed, one existing mixed-height attachment-preview case failed. A focused control using unchanged HEAD AttachmentFilePreview reproduced exactly the same offset/bound; no tolerance or unrelated implementation changed (`/tmp/t3-native-omp-final-gate-notes.md`). Export-audit Knip also fails on reports across existing repository areas; a full HEAD export-audit control was not run and failures were not suppressed. The gate is not green.
- Android dev client installed successfully via `vp run mobile:install android emulator-5554`, with its native build succeeding. The app launched through the Device panel/AgentDevice in dark mode. Pairing the isolated backend failed on its environment descriptor at both emulator-host and reversed loopback origins. The descriptor separately validates in Node against ExecutionEnvironmentDescriptor. No native eval-view, artifact viewer or mobile scrolling success is claimed. iOS is unavailable on this Linux host.
- Browser-panel verification could not start: preview_status explicitly reported that the thread credential lacks preview capability and must not be retried. The test-t3-app skill requires stopping that verification when the panel is unavailable. Repository browser tests are separate evidence. No integrated web screenshot, two-client/reconnect, remote/relay/tunnel or real paid native turn was completed.

Acceptance status:

| Criteria | Evidence / remaining limit |
| --- | --- |
| AC-1–AC-2 | Implemented and covered by registry/discovery/staged-install checks; integrated client entry-point operation remains unverified. |
| AC-3–AC-4 | Focused/native transport, streaming and lifecycle checks pass; live paid-turn/client evidence remains outstanding. |
| AC-5–AC-6 | Native execution/spawning restrictions and T3 service/bridge checks pass; provider-local routing guidance and real detached-work/client demonstration remain incomplete. |
| AC-7–AC-8 | Native JS/Python helper/retained/reset/no-allocation and unchanged-install/config proofs pass for the exact supported recipe. |
| AC-9–AC-10 | Terminal presentation/merge/images/views/artifact service and browser checks pass; integrated visual/device/remote proof remains outstanding. |
| AC-11 | Modes, ordinary questions and approvals implemented/tested; protected native secret-answer input remains unsupported and explicitly cancelled. |
| AC-12 | Native history/fork/rollback/artifact/todo/usage proofs and focused tests pass; integrated client conversation evidence remains outstanding. |
| AC-13 | Environment-owned services/registries/authenticated resources implemented; real local/desktop/remote/relay/tunnel/multi-client legs not established. |
| AC-14 | Exact recipe/readiness and policy-epoch/final-boundary tests pass; production platform coverage retains the documented limits. |

Remaining blockers / resume point:

1. Required scored instruction baseline/candidate needs working eval credentials/configuration. The actual provider-local append intentionally remains unchanged/empty; saved baseline hash is `291d42d8e346a661d2327b9e9ab586a5a34490ebe4abdaac56c30f06f9a5f396`. Complete baseline before candidate. A private credential request timed out; no model result is invented.
2. Protected native secret input needs an authorized private answer integration. Existing provider host/question contracts do not expose one; native secret forms currently cancel with a notice. No plaintext persisted-answer fallback was introduced.
3. Repository gate is failing as described above. Do not claim readiness or broaden into unrelated export/virtual-preview cleanup without a maintainer decision.
4. Enable Browser-panel capability in a new agent session and resolve native pairing before integrated evidence; then exercise dark eval states, multiple clients/reconnect and the required native/remote/PTY completion legs. Do not infer remote/tunnel operation from the staged loopback check.

Isolated verification state is `.t3`, containing one Replay-derived visual fixture with a synthetic OMP eval item; this is UI fixture data, not a native turn. The dev/Metro processes were launched by the parent with owned PID records `/tmp/t3-omp-dev-detached.pid` and `/tmp/t3-omp-metro-detached.pid`. The Android Device session belongs to this task. Never point these at live T3 userdata or stop unrelated processes.
