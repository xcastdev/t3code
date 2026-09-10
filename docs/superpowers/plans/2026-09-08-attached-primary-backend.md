# Attached primary backend implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox syntax.

**Goal:** Let the desktop app attach to a `t3 serve` process on the same machine and use it as the primary local environment without launching another server.

**Architecture:** Store a desktop-only primary backend preference and an encrypted bearer credential. In attached mode, the Electron shell serves its bundled web client, reports the attached server through the existing `primary` bootstrap slot, and skips every managed-backend start path. A launch intent printed by `t3 serve` lets the first desktop launch attach before it starts a backend.

**Tech stack:** TypeScript, Effect, Effect Schema, Electron IPC, React, Effect Atom, Vitest.

**Spec:** The accepted behavior and constraints in this document are the feature specification.

## Accepted behavior

- The attached server remains the primary environment. It does not appear as a saved or secondary environment.
- `DesktopEnvironmentBootstrap.id` remains `"primary"`. The server-provided `environmentId` continues to scope projects, threads, and connection state.
- The first version accepts `http:` endpoints on `localhost`, `127.0.0.0/8`, or `[::1]`.
- The server must use the same filesystem namespace as the desktop process. Native file and editor actions rely on this condition.
- The startup owner pairing credential from `t3 serve` grants the administrative scopes needed for direct server and provider settings.
- The desktop stores the exchanged bearer credential with Electron safe storage. It never persists a plaintext credential.
- The desktop does not allocate a port, start a backend, reconcile WSL, change server exposure, restart the server, or stop the server in attached mode.
- The desktop keeps its bundled web client. The attached server supplies API and WebSocket traffic only.
- Invalid stored attachment state never starts a managed backend automatically. A native recovery dialog requires an explicit choice.
- Existing WSL and exposure preferences remain stored. They take effect again after the user returns to managed mode.
- Server and provider settings, projects, threads, terminals, source control, diagnostics, previews, file pickers, theme import, and local editor actions use the attached primary environment.
- Process-owned controls report the truth. Desktop exposure, Tailscale Serve, WSL backend selection, desktop telemetry file descriptors, and desktop-owned server restart remain unavailable in attached mode.
- The CLI server remains alive when the desktop exits.
- Run focused tests only. Do not run repository-wide checks.

## File structure

- `packages/contracts/src/ipc.ts` defines redacted attachment state and bridge methods.
- `apps/desktop/src/settings/DesktopAppSettings.ts` persists the primary backend preference and encrypted credential.
- `apps/desktop/src/backend/DesktopAttachedBackend.ts` validates endpoints, exchanges owner credentials, probes identity, decrypts credentials, and changes modes.
- `apps/desktop/src/app/DesktopLaunchIntent.ts` captures attachment deep links before backend startup.
- `apps/server/src/startupAccess.ts` prints a desktop attachment URL for eligible `t3 serve` endpoints.
- `apps/server/src/cli/pair.ts` issues replacement owner credentials through `t3 pair --owner`.
- `apps/desktop/src/electron/ElectronProtocol.ts` serves the desktop-bundled client without a running desktop backend.
- `apps/desktop/src/app/DesktopApp.ts` selects managed or attached startup.
- `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts` supplies the current primary bearer credential.
- `apps/desktop/src/ipc/methods/primaryBackend.ts` exposes attachment operations to the renderer.
- `apps/web/src/environments/primary/` keeps the attached server on the primary connection and handles credential recovery.
- `apps/web/src/components/settings/PrimaryBackendSettings.tsx` renders the backend source controls.

## Task 1: Define and persist the primary backend preference

**Files:**

- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/ipc.test.ts`
- Modify: `apps/desktop/src/settings/DesktopAppSettings.ts`
- Modify: `apps/desktop/src/settings/DesktopAppSettings.test.ts`

**Produces:** `DesktopPrimaryBackendState`, `DesktopPrimaryBackendPreference`, `setPrimaryBackendPreference`, and an additive `ownership` field on `DesktopEnvironmentBootstrap`.

- [ ] **Step 1: Write failing contract and settings tests**

Cover these cases:

```ts
expect(decodeDesktopPrimaryBackendState({ mode: "managed" })).toEqual({ mode: "managed" });

expect(
  decodeDesktopPrimaryBackendState({
    mode: "attached",
    httpBaseUrl: "http://127.0.0.1:3773/",
    environmentId: "environment-1",
    label: "Workstation",
    bearerExpiresAt: "2026-10-08T12:00:00.000Z",
  }),
).toMatchObject({ mode: "attached" });
```

Test that a missing preference loads as managed. Test that valid attached state round-trips. Test that an attached record with a missing endpoint, identity, ciphertext, or expiry loads as `invalid-attached` rather than managed.

- [ ] **Step 2: Run the tests and verify that they fail**

Run:

```bash
vp test run packages/contracts/src/ipc.test.ts apps/desktop/src/settings/DesktopAppSettings.test.ts
```

Expected: FAIL because the preference and schemas do not exist.

- [ ] **Step 3: Add the internal preference**

Use this internal model:

```ts
export type DesktopPrimaryBackendPreference =
  | { readonly mode: "managed" }
  | {
      readonly mode: "attached";
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly encryptedBearerToken: string;
      readonly bearerExpiresAt: string;
    }
  | {
      readonly mode: "invalid-attached";
      readonly reason: string;
    };
```

Decode the persisted `primaryBackend` field as `Schema.Unknown`, then normalize it. This keeps a malformed attachment distinguishable from a missing preference. Do not put the ciphertext or the WebSocket URL in renderer-facing state.

Add this service method:

```ts
readonly setPrimaryBackendPreference: (
  preference: Exclude<DesktopPrimaryBackendPreference, { readonly mode: "invalid-attached" }>,
) => Effect.Effect<DesktopSettingsChange, DesktopSettingsWriteError>;
```

- [ ] **Step 4: Add the IPC contract**

```ts
export const DesktopPrimaryBackendStateSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("managed") }),
  Schema.Struct({
    mode: Schema.Literal("attached"),
    httpBaseUrl: Schema.String,
    environmentId: EnvironmentId,
    label: Schema.String,
    bearerExpiresAt: Schema.String,
  }),
  Schema.Struct({
    mode: Schema.Literal("invalid-attached"),
    reason: Schema.String,
  }),
]);
```

Add `ownership: Schema.optionalKey(Schema.Literals(["managed", "attached"]))` to `DesktopEnvironmentBootstrapSchema`. Consumers treat an absent value as `"managed"`.

- [ ] **Step 5: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts apps/desktop/src/settings/DesktopAppSettings.ts apps/desktop/src/settings/DesktopAppSettings.test.ts
git commit -m "feat(desktop): persist primary backend source"
```

## Task 2: Implement attached backend authentication and identity checks

**Files:**

- Create: `apps/desktop/src/backend/DesktopAttachedBackend.ts`
- Create: `apps/desktop/src/backend/DesktopAttachedBackend.test.ts`
- Modify: `apps/desktop/src/main.ts`

**Consumes:** `DesktopPrimaryBackendPreference` from Task 1, `ElectronSafeStorage`, `resolveRemotePairingTarget`, `fetchRemoteEnvironmentDescriptor`, and `bootstrapRemoteBearerSession`.

**Produces:** One service that owns attachment validation, credential storage, identity checks, and mode changes.

- [ ] **Step 1: Write failing service tests**

Test these observable behaviors:

```ts
it.effect("stores an administrative attachment only after the endpoint and token succeed", () =>
  Effect.gen(function* () {
    const attached = yield* DesktopAttachedBackend;
    const state = yield* attached.attach("http://127.0.0.1:4773/pair#token=OWNER");
    expect(state).toMatchObject({
      mode: "attached",
      httpBaseUrl: "http://127.0.0.1:4773/",
      environmentId: "environment-1",
    });
    expect(readPersistedSettings()).not.toContain("OWNER");
    expect(readPersistedSettings()).not.toContain("access-token");
  }).pipe(Effect.provide(testLayer)),
);
```

Also test rejection of HTTPS, non-loopback hosts, URL userinfo, missing tokens, standard-scope tokens, and the active managed endpoint. Test that descriptor failure or token failure leaves managed mode unchanged. Test that a later probe rejects a different environment on the stored endpoint.

- [ ] **Step 2: Run the test and verify that it fails**

Run:

```bash
vp test run apps/desktop/src/backend/DesktopAttachedBackend.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Add the service interface**

```ts
export class DesktopAttachedBackend extends Context.Service<
  DesktopAttachedBackend,
  {
    readonly getState: Effect.Effect<DesktopPrimaryBackendState>;
    readonly attach: (
      pairingUrl: string,
    ) => Effect.Effect<
      Extract<DesktopPrimaryBackendState, { mode: "attached" }>,
      DesktopAttachError
    >;
    readonly refreshCredential: (
      pairingCredential: string,
    ) => Effect.Effect<void, DesktopAttachError>;
    readonly useManagedBackend: Effect.Effect<void, DesktopSettingsWriteError>;
    readonly getBearerToken: Effect.Effect<string, DesktopAttachedCredentialError>;
    readonly probe: Effect.Effect<ExecutionEnvironmentDescriptor, DesktopAttachedProbeError>;
  }
>()("@t3tools/desktop/backend/DesktopAttachedBackend") {}
```

- [ ] **Step 4: Implement loopback validation and attachment**

Accept `localhost`, IPv4 addresses whose first octet is `127`, and `::1`. Require `http:`. Reject fragments and query parameters after the pairing parser extracts the credential.

Call `bootstrapRemoteBearerSession` with `AuthAdministrativeScopes` and this metadata:

```ts
{
  label: "T3 Code Desktop",
  deviceType: "desktop",
  os: environment.platform,
  appVersion: environment.appVersion,
}
```

Decode the returned scope string and require every administrative scope. Encrypt `access_token`, encode the ciphertext as base64, and persist it with the endpoint, descriptor identity, label, and calculated expiry. Persist only after the exchange and encryption succeed.

- [ ] **Step 5: Implement refresh, probe, and managed-mode recovery**

`refreshCredential` exchanges a credential against the stored endpoint. It verifies the stored environment ID before replacing the ciphertext and expiry. `probe` verifies both the public descriptor and the stored bearer session. `useManagedBackend` writes `{ mode: "managed" }` and removes the ciphertext in the same settings write.

- [ ] **Step 6: Run the focused test**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/backend/DesktopAttachedBackend.ts apps/desktop/src/backend/DesktopAttachedBackend.test.ts apps/desktop/src/main.ts
git commit -m "feat(desktop): authenticate attached primary backends"
```

## Task 3: Add an attachment launch intent and owner-token recovery

**Files:**

- Modify: `apps/server/src/startupAccess.ts`
- Modify: `apps/server/src/startupAccess.test.ts`
- Modify: `apps/server/src/cli/pair.ts`
- Modify: `apps/server/src/cli/pair.test.ts`
- Create: `apps/desktop/src/app/DesktopLaunchIntent.ts`
- Create: `apps/desktop/src/app/DesktopLaunchIntent.test.ts`
- Modify: `apps/desktop/src/app/DesktopClerk.ts`
- Modify: `apps/desktop/src/app/DesktopClerk.test.ts`
- Modify: `apps/desktop/src/electron/ElectronApp.ts`

**Consumes:** `DesktopAttachedBackend.attach` from Task 2.

**Produces:** `t3code://attach-primary` launch handling and `t3 pair --owner`.

- [ ] **Step 1: Write failing startup-output tests**

```ts
expect(buildDesktopAttachUrl("http://127.0.0.1:4773/pair#token=OWNER", "t3code")).toBe(
  "t3code://attach-primary?pairingUrl=http%3A%2F%2F127.0.0.1%3A4773%2Fpair%23token%3DOWNER",
);
```

Test that headless output prints `Desktop attach URL:` for a loopback or wildcard listener. Test that it omits the URL for an explicit non-loopback listener.

- [ ] **Step 2: Write failing launch-intent tests**

Cover initial `process.argv`, macOS `open-url`, and Windows or Linux `second-instance` argv. Reject the wrong scheme, host, duplicate `pairingUrl` fields, and non-HTTP pairing URLs. Confirm that OAuth callback URLs still reach Clerk unchanged.

- [ ] **Step 3: Run the tests and verify that they fail**

Run:

```bash
vp test run apps/server/src/startupAccess.test.ts apps/server/src/cli/pair.test.ts apps/desktop/src/app/DesktopLaunchIntent.test.ts apps/desktop/src/app/DesktopClerk.test.ts
```

Expected: FAIL because attachment URLs and owner pairing do not exist.

- [ ] **Step 4: Extend `t3 serve` output**

Add an optional field:

```ts
export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly token: string;
  readonly pairingUrl: string;
  readonly desktopAttachUrl?: string;
}
```

Use the actual listening port. For an unspecified, loopback, or wildcard host, build the desktop pairing URL with `127.0.0.1`. Do not print an attachment URL for a server bound only to an explicit LAN or tailnet address.

- [ ] **Step 5: Add `t3 pair --owner`**

Add a boolean `--owner` flag. Keep standard scopes as the default. When the flag is present, call `createPairingLink` with `AuthAdministrativeScopes` and label the grant `t3 pair --owner`.

Print the desktop attachment URL when `--owner` resolves an eligible loopback endpoint. This command is the supported recovery path after the stored desktop session expires or is revoked.

- [ ] **Step 6: Capture launch intents before backend startup**

Create a scoped service that queues at most one pending attachment URL. Register `open-url` before `app.whenReady`. Parse the initial argv at process startup. Read `second-instance` argv from the Electron event instead of discarding it.

If the primary instance has not bootstrapped, consume the intent before backend selection. If the app is already running, call `attach`, then request a desktop relaunch. Reveal the existing window for non-attachment second instances.

- [ ] **Step 7: Run the focused tests**

Run the command from Step 3.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/startupAccess.ts apps/server/src/startupAccess.test.ts apps/server/src/cli/pair.ts apps/server/src/cli/pair.test.ts apps/desktop/src/app/DesktopLaunchIntent.ts apps/desktop/src/app/DesktopLaunchIntent.test.ts apps/desktop/src/app/DesktopClerk.ts apps/desktop/src/app/DesktopClerk.test.ts apps/desktop/src/electron/ElectronApp.ts
git commit -m "feat(cli): open serve backends as desktop primary"
```

## Task 4: Serve the bundled client without a desktop backend

**Files:**

- Modify: `apps/desktop/src/app/DesktopEnvironment.ts`
- Modify: `apps/desktop/src/app/DesktopEnvironment.test.ts`
- Modify: `apps/desktop/src/electron/ElectronProtocol.ts`
- Modify: `apps/desktop/src/electron/ElectronProtocol.test.ts`

**Produces:** `DesktopRendererSource` and a packaged-client directory resolved from the desktop server tree.

- [ ] **Step 1: Write failing static-client tests**

Test exact asset reads, correct MIME types, SPA fallback to `index.html`, query-string removal, traversal rejection, missing `index.html`, and requests for another custom-protocol host. Include a packaged Windows fixture whose client lives inside `resources/server.asar/apps/server/dist/client`.

- [ ] **Step 2: Run the tests and verify that they fail**

Run:

```bash
vp test run apps/desktop/src/app/DesktopEnvironment.test.ts apps/desktop/src/electron/ElectronProtocol.test.ts
```

Expected: FAIL because the static renderer source does not exist.

- [ ] **Step 3: Expose the bundled client directory**

Add this field to `DesktopEnvironment`:

```ts
readonly bundledClientDir: string;
```

Resolve it as `<serverRoot>/apps/server/dist/client`. Keep development on `VITE_DEV_SERVER_URL`.

- [ ] **Step 4: Add a renderer-source union**

```ts
export type DesktopRendererSource =
  | { readonly _tag: "Proxy"; readonly origin: URL }
  | { readonly _tag: "Static"; readonly directory: string };
```

Change `DesktopProtocolRegistrationInput.targetOrigin` to `rendererSource`. Keep `backendOrigin` for CSP and diagnostics.

Use the ASAR-aware filesystem to read static files. Normalize the requested path, require it to remain below the client directory, and use `index.html` for paths without a matching asset. Support HTML, JavaScript, CSS, JSON, source maps, SVG, PNG, JPEG, WebP, ICO, WOFF, WOFF2, WASM, and web manifests.

- [ ] **Step 5: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/app/DesktopEnvironment.ts apps/desktop/src/app/DesktopEnvironment.test.ts apps/desktop/src/electron/ElectronProtocol.ts apps/desktop/src/electron/ElectronProtocol.test.ts
git commit -m "feat(desktop): serve the bundled client without a backend"
```

## Task 5: Select attached startup before allocating or starting a backend

**Files:**

- Modify: `apps/desktop/src/app/DesktopApp.ts`
- Create: `apps/desktop/src/app/DesktopApp.test.ts`
- Modify: `apps/desktop/src/window/DesktopWindow.ts`
- Modify: `apps/desktop/src/window/DesktopWindow.test.ts`

**Consumes:** Tasks 2 through 4.

**Produces:** A startup branch that opens the attached primary without starting a child process.

- [ ] **Step 1: Write failing startup tests**

Use test layers with counters for port scanning, exposure configuration, primary start, WSL reconcile, protocol registration, and window readiness.

Assert this attached result:

```ts
expect(calls).toEqual({
  portScan: 0,
  exposureConfigure: 0,
  primaryStart: 0,
  wslReconcile: 0,
  protocolRegister: 1,
  windowReady: 1,
});
```

Also test managed startup, a valid launch intent that attaches before startup, invalid stored attachment state, decryption failure, unreachable endpoint, identity mismatch, Retry, Use managed backend, and Quit.

- [ ] **Step 2: Run the tests and verify that they fail**

Run:

```bash
vp test run apps/desktop/src/app/DesktopApp.test.ts apps/desktop/src/window/DesktopWindow.test.ts
```

Expected: FAIL because startup always selects the backend pool.

- [ ] **Step 3: Move backend selection ahead of port allocation**

After Electron is ready, consume a pending launch intent. Then read the primary backend preference.

For managed mode, keep the current startup sequence. For attached mode, call `DesktopAttachedBackend.probe`, register the bundled static renderer with the attached `backendOrigin`, install IPC, and call `DesktopWindow.handleBackendReady` with the attached HTTP URL.

Apply `DesktopDevelopmentBackendPortRequiredError` only to managed development startup.

- [ ] **Step 4: Add native recovery**

For `invalid-attached`, credential errors, probe errors, and identity mismatch, show a native message box with these buttons:

```ts
["Retry", "Use desktop backend", "Quit"];
```

Retry repeats attachment preparation without changing settings. Use desktop backend persists managed mode and relaunches. Quit requests normal desktop shutdown. Never start the managed backend as an error fallback.

- [ ] **Step 5: Keep shutdown ownership correct**

The existing pool finalizer can stop registered instances because no instance starts in attached mode. Add an assertion that shutdown never sends a signal to the external server PID.

- [ ] **Step 6: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/app/DesktopApp.ts apps/desktop/src/app/DesktopApp.test.ts apps/desktop/src/window/DesktopWindow.ts apps/desktop/src/window/DesktopWindow.test.ts
git commit -m "feat(desktop): start with an attached primary backend"
```

## Task 6: Expose the attached primary through desktop IPC

**Files:**

- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/desktop/src/ipc/channels.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/ipc/DesktopIpcHandlers.ts`
- Create: `apps/desktop/src/ipc/methods/primaryBackend.ts`
- Create: `apps/desktop/src/ipc/methods/primaryBackend.test.ts`
- Modify: `apps/desktop/src/ipc/methods/window.ts`
- Modify: `apps/desktop/src/ipc/methods/window.test.ts`
- Modify: `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts`
- Modify: `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.test.ts`
- Modify: `apps/desktop/src/ipc/methods/serverExposure.ts`
- Create: `apps/desktop/src/ipc/methods/serverExposure.test.ts`
- Modify: `apps/desktop/src/ipc/methods/wsl.ts`
- Modify: `apps/desktop/src/ipc/methods/wsl.test.ts`

**Produces:** Renderer attachment controls, an attached primary bootstrap, and truthful process-control errors.

- [ ] **Step 1: Write failing IPC and authentication tests**

Test that attached mode returns exactly one primary bootstrap even though the pool primary has no current configuration:

```ts
expect(yield * getLocalEnvironmentBootstraps.handler()).toEqual([
  {
    id: PRIMARY_LOCAL_ENVIRONMENT_ID,
    label: "Workstation",
    httpBaseUrl: "http://127.0.0.1:4773/",
    wsBaseUrl: "ws://127.0.0.1:4773/",
    ownership: "attached",
  },
]);
```

Test that `getLocalEnvironmentBearerToken` returns the decrypted attachment token. Test that WSL and exposure mutations fail with `DesktopPrimaryBackendNotManagedError`.

- [ ] **Step 2: Run the tests and verify that they fail**

Run:

```bash
vp test run apps/desktop/src/ipc/methods/primaryBackend.test.ts apps/desktop/src/ipc/methods/window.test.ts apps/desktop/src/backend/DesktopLocalEnvironmentAuth.test.ts apps/desktop/src/ipc/methods/serverExposure.test.ts apps/desktop/src/ipc/methods/wsl.test.ts
```

Expected: FAIL because attached primary IPC does not exist.

- [ ] **Step 3: Add bridge methods**

```ts
getPrimaryBackendState(): Promise<DesktopPrimaryBackendState>;
attachPrimaryBackend(pairingUrl: string): Promise<DesktopPrimaryBackendState>;
refreshAttachedPrimaryCredential(pairingCredential: string): Promise<void>;
useManagedPrimaryBackend(): Promise<void>;
```

Successful mutations request a desktop relaunch. Return redacted state from every method.

- [ ] **Step 4: Route bootstrap and authentication by preference**

In managed mode, retain the pool-backed behavior. In attached mode, synthesize the `primary` bootstrap from stored state and return the decrypted attached bearer credential. Do not add `bootstrapToken` to the attached bootstrap.

- [ ] **Step 5: Guard process-owned mutations**

Before changing WSL, desktop exposure, or Tailscale Serve, require managed mode. Return a typed error in attached mode. Read-only state may report stored inactive preferences, but it must mark them inactive so the renderer does not present them as current server state.

- [ ] **Step 6: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/ipc.ts apps/desktop/src/ipc apps/desktop/src/preload.ts apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts apps/desktop/src/backend/DesktopLocalEnvironmentAuth.test.ts
git commit -m "feat(desktop): expose attached primary backend controls"
```

## Task 7: Keep the attached server on the primary web connection

**Files:**

- Modify: `apps/web/src/environments/primary/target.ts`
- Modify: `apps/web/src/environments/primary/bootstrap.test.ts`
- Modify: `apps/web/src/environments/primary/desktopAuth.ts`
- Modify: `apps/web/src/environments/primary/desktopAuth.test.ts`
- Modify: `apps/web/src/environments/primary/httpLayer.test.ts`
- Modify: `apps/web/src/environments/primary/auth.ts`
- Modify: `apps/web/src/authBootstrap.test.ts`
- Modify: `apps/web/src/components/auth/PairingRouteSurface.tsx`
- Create: `apps/web/src/components/auth/PairingRouteSurface.test.tsx`

**Consumes:** Task 6 bridge methods and bootstrap ownership.

**Produces:** A normal `PrimaryConnectionTarget` with recoverable attached authentication.

- [ ] **Step 1: Write failing primary connection tests**

Test that an attached bootstrap resolves to the attached HTTP and WebSocket URLs while preserving the primary slot. Test that it never produces `BearerConnectionTarget` or a saved-environment record.

Test these authentication states:

- valid stored bearer;
- expired bearer;
- revoked bearer;
- decryption failure;
- replacement owner credential accepted;
- standard pairing credential rejected with owner-token guidance;
- token rejection during an already-open desktop session.

- [ ] **Step 2: Run the tests and verify that they fail**

Run:

```bash
vp test run apps/web/src/environments/primary/bootstrap.test.ts apps/web/src/environments/primary/desktopAuth.test.ts apps/web/src/environments/primary/httpLayer.test.ts apps/web/src/authBootstrap.test.ts apps/web/src/components/auth/PairingRouteSurface.test.tsx
```

Expected: FAIL because the auth gate assumes that every desktop primary has a reusable managed bootstrap credential.

- [ ] **Step 3: Preserve the primary target**

Extend `PrimaryEnvironmentTargetSource` with `"desktop-attached"`. Use bootstrap ownership to select the source. Keep `loadPrimaryConnectionRegistration` and `PrimaryConnectionTarget` unchanged.

- [ ] **Step 4: Make credential failures enter a recoverable auth state**

Change desktop bearer loading so an attached credential failure becomes a typed `requires-auth` result instead of rejecting the root loader. Keep transport failures distinct from authentication failures.

When the pairing screen runs in attached desktop mode, submit the credential through `refreshAttachedPrimaryCredential`. Clear the cached desktop bearer and reload after the main process persists the new token. Keep the browser-session exchange for browser primaries.

Show this recovery instruction:

```text
Run `t3 pair --owner` on the server machine, then paste the new owner token.
```

- [ ] **Step 5: Handle rejection after initial connection**

When an attached primary request or WebSocket-ticket request returns an authentication error, invalidate the renderer token cache and route to the same credential recovery state. Do not create a second environment registration.

- [ ] **Step 6: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/environments/primary apps/web/src/authBootstrap.test.ts apps/web/src/components/auth/PairingRouteSurface.tsx apps/web/src/components/auth/PairingRouteSurface.test.tsx
git commit -m "feat(web): recover attached primary authentication"
```

## Task 8: Add backend source controls and preserve direct interactions

**Files:**

- Create: `apps/web/src/state/desktopPrimaryBackendState.ts`
- Create: `apps/web/src/state/desktopPrimaryBackendState.test.ts`
- Create: `apps/web/src/components/settings/PrimaryBackendSettings.tsx`
- Create: `apps/web/src/components/settings/PrimaryBackendSettings.test.tsx`
- Modify: `apps/web/src/components/settings/ConnectionsSettings.tsx`
- Create: `apps/web/src/components/settings/ConnectionsSettings.attachedPrimary.test.tsx`
- Modify: `apps/web/src/remoteOpen.test.ts`
- Modify: `apps/web/src/browser/browserTargetResolver.test.ts`

**Produces:** A Settings flow and evidence that desktop-native actions still classify the attached primary as local.

- [ ] **Step 1: Write failing UI and classification tests**

Test the managed row, attach dialog, successful relaunch request, attached row, explicit return to managed mode, invalid-attached recovery, and owner-token error copy.

Test that an attached `PrimaryConnectionTarget` resolves editor actions to `local-exec`. Test preview URL resolution against the attached environment. Test that the primary remains absent from the saved-environment list and environment switcher duplicates.

- [ ] **Step 2: Run the tests and verify that they fail**

Run:

```bash
vp test run apps/web/src/state/desktopPrimaryBackendState.test.ts apps/web/src/components/settings/PrimaryBackendSettings.test.tsx apps/web/src/components/settings/ConnectionsSettings.attachedPrimary.test.tsx apps/web/src/remoteOpen.test.ts apps/web/src/browser/browserTargetResolver.test.ts
```

Expected: FAIL because the settings controls do not exist.

- [ ] **Step 3: Add the backend source row**

Under **This environment**, render **Backend process**.

Managed copy:

```text
Started and managed by the desktop app.
```

Attached copy:

```text
Using the T3 server at http://127.0.0.1:4773.
```

The managed action opens a dialog that accepts the full owner pairing URL. The attached action asks for confirmation, calls `useManagedPrimaryBackend`, and relaunches.

- [ ] **Step 4: Separate server settings from process-owned controls**

Use the real primary session scopes for server settings and authorized-client management. In attached mode, render network exposure from the server-reported auth policy as read-only. Hide desktop Tailscale and WSL controls. Keep provider settings, server settings, pairing-link management, diagnostics, projects, terminals, previews, native file selection, theme import, and local editor actions enabled.

Do not report attached `t3 serve` as `desktopManaged`. Preserve the server descriptor because update and restart capability depends on the server launcher.

- [ ] **Step 5: Run the focused tests**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/state/desktopPrimaryBackendState.ts apps/web/src/state/desktopPrimaryBackendState.test.ts apps/web/src/components/settings/PrimaryBackendSettings.tsx apps/web/src/components/settings/PrimaryBackendSettings.test.tsx apps/web/src/components/settings/ConnectionsSettings.tsx apps/web/src/components/settings/ConnectionsSettings.attachedPrimary.test.tsx apps/web/src/remoteOpen.test.ts apps/web/src/browser/browserTargetResolver.test.ts
git commit -m "feat(web): configure the desktop primary backend source"
```

## Task 9: Document ownership boundaries and verify the complete flow

**Files:**

- Modify: `docs/user/remote-access.md`
- Modify: `docs/user/updating.md`
- Modify: `docs/internals/server-updates.md`
- Modify: `docs/internals/resource-telemetry.md`

- [ ] **Step 1: Update the user flow**

Document both attachment paths:

1. Start `npx t3 serve`.
2. Open the printed **Desktop attach URL** to start desktop without another backend.
3. If desktop is already open, paste the owner pairing URL under **Settings** > **Connections** > **Backend process**.
4. To renew access, run `npx t3 pair --owner` and enter the new token.
5. To restore desktop process ownership, select **Use desktop backend**.

State that the server and desktop must share a filesystem namespace. Explain that quitting desktop leaves `t3 serve` running.

- [ ] **Step 2: Document process ownership**

Explain that attached mode preserves direct product interactions but leaves process controls with the terminal or service that launched `t3 serve`. Record the behavior for server updates, host-power monitoring, resource telemetry, WSL, and network exposure.

- [ ] **Step 3: Run all focused tests from Tasks 1 through 8**

Run the exact test commands from each task. Fix any failure before continuing.

- [ ] **Step 4: Run targeted typechecks**

```bash
vp exec --filter @t3tools/contracts -- vp run typecheck
vp exec --filter @t3tools/client-runtime -- vp run typecheck
vp exec --filter @t3tools/server -- vp run typecheck
vp exec --filter @t3tools/desktop -- vp run typecheck
vp exec --filter @t3tools/web -- vp run typecheck
```

Expected: every command exits with status 0.

- [ ] **Step 5: Perform the integrated desktop pass after receiving computer-use permission**

Use an isolated T3 home. Do not point either process at `~/.t3/userdata`.

Verify this sequence:

1. Start `t3 serve` and capture its PID and printed desktop attachment URL.
2. Open the attachment URL while desktop is closed.
3. Confirm that only the captured `t3 serve` PID listens for the primary environment.
4. Change a provider setting and a server setting from desktop. Confirm that the serve process reports both changes.
5. Open a project through the native folder picker. Start a terminal and a provider turn.
6. Open a preview and a local editor action for that project.
7. Quit desktop. Confirm that the captured serve PID remains alive.
8. Restart desktop. Confirm that the same environment reconnects as `primary` without another server.
9. Revoke the desktop session. Confirm that desktop requests an owner token and recovers with `t3 pair --owner`.
10. Stop the captured server. Confirm that Retry does not start a backend.
11. Choose Use desktop backend. Confirm that desktop relaunches and starts one managed backend.

- [ ] **Step 6: Update the final commit**

```bash
git add docs/user/remote-access.md docs/user/updating.md docs/internals/server-updates.md docs/internals/resource-telemetry.md
git commit -m "docs(desktop): explain attached primary backends"
```

## Review checklist

- Every attached startup path reaches backend selection before port allocation.
- No attached error path starts a managed backend without an explicit user action.
- The server-provided environment ID remains authoritative.
- No plaintext pairing credential or bearer token reaches settings, logs, IPC state, or error text.
- A standard pairing token cannot become an attached administrative primary.
- Credential expiry and revocation have a reachable recovery flow.
- The custom protocol keeps Clerk OAuth callbacks working.
- The desktop renderer comes from the desktop package in attached mode.
- The attached primary never appears twice in the environment catalog.
- Native actions run only for the documented shared-filesystem case.
- Process-owned settings are read-only or hidden in attached mode.
- Desktop shutdown never signals the attached server.
