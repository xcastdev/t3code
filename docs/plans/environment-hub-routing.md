Github Tracked: false
Status: specified
Github Issue: none

# Environment hub routing and client-created pairing links

## Problem and desired outcome

Connecting a MacBook or phone to several T3 Code environments currently requires configuring each environment separately on each device.

An ordinary T3 Code server should also act as a hub. Devices pair with it once and receive access to an explicit set of linked environments, with separate permissions for each. The hub continues hosting its own projects and agents in the same process.

An authorized client should also be able to create pairing links issued by the server it is connected to. For example, a MacBook creates a link for the main server, then a phone redeems it and connects independently.

## Confirmed current behavior

- Connections and cached state are separated by environment.
- Saved connections currently belong to each client.
- Each environment issues and enforces its own scoped sessions.
- Pairing-link creation already requires `access:write` and the permissions being delegated.
- The CLI currently supports repeated `--scope` flags.

The missing capability is server-owned environment linking and routing, combined with device grants covering explicitly selected environments.

## Scope

In scope:

- Hub capability within an existing coding server.
- Hub-initiated connections using downstream addresses and credentials.
- Explicit permission for a downstream credential to be used for routing.
- Device grants containing an explicit environment list and permissions per environment.
- Settings flows for managing links and issuing pairing links.
- Shared permission presets for Settings and CLI.
- Web, desktop, and mobile access through the hub.
- Server operations exposed through shared services, with thin transport handlers, including appropriate MCP access.

Out of scope:

- A separate hub service or dedicated deployment.
- Nested hubs, routing chains, and automatic transitive discovery. Routing supports one hop: device → hub → downstream environment.
- Moving projects, threads, providers, or execution between environments.
- OS-level isolation or a new execution security model.

## Preserved invariants

- Projects, threads, files, providers, and execution remain owned by their original environment.
- Environment identity stays independent of its connection route.
- The downstream server remains authoritative for permissions it grants.
- Existing direct connections and T3 Connect continue working.
- Credentials stay private to the component that needs them.
- Presets cannot silently expand previously issued grants.
- Pairing-link expiry and session lifetime remain distinct.

## Acceptance criteria

### Hub connections

- [ ] AC-1: A normal T3 Code server routes linked environments while continuing to serve its own coding workloads. No separate service is required.
- [ ] AC-2: An authorized administrator can add a downstream environment using its address and token or existing pairing link. The hub initiates the connection.
- [ ] AC-3: Linking verifies the downstream environment's identity, credential validity, and explicit routing permission. Missing permission produces an actionable error.
- [ ] AC-4: Link configuration and credentials survive hub restarts.
- [ ] AC-5: Devices paired with the hub can use permitted downstream environments without pairing with them separately or having direct network access to them.
- [ ] AC-6: Routing supports the HTTP, WebSocket, subscription, file, terminal, preview, and media paths required by permitted features. It is not limited to chat RPCs.

### Permissions and lifecycle

- [ ] AC-7: A device grant explicitly identifies its allowed environments and permissions on each, including the hub's own environment when selected.
- [ ] AC-8: Linking another environment never adds it to existing device grants or outstanding pairing links.
- [ ] AC-9: Each routed operation requires both the device's permission for that environment and the downstream credential's routing and operation permissions.
- [ ] AC-10: Unauthorized environments are absent from device discovery and cannot be accessed by supplying their IDs or URLs directly.
- [ ] AC-11: Downstream credentials are never returned to devices through listings, errors, logs, or pairing links.
- [ ] AC-12: Administrators can disable, re-enable, remove, and replace credentials for a link. Re-enabling a link does not widen device grants.
- [ ] AC-13: Revoking device access or removing a link terminates affected active routed access and prevents new access. Already committed work and running downstream agents continue.
- [ ] AC-14: A downstream failure affects that environment; the hub and other linked environments remain usable. Hub loss disconnects routed access without stopping downstream agents.
- [ ] AC-15: Reconnecting does not automatically replay mutations that might already have executed.

### Settings and presets

- [ ] AC-16: Settings → Connections provides an authorized flow to add a linked environment, test its connection, inspect routing eligibility, and manage its lifecycle.
- [ ] AC-17: Pairing-link creation offers environment selection and a permission preset per environment, with advanced permission customization.
- [ ] AC-18: Settings and CLI use identical preset definitions, with the intended access described below.

| Preset   | Intended access                                      |
| -------- | ---------------------------------------------------- |
| `viewer` | Read threads, history, and files                     |
| `coding` | Operate agents, terminals, files, and source control |
| `admin`  | Full environment administration                      |

- [ ] AC-19: Routing permission is an explicit additional choice, excluded from every preset by default.
- [ ] AC-20: Presets expand into explicit permissions at issuance. Existing grants remain unchanged when preset definitions change.
- [ ] AC-21: CLI supports the agreed shortcuts below. Advanced scope selection remains available. Invalid, ambiguous, or unauthorized selections fail without issuing a broader grant.

Proposed CLI syntax to implement:

```sh
# On a downstream server: create a grant for the main server.
t3 pair --preset coding --allow-routing

# On the main server: grant a device access to selected environments.
t3 pair --preset coding --environment main --environment linux
```

### Client-created pairing links

- [ ] AC-22: An authorized MacBook client can request a pairing link issued by its connected main server. It does not require local server access or a CLI.
- [ ] AC-23: The issuer needs pairing-management permission and authority to delegate every selected environment and permission. The server rejects broader requests.
- [ ] AC-24: The resulting link or QR code pairs the phone with the main server, carrying the selected grant. It does not pair the phone with the MacBook.
- [ ] AC-25: After redemption, the phone works independently of the MacBook. Disconnecting the MacBook does not invalidate the phone's session.
- [ ] AC-26: Existing one-time redemption, expiry, and revocation protections apply. Expired, consumed, and revoked links fail clearly.

### Compatibility and surfaces

- [ ] AC-27: Web, desktop, and mobile support the routing and pairing-management flows according to their permissions.
- [ ] AC-28: Servers advertise hub support. Older servers remain usable for direct connections and are not silently treated as routing-capable.
- [ ] AC-29: Existing credentials do not automatically acquire routing permission or access to linked environments.
- [ ] AC-30: Hub management and pairing issuance share server-side authorization across UI, CLI, and applicable MCP operations.

## Confirmed decisions and assumptions

- The hub runs in the same process as a normal coding server.
- The hub connects to downstream environments using their existing connection model; downstream environments do not initiate registration with the hub.
- Downstream credentials require explicit routing permission.
- Device access uses an explicit environment list with per-environment permissions. New links never expand existing grants.
- Settings and CLI share presets, with routing enabled separately.
- Authorized remote clients can create pairing links issued by their connected main server.
- Routing supports one hop only: device → hub → downstream. Nested hubs, routing chains, and transitive discovery are excluded.
- Existing execution trust is preserved: grants constrain client access, while terminal and full-access agent users remain trusted with the machine they can execute on. OS-level isolation is excluded.
- CLI examples use unique environment labels resolved to stable IDs; ambiguous labels fail.
- Existing pairing-link lifetime defaults remain in place unless explicitly changed.

## Material risks

The hub becomes a trusted credential holder and a required network path for routed access. Proxying must preserve streaming, cancellation, authorization, and environment isolation without duplicating unnecessary data.

Existing T3 Code semantics also matter: terminal access and full-access agents execute as the server's OS user and can obtain that server's credentials. Therefore, `coding` versus `admin`, or withholding routing permission, cannot create a hard security boundary against someone with arbitrary execution on that machine.

## Open questions

None. The one-hop routing scope and existing execution trust model were explicitly approved.

## Delivery state

This is the approved behavioral specification. An implementation plan has not been created, and implementation has not started.

READY_FOR_PLAN
