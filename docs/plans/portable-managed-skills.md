Github Tracked: false
Status: completed
Github Issue: none

# T3-managed portable skills

## Goal

Let users create or import a file-backed skill once in T3, inherit or override it per project, temporarily enable or disable it per session, and deliver the resolved skill through provider-native mechanisms. T3 must show what each provider received while leaving provider-owned native skills and configuration untouched.

The first architecture-validating slice delivers managed skills to Claude and Codex. Cursor, Grok, OpenCode, and Antigravity receive normalized native discovery and honest compatibility status until safe session isolation is proven.

## Scope

- In: Environment-global managed skills under the T3 server state directory.
- In: Git-native project state under `<worktree>/.t3code/skills` with inherit, override, and disabled semantics.
- In: Shallow per-session enable/disable overlays.
- In: Provider-native discovery for Claude, Codex, Cursor, Grok, OpenCode, and Antigravity, including fresh, stale, and unavailable state.
- In: Independent import of provider-native skills into T3-owned storage.
- In: Provider compatibility, collision reporting, desired/applied revisions, and structured application failures.
- In: Claude delivery through a session-local T3 plugin and session settings.
- In: Codex delivery through app-server extra roots and thread-local skill configuration.
- In: Compact WebSocket catalog summaries, content-on-demand operations, targeted invalidation, and dedicated web/desktop/mobile skill surfaces.
- In: Bounded global history and rollback; project history continues to use Git.
- Out: A generic resource persistence, resolver, service, or lifecycle framework shared with MCP, commands, agents, or snippets.
- Out: Commands, agents, snippets, native skill editing, native/T3 synchronization, cross-server synchronization, and session-authored skill forks.
- Out: Persistent "Install to runtime" in the first slice. It remains a separate future deployment operation with explicit ownership proof.
- Out: Writing or linking managed definitions into provider-owned user or project directories during normal session delivery.

## Repository findings and constraints

- The requested `docs/agent-workspace-ideas.md` and `docs/research/2026-09-08-durable-project-knowledge-mcp.md` are absent at the investigated HEAD but were inspected from Git commit `f71812025`. Their bounded-projection and desired/applied ideas are useful; their database-authoritative knowledge storage does not apply to skill bodies.
- `packages/contracts/src/server.ts` exposes `ServerProviderSkill`, a native-discovery/composer DTO. Its `enabled` field has provider-dependent meaning and must not become the managed-skill model.
- `packages/client-runtime/src/providerSkills.ts` filters and deduplicates skills by name. That loses native collision and qualified-identity information.
- `apps/server/src/provider/Layers/ProviderRegistry.ts` returns cached or empty provider catalogs on discovery failure without freshness state. Managed native observations need an explicit attempt result.
- `apps/server/src/provider/ProviderDriver.ts` has no skill delivery capability. Add a skills-specific optional adapter instead of broadening it into a generic resource service.
- `apps/server/src/mcp/McpCatalogResolver.ts`, `packages/contracts/src/mcpCatalog.ts`, and `apps/server/src/orchestration/Layers/McpCatalogReactor.ts` provide patterns for pure resolution, desired/applied revisions, and typed receipts. Skills use sibling modules and contracts rather than MCP storage or lifecycle code.
- `apps/server/src/config.ts` derives environment-specific `userdata` and `dev` state directories. Global definitions, global history, and generated session materializations belong below that derived state directory.
- `.t3` is gitignored runtime state and is used by `packages/shared/src/devHome.ts`. Project definitions therefore use `.t3code/skills`, consistent with `apps/server/src/vcs/VcsProjectConfig.ts`.
- `apps/server/src/atomicWrite.ts` handles atomic files. Skill packages need whole-directory staging and rename with recovery.
- Existing watchers in `serverSettings.ts`, `environmentTheme.ts`, and `keybindings.ts` establish the reusable pattern: watch a stable parent, debounce, serialize, rescan from disk, and deduplicate the projection.
- Web, desktop, mobile, relay, tunnel, and T3 Connect all operate against the server's filesystem and provider processes. External OpenCode `serverUrl` configurations are the exception and may use another machine and filesystem.

## Design decisions

### Domain boundaries

- Managed skills and native observations are separate concepts.
- The managed skill package on disk is the only current authored copy. The database may hold indexes, hashes, session overlays, observation caches, desired/applied state, receipts, and history metadata, but not the current `SKILL.md` body or assets.
- Each authored managed definition has an immutable T3 ID. Its portable key controls inheritance and collision matching. Global and project definitions with the same key have distinct definition IDs.
- Provider compatibility and delivery happen after global/project/session resolution. Provider is not another inheritance scope.
- Computed resolved skills, effective catalogs, compatibility projections, and collision projections are not persisted as authored entities.

### Filesystem layout

```text
<stateDir>/
  skills/<key>/
    t3-skill.json
    SKILL.md
    scripts/
    references/
    assets/
    providers/
      codex/openai.yaml
  skill-history/<managed-skill-id>/<revision>/...
  skill-runtime/<session-id>/<desired-revision>/<provider>/...

<worktree>/.t3code/skills/<key>/
  t3-skill.json
  SKILL.md
  scripts/
  references/
  assets/
```

- `SKILL.md` follows the Agent Skills package format. The folder, portable frontmatter name, and key are equal for portability, but the manifest ID remains the identity.
- `t3-skill.json` contains schema version, kind, immutable definition ID where applicable, key, and global revision.
- Project inheritance is represented by the absence of a project entry. A disabled entry contains a manifest tombstone and no body.
- Provider extensions are introduced only when a provider proves the need. The initial concrete extension is Codex `providers/codex/openai.yaml`, mapped during materialization.
- T3-created packages reject unsafe relative paths and symlinks that escape the package. Native imports copy regular files under file-count and byte limits.

### Atomic writes and malformed files

1. Stage the complete package in a sibling temporary directory.
2. Validate the manifest, key, portable frontmatter, size limits, and path containment.
3. Compute a stable hash from sorted relative paths and bytes.
4. Compare the caller's expected revision or hash.
5. Rename the current package to a rollback sibling and the staged package into place.
6. Restore the prior package if the final rename fails.
7. Archive the previous successful global package and emit one key-level invalidation.

- A malformed global definition is unavailable and visible as a diagnostic.
- A malformed project override with a recoverable key blocks the inherited global definition rather than silently exposing it.
- A package whose key cannot be established is an orphan diagnostic and does not mask another key.
- A manually added package without a valid T3 manifest is not silently adopted; the UI may offer explicit import.

### Resolution

For each strict portable key:

1. Index global and project definitions independently. Duplicate keys in one scope are conflicts; traversal order never picks a winner.
2. Start with the global definition, if present.
3. Apply project state: absence inherits, override replaces the global candidate, and disabled suppresses it. An override remains a valid project-only definition if the global definition is later deleted.
4. Apply the session overlay: absence follows project state, disabled suppresses the candidate, and enabled may re-enable an existing underlying definition hidden by project disablement. It cannot recreate deleted or malformed content.
5. Evaluate provider compatibility.
6. Let the provider adapter compare the managed key with provider-native identities and prepare delivery.
7. If an enabled compatible managed skill exists, the adapter must make it the verified T3-session winner or return a limitation/failure. Core never pretends an unresolved collision succeeded.
8. If no managed winner exists, preserve the provider's native behavior.

Deletion and rename rules:

- Deleting a project override or disabled tombstone returns the key to inheritance.
- Deleting a global definition does not delete independent project overrides. Project disabled tombstones remain orphaned and hidden.
- Deleting a session overlay returns to project/global resolution.
- Native deletion is not offered.
- Rename is explicit and atomic, preserves the definition ID, and changes manifest key, directory, and portable name together.
- A global rename does not rewrite project definitions. Existing old-key project definitions stay independent and the UI warns about the changed inheritance relationship.

### Native observations

Native observations contain provider instance, provider-native identity and server-side path, source/scope, display name, provider enabled state, model availability, user invocability, observation time, attempt time, and freshness.

- Successful empty discovery clears previous observations and is fresh.
- Failed discovery retains the last successful observations as stale and records the failure.
- Provider disconnection marks observations unavailable without deleting them.
- Normal snapshots do not expose full native paths; an explicit detail operation may return sanitized provenance when appropriate.

### Provider capabilities

Compatibility has two independent dimensions:

```text
support: supported | supported_with_limitations | unsupported
applicationMode: live | new_session_required | restart_required | unsupported
```

Structured reasons explain version, policy, filesystem, collision, or runtime-isolation limitations.

Claude:

- Expand discovery beyond the current user/project scanner where the pinned SDK can report or safely inspect enterprise, nested, plugin, synced, and added-directory sources.
- Materialize the resolved managed catalog as one local plugin named `t3-managed` under the T3 session runtime directory.
- Pass the plugin through the Agent SDK only for that T3-created provider session.
- For same-key unqualified native skills, pass session-layer `skillOverrides[key] = "off"`.
- Route explicit managed invocations as `/t3-managed:<key>` through `ClaudeSkillDispatch`.
- Treat plugin-qualified native identities as coexisting rather than falsely shadowed.
- Report membership, enablement, or collision changes as `new_session_required` in v1. Enable live body updates only after pinned-version integration tests prove generated plugin watching.
- If policy or provider version blocks plugins or overrides, report a limitation/failure and never write `.claude` files.

Codex:

- Use the app-server `skills/list` result, including its per-cwd errors, as native discovery.
- Materialize one managed winner per key under the session runtime directory.
- Before `thread/start`, call `skills/extraRoots/set` for the session-specific app-server process.
- Force a fresh `skills/list`, identify every native same-key path, and add thread-start `skills.config` entries that disable those exact paths.
- Verify the effective plan before starting the thread.
- Never call persistent `skills/config/write` for session delivery.
- Treat membership and enablement changes as `new_session_required` in v1. Live body reload can be enabled later after `skills/changed` behavior is tested against pinned versions.

Cursor:

- Keep native recursive discovery across `.cursor`, `.agents`, `.codex`, and `.claude` roots.
- Report managed delivery as unsupported until Cursor exposes a session-specific root, plugin, or runtime configuration mechanism. Do not write project or user provider directories.

Grok:

- Keep `grok inspect --json` as the native authority.
- Preserve collision, qualification, source, model availability, and user-invocation information instead of mapping `userInvocable` to `enabled` or deduplicating by bare name.
- Report managed delivery as unsupported until a documented isolated session profile or root override is proven.

OpenCode:

- Preserve SDK/CLI native discovery and version-gate current V2 source semantics.
- A local runtime may use an explicit generated source only after server configuration becomes session-isolated.
- An external server cannot consume a T3-local materialization path; report that filesystem-boundary limitation. A secured HTTP catalog can be evaluated later.

Antigravity:

- Preserve native `.gemini`, `.agents`, and `.agent` observation.
- The existing private `GEMINI_HOME` is per provider instance and cannot safely carry per-session overlays. Delivery remains unsupported until the profile or equivalent capability becomes session-local.
- Gemini CLI reload behavior is supporting evidence only, not proof of Antigravity ACP behavior.

### Provider delivery contract

Add a skills-specific optional adapter associated with each provider instance:

```ts
interface ProviderSkillAdapter {
  discoverNative(context): Promise<NativeSkillDiscoveryResult>;
  evaluateCompatibility(skill, runtime): SkillCompatibility;
  prepareSession(request): Promise<ProviderSkillPlan>;
  applyLive?(request): Promise<ProviderSkillApplyResult>;
  disposeSession(context): Promise<void>;
}
```

- `ProviderSkillPlan` is opaque to core and may contain provider launch options, generated roots, thread config, or invocation mappings.
- Generated runtime directories carry an ownership marker with session ID, provider instance ID, and desired revision.
- Cleanup is restricted to the configured `skill-runtime` directory and valid ownership markers.

### Desired and applied state

- Filesystem or session changes produce a new desired catalog revision.
- Application success advances the applied revision and records per-skill outcomes.
- Application failure leaves desired state intact and retains the last successful applied revision.
- Status is one of applied, pending new session, pending restart, failed, or unsupported.
- Disabling a skill affects future provider availability; it cannot erase instructions already loaded into a model's current context.

### WebSocket contracts

Add `packages/contracts/src/skills.ts` rather than expanding `ServerProviderSkill`.

Compact catalog summaries include ID, key, name, managed/native origin, global/project/provider scope, project state, revision, validity, effective state, compatibility summaries, application status, and conflict/shadow state. They exclude bodies, assets, raw provider configuration, credentials, and full native paths.

Queries:

- `skills.catalog.list`
- `skills.content.get`
- `skills.history.list`
- `skills.native.content.get` with explicit size limits
- `skills.application.get`

Mutations:

- `skills.global.create`, `update`, `delete`, `rename`, and `rollback`
- `skills.project.setOverride`, `setDisabled`, `deleteState`, and `rename`
- `skills.session.setEnabled` and `reset`
- `skills.native.import`

Every project/thread operation resolves its working directory through the server's authoritative thread worktree or project workspace root. Clients never submit a trusted filesystem path. Mutations include an expected revision or hash.

Change notices contain scope, scope ID, catalog revision, and changed keys. Clients refetch compact summaries or an open detail. Existing `server.getProviderCatalog` remains during migration until composer behavior reaches parity.

### UI

- Web/desktop: dedicated Skills catalog, managed editor, native read-only detail with Import into T3, project inherit/override/disabled controls, session enable/disable controls, compatibility/collision/application status, and bounded global history restore.
- Mobile: catalog summaries, managed/native detail, session enable/disable, and application status. Full package authoring may remain web/desktop-only if the limitation is explicit.
- Entry points: Settings and command palette for the catalog; chat capability surface for session controls; applicable keybindings route to the same operations.
- Do not build a universal resource editor.

### Import, ownership, and future installation

- Import reads a native package under limits, copies regular files into a new T3 package, allocates a new T3 ID, normalizes portable metadata, and maps only known provider fields into provider extensions.
- The source remains byte-for-byte untouched and is never linked, adopted, or synchronized.
- A future persistent install is a separate deployment record with provider target, ownership marker, installed hash, and drift state. It refuses collisions and updates/uninstalls only when T3 can prove ownership and the installed hash still matches.

### History and rollback

- Keep a bounded number of prior successful global package snapshots, initially 20.
- Record skill ID, revision, timestamp, operation, previous hash, and new hash.
- Rollback restores a historical package as a new revision; revision numbers never move backward.
- Project definitions rely on Git history.
- Application receipts are operational history and remain separate from authored history.

## Acceptance criteria

- [ ] AC-1: A global managed skill is authored only below the environment state directory, and its current body/assets are absent from the database.
- [ ] AC-2: Global create, edit, delete, rename, and rollback are atomic, revision-checked, and recover the prior package if replacement fails.
- [ ] AC-3: `.t3code/skills` implements deterministic project inherit, override, disabled, deletion, orphan, and Git branch-switch behavior.
- [ ] AC-4: Session state contains only enable/disable overlays and cannot create an authored definition.
- [ ] AC-5: Claude, Codex, Cursor, Grok, OpenCode, and Antigravity expose native observations with fresh, stale, or unavailable discovery state; failure cannot appear as a successful empty result.
- [ ] AC-6: Import creates a new T3-owned package and leaves the native source unchanged.
- [ ] AC-7: A Claude T3 session receives the managed plugin, explicit managed invocation uses its qualified identity, and a colliding unqualified native skill cannot win that invocation.
- [ ] AC-8: A Codex T3 session receives the managed extra root and disables every colliding native path only through thread-local configuration; persistent `skills/config/write` is never called.
- [ ] AC-9: Desired and applied revisions remain separately observable after success, pending application, unsupported delivery, and failure; a failure does not roll back desired state.
- [ ] AC-10: Ordinary workspace/catalog payloads contain summaries only, stay bounded as skill bodies/assets grow, and a one-skill change emits targeted invalidation.
- [ ] AC-11: Web/desktop provide management and editing; mobile provides catalog and session capability state; every surface explains ownership, provenance, compatibility, conflicts, and application status.
- [ ] AC-12: Local, relay, tunnel, and multi-device clients resolve the same server-side environment and authoritative worktree; external provider filesystem boundaries are reported explicitly.
- [ ] AC-13: Malformed packages, duplicate keys, external edits/deletes, concurrent updates, provider extension errors, and Git branch changes produce deterministic diagnostics without silent fallback or data loss.
- [ ] AC-14: Normal management and session delivery never overwrite, delete, adopt, or persistently reconfigure provider-owned native skills.
- [ ] AC-15: The implementation introduces no generic resource repository, resolver, service, or lifecycle abstraction shared with MCP, commands, agents, or snippets.

## Plan

- [x] P0: Prove Claude and Codex delivery against repository-pinned provider versions. Add focused provider fixtures that demonstrate Claude local-plugin qualification plus session overrides and Codex extra roots plus thread-local path disables. Stop and revise the design if either collision guarantee cannot be established without native writes. Dependencies: none. Covers AC-7, AC-8, AC-14.
- [x] P1: Add `packages/contracts/src/skills.ts` with IDs, keys, manifest-facing types, compact summaries, native observations, compatibility, discovery status, session overlays, applications, failures, and mutation inputs. Keep provider-native details out of core types. Dependencies: P0 evidence. Covers AC-5, AC-9, AC-10, AC-15.
- [x] P2: Add `apps/server/src/skills/SkillPackage.ts`, `ManagedSkillRepository.ts`, `SkillCatalogIndex.ts`, and `SkillWatchService.ts`; extend `config.ts` and directory initialization for global, history, and runtime roots. Implement staged package writes, hashes, optimistic concurrency, validation, bounded global history, parent watchers, and full rescan. Dependencies: P1. Covers AC-1, AC-2, AC-3, AC-13.
- [x] P3: Add `NativeSkillObservationService` and adapt all six discovery paths to return an explicit attempt result, stable provider-native identity, separated provider/model/user availability, collision data where available, and fresh/stale/unavailable status. Do not clear observations on failure or disconnect. Dependencies: P1. Covers AC-5, AC-14.
- [x] P4: Add pure `SkillCatalogResolver.ts` and `SkillCatalogProjection.ts`. Implement global/project/session rules, malformed masking, duplicate conflicts, deletion, rename effects, orphan tombstones, provider-independent effective summaries, and native collision inputs. Dependencies: P1-P3. Covers AC-3, AC-4, AC-13, AC-15.
- [x] P5: Add `ProviderSkillAdapter.ts` and `SkillMaterializationService.ts`; attach the optional adapter to provider instances. Use opaque provider plans, package containment checks, runtime ownership markers, and scoped cleanup. Dependencies: P4. Covers AC-7, AC-8, AC-14, AC-15.
- [x] P6: Add skill desired/applied commands, events, projection state, receipts, and `SkillApplicationReactor` alongside MCP orchestration. Persist only compact references and outcomes. Preserve desired state and the last successful applied revision after failure. Dependencies: P4-P5. Covers AC-4, AC-9.
- [x] P7: Implement Codex delivery in the Codex provider boundary and `CodexSessionRuntime.ts`: materialize, set extra roots, force native discovery, calculate all same-key paths, add thread-start disables, verify, and start. Version-gate required protocol methods and prohibit persistent config writes. Dependencies: P0, P5, P6. Covers AC-8, AC-9, AC-14.
- [x] P8: Implement Claude delivery in `ClaudeAdapter.ts`, `ClaudeSkillDispatch.ts`, and a Claude materializer: create the local `t3-managed` plugin, pass it through session SDK options, disable colliding bare native skills in session settings, and route explicit invocations to the qualified identity. Surface policy/version limitations. Dependencies: P0, P5, P6. Covers AC-7, AC-9, AC-14.
- [x] P9: Add compact skills RPCs and server handlers in `packages/contracts/src/rpc.ts` and `apps/server/src/ws.ts`; add `packages/client-runtime/src/skills`. Use authoritative thread/project cwd resolution, content-on-demand, expected revisions, and changed-key notifications. Retain the existing provider catalog until migration reaches parity. Dependencies: P2-P8. Covers AC-10, AC-12.
- [x] P10: Build the dedicated web/desktop Skills catalog, editor, native detail/import affordance, project settings, session controls, and application-status UI. Add the mobile catalog/detail/session surface and route Settings, command palette, chat, and keybinding entry points to the same operations. Dependencies: P9. Covers AC-2, AC-3, AC-4, AC-11.
- [x] P11: Add native import and global rollback services and wire their RPC/UI operations. Enforce copy limits, safe paths, independent IDs, source immutability, bounded history, and rollback-as-new-revision. Dependencies: P2, P3, P9, P10. Covers AC-2, AC-6, AC-14.
- [x] P12: Harden local, relay, tunnel, multi-device, branch-switch, concurrent-edit, partial-failure, and large-catalog behavior. Measure payload size and ensure one-key invalidation. Use isolated T3 state and disposable provider homes. Dependencies: P9-P11. Covers AC-10, AC-12, AC-13.
- [x] P13: Improve discovery parity and capability probes for Cursor, Grok, OpenCode, and Antigravity. Add managed delivery only after a provider-specific session-isolation test passes; otherwise preserve discovery-only support with structured reasons. Dependencies: first slice complete. Covers AC-5, AC-14.
- [x] P14: After the first slice, add explicit persistent runtime installation as a separate deployment service with collision refusal, ownership proof, installed hash, drift detection, and safe update/uninstall. Never make installed provider files canonical. Dependencies: an explicitly chosen set of proven provider adapters. Covers AC-14 and remains outside the first slice.

## Validation

- [x] `vp test run packages/contracts/src/skills.test.ts`
- [x] `vp test run apps/server/src/skills/ManagedSkillRepository.test.ts apps/server/src/skills/SkillPackage.test.ts apps/server/src/skills/SkillWatchService.test.ts`
- [x] `vp test run apps/server/src/skills/SkillCatalogResolver.test.ts apps/server/src/skills/SkillCatalogProjection.test.ts`
- [x] `vp test run apps/server/src/skills/NativeSkillObservationService.test.ts`
- [x] `T3_CLAUDE_TEST_EXECUTABLE=/home/user/.local/bin/claude vp test run apps/server/src/provider/Drivers/ClaudeManagedSkills.test.ts apps/server/src/provider/Layers/CodexManagedSkills.test.ts`
- [x] `vp test run apps/server/src/orchestration/Layers/SkillApplicationReactor.test.ts`
- [x] `vp test run apps/server/src/ws.skills.test.ts`
- [x] `vp test run packages/client-runtime/src/skills/skillCatalog.test.ts`
- [x] `vp test run apps/web/src/features/skills`
- [x] `vp test run apps/mobile/src/features/skills`
- [x] `vp run --filter @t3tools/contracts typecheck`
- [x] `vp run --filter t3 typecheck`
- [x] `vp run --filter @t3tools/client-runtime typecheck`
- [x] `vp run --filter @t3tools/web typecheck`
- [x] `vp run --filter @t3tools/mobile typecheck`
- [x] `git diff --name-only | xargs vp fmt --check` and `git ls-files --others --exclude-standard | xargs vp fmt --check`
- [x] `git diff --check`
- [ ] With explicit approval for computer use, run one isolated web/desktop pass through `test-t3-app` covering create, edit, override, disable, import, collision status, application failure, and rollback.
- [ ] With explicit approval for computer use, run one isolated mobile pass through `test-t3-mobile` covering catalog summaries, session enable/disable, and application status.
- [ ] Run Claude and Codex integration fixtures with disposable provider homes and same-key native collisions; compare native source hashes before and after to prove AC-14.
- [ ] Connect through a remote/relay client to an isolated server state directory and verify that all path resolution and provider application remain server-side.
- [ ] Generate a skill package with large assets and compare ordinary snapshot/catalog payload size before and after; the payload may change only by bounded summary metadata.
- [ ] Switch the fixture repository between branches with different `.t3code/skills` trees and verify one deterministic rescan and effective-catalog update.

## Traceability

- AC-1: P2; repository, rescan, and typecheck validation.
- AC-2: P2, P10, P11; atomic repository, UI, and history tests.
- AC-3: P2, P4, P10; repository, resolver, branch-switch, and UI tests.
- AC-4: P4, P6, P10; resolver, reactor, and UI tests.
- AC-5: P1, P3, P13; contract and native-observation tests.
- AC-6: P11; import tests with before/after native source hashes.
- AC-7: P0, P5, P8; Claude fixture and integration collision tests.
- AC-8: P0, P5, P7; Codex protocol fixture and integration collision tests.
- AC-9: P1, P6-P8; reactor and provider failure tests.
- AC-10: P1, P9, P12; contract, WebSocket, invalidation, and payload-size tests.
- AC-11: P10; focused web/mobile tests and approved integrated client passes.
- AC-12: P9, P12; authoritative-cwd handler and remote/relay tests.
- AC-13: P2, P4, P12; malformed, concurrency, watcher, resolver, and branch-switch tests.
- AC-14: P0, P3, P5, P7, P8, P11, P13-P14; source-hash and no-persistent-write assertions.
- AC-15: P1, P4, P5; dependency and code review plus targeted typechecks.

## Risks and rollback

- Provider protocol or policy differences may invalidate Claude or Codex delivery. P0 is a hard feasibility gate; unsupported versions receive structured capability results rather than native filesystem writes.
- Provider discovery can under-report sources. Preserve unknown/stale states and never infer ownership from a discovered path.
- Watchers can emit duplicate or incomplete event sequences. Treat every debounced event as invalidation and rescan the affected root.
- Project branch switches can replace directory trees. Watch the stable project parent and rebuild the project index rather than applying path-level deltas.
- Generated materializations may survive crashes. Cleanup only valid ownership-marked children of the configured runtime root.
- Skill content may execute scripts or reference files. Preserve provider-native permission and sandbox behavior; importing does not grant trust or tool access.
- Keep the old provider catalog/composer path until the new projection reaches parity. Managed delivery can be disabled per provider without deleting canonical packages.
- Roll back WebSocket consumers independently because `ServerProviderSkill` remains available during migration.
- Rollback never requires restoring provider-native files or settings because normal delivery does not mutate them.

## Outcome

The portable-managed-skills implementation is ready for independent validation. P0-P14 implementation work is present in the dirty candidate; the remaining unchecked validation items are environment-dependent integration/remote/client runs explicitly requiring disposable provider homes, remote connections, or computer-use approval. This record intentionally remains `READY_TO_VALIDATE` rather than completed.

Implementation spans the contracts, server package/index/watch/catalog layers, native observations and import, provider adapters/materialization, Claude and Codex session delivery, discovery-only adapters for Cursor/Grok/OpenCode/Antigravity, orchestration desired/applied events and projections, compact RPCs, client runtime state, web/desktop settings and chat controls, mobile catalog/session surfaces, bounded history/rollback, and the ownership-checked persistent deployment service.

Repair report:

- `apps/server/src/skills/SkillRpcScope.ts` now compares a requested provider instance with the authoritative thread session; `apps/server/src/ws.skills.test.ts` proves a mismatched provider is rejected with `scope_mismatch`.
- `apps/server/src/skills/SkillCatalogService.ts` now records accepted index revisions before publishing; `SkillCatalogService.test.ts` proves duplicate and older invalidations are suppressed while newer revisions pass through.
- Exact-optional typing in the authoritative thread-shell projection was corrected, restoring the server typecheck.
- Claude fixture validation uses the explicit absolute executable environment required by `ClaudeManagedSkills.test.ts`; no live provider files or state were touched.
- Scoped formatter repairs were applied to 18 candidate files; lint remains exit 0 with only nonblocking existing React and schema-hoisting suggestions.
- Astra repair round: empty resolved catalogs now skip provider preparation and Codex skill RPCs; portable frontmatter extensions (including `disable-model-invocation`, `allowed-tools`, and `license`) are schema-validated, deterministically serialized, and preserved through import/create/update/rename/rollback/project seeding/materialization; Claude disables every managed bare key even when discovery omits native sources; first project overrides copy authoritative global assets and extensions into an independent project package. Focused validation passed: 104 tests across contracts, package/repository/import/catalog/adapter/materialization/Codex paths, followed by a 44-test package/import/repository/materialization compatibility rerun; `vp run --filter @t3tools/contracts typecheck` exit 0; `vp run --filter t3 typecheck` exit 0; focused `vp lint` exit 0; focused `vp fmt --check` and `git diff --check` exit 0. Remaining unchecked items are the previously documented disposable-provider, remote/relay, payload-size, branch-switch, and approved computer-use client passes.
- Validation-round-2 findings resolved: known portable frontmatter fields now reject wrong runtime types while preserving unknown safe mappings, including parser/import/external-rescan coverage; Codex materialization validates the pinned `interface` extension shape, maps canonical `providers/codex/openai.yaml` bytes to `agents/openai.yaml`, refuses destination collisions/symlinks, cleans failed preparations, and leaves canonical source bytes stable across repository lifecycle operations. Focused rerun passed: 116 tests; contracts and server typechecks exited 0; targeted lint exited 0 with existing nonblocking schema-hoisting warnings; targeted formatter and `git diff --check` exited 0. The record remains `READY_TO_VALIDATE`; only the previously listed environment-dependent integration passes remain unchecked.
- Validation-round-3 containment findings resolved: runtime-root, session, revision, pending-stage, and provider-root paths are lstat/realpath validated one component at a time; pending stages are created directly beneath the pinned runtime root; directory identity is rechecked before staged writes, owned replacement, cleanup, and publish rename; cleanup refuses symlinks or pathname replacements that do not match the exact stage inode. Focused materialization and adjacent provider suites passed (158 tests), the server typecheck exited 0, and targeted lint, formatter, and `git diff --check` exited 0. The record remains `READY_TO_VALIDATE`; only the previously listed environment-dependent integration passes remain unchecked.
- Validation-round-4 findings resolved: Claude plugin scaffolding now uses the reserved `.t3-claude-plugin` directory outside the portable-key namespace, including a regression for the valid key `plugin`; pending materialization stages retain a pinned inode identity across source inspection, copying, marker writes, replacement, and publication, while deterministic pathname-swap tests prove foreign replacements are preserved and rejected. Focused validation passed 105 tests; server typecheck, targeted lint, formatting, and `git diff --check` exited 0.
- Independent Astra round-5 validation: PASS. It reran 32 focused materialization/provider/package tests and 197 broader related tests across 22 files, reconfirmed the prior frontmatter, Codex extension, empty-catalog, Claude collision, project inheritance, orchestration, RPC, and client repairs, and found no further concrete related defects. `git diff --check` exited 0.

Final focused evidence:

- Contracts: 25 tests passed.
- Server skills: 13 files, 112 tests passed.
- Provider skill/adjacent suites: 368 tests passed with the Claude fixture executable set.
- Orchestration/RPC suites: 100 tests passed; client/web/mobile skill suites: 12 tests passed.
- Scoped typechecks for contracts, server, client-runtime, web, and mobile all exited 0.
- Tracked and untracked candidate `vp fmt --check` plus `git diff --check` all exited 0.

No browsers, dev servers, live T3 state, commits, pushes, or PRs were used. Residual validation limits are the approved-computer-use web/mobile passes, disposable live Claude/Codex collision fixtures, relay/tunnel coverage, large-payload measurement, and Git branch-switch integration. The Codex delivery proof remains protocol-fixture based rather than a live provider integration.
