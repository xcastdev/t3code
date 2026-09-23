Github Tracked: false
Status: in_progress
Github Issue: none

# Managed commands and snippets

## Goal

Let users create reusable prompt commands and text snippets in T3, inherit or override them per project, and optionally enable them per thread. Selecting one inserts editable composer text without sending. Managed agents remain deferred until providers expose a reliable named native-subagent launch path.

## Scope

- In: Environment definitions, Git-native project override/disable entries, and thread enablement for commands and snippets, following managed skills' scope semantics.
- In: `/command` expansion with one trailing text argument and `$ARGUMENTS`; single-colon `:snippet` insertion at the caret.
- In: Source-labeled managed and provider-native slash commands in one picker, with explicit selection on name collisions.
- In: Web/desktop and mobile management and composer flows, including remote connections through server RPC.
- Out: `$agent` selection or agent CRUD/delivery, provider-native import/install/editing, automatic sending, and a generic resource framework shared with skills or MCP.

## Acceptance criteria

- [x] AC-1: Users can create, read, edit, delete, disable, and restore managed commands and snippets in environment and project scopes. A stale expected revision fails without overwriting newer content. (P1, P2; contract/repository tests)
- [x] AC-2: A project inherits each environment key until it overrides or disables it; a thread can enable or disable the effective entry. Clients show source and effective state. (P2, P5; resolver/RPC/client tests)
- [x] AC-3: Selecting a managed `/command` inserts its selected revision as editable text without sending. One trailing text argument replaces every `$ARGUMENTS`; if absent from the template, a nonempty argument follows the template. (P1, P3, P4; expansion/composer tests)
- [x] AC-4: Selecting `:snippet` inserts its selected text at the caret, leaves the draft editable, and never starts a turn. (P3, P4; trigger/composer tests)
- [x] AC-5: Provider-native commands keep their current behavior. Managed and native commands with the same name both appear with source labels and require a choice; neither silently shadows the other. (P3, P4; picker regression tests)
- [x] AC-6: Editing or deleting a definition after selection cannot silently change the inserted draft. Stale content fetches require reselection; already inserted text survives catalog refresh and remains editable. (P1, P2, P3, P4; stale-selection tests)
- [x] AC-7: Management and use work from local, relay, and tunnel clients through the server's authorization and RPCs, with bounded catalog summaries, content-on-demand, and an audit trail for mutations. (P1, P2, P5; RPC tests and connection-path inspection)
- [x] AC-8: Existing `!` skills, raw Codex `$name` skills, `/` native commands, and `#` issue/PR references behave as before on web/desktop/mobile; single-colon snippets add no ambiguous `$` behavior. (P3, P4; trigger regression tests)

## Design decisions

- Add sibling text-resource contracts and server modules. Environment definitions live under the derived T3 state directory; project definitions live under `<project>/.t3code/commands` and `<project>/.t3code/snippets`. Absence means inherit; an explicit project entry overrides or disables. Thread overlays follow the skills model. Stable IDs identify definitions and keys control inheritance. Content hashes/revisions protect mutations. Keep bodies out of catalog summaries.
- Selection fetches the chosen ID and revision, then performs pure text expansion on the client. Reject a stale fetch before insertion. After insertion, the text is ordinary draft content and catalog changes cannot rewrite it. No resource metadata travels with a sent turn.
- Preserve native slash command dispatch. The picker keeps separate, source-qualified items even when names match. The single-colon trigger applies to snippets only. Existing `!`, `$`, `#`, and `@` handling stays intact.
- Normal use does not write provider-owned files. Mutation records identify scope, resource ID, revision, and action without logging resource bodies. Catalog subscriptions invalidate by key with bounded payloads.
- The former P1 feasibility gate found no deterministic named-subagent launch in the installed Claude SDK or Codex app-server. Managed agents are a later product decision and are excluded from this release.

## Plan

- [x] P1: `packages/contracts/src/managedTextResources.ts`, `rpc.ts`, and package exports: define bounded command/snippet schemas, IDs, keys, revisions, scope/effective summaries, content-on-demand, expected-revision CRUD, thread overlays, and audit metadata. Add discriminating contract tests.
- [x] P2: `apps/server/src/managedTextResources/`, persistence/migrations, and `apps/server/src/ws.ts`: implement atomic environment/project writes, resolver and malformed override behavior, expected-revision conflicts, deletion/restore, per-thread overlays, authorization, bounded subscription, and mutation audit. Add focused repository, resolver, and RPC tests.
- [x] P3: `packages/shared/src/composerTrigger.ts`, `packages/client-runtime/src/managedTextResources/`, and draft helpers: implement single-colon detection and pure insertion/command expansion. Keep provider-native commands as distinct items. Cover trailing arguments, placeholders, caret position, stale fetch, and existing triggers.
- [x] P4: `apps/web/src/composer-logic.ts`, `apps/web/src/components/chat/{ChatComposer,ComposerCommandMenu}.tsx`, and mobile thread/new-task composer/menu: wire source-labeled choices, content fetch, editable insertion, and no-send behavior on both clients. Preserve native dispatch and keyboard paths. Add focused picker/composer tests.
- [x] P5: `packages/client-runtime/src/state/`, web settings/routes, mobile settings/routes, and `docs/user/composer.md`: expose environment/project CRUD, thread enablement, effective state, and concise user guidance. Web changes cover desktop. Add focused settings/client tests and inspect remote connection usage.
- [x] P6: Run the focused validation below, inspect all entry points and connection modes, and record exact results in Outcome.

## Validation

- [x] `vp test run packages/contracts/src/managedTextResources.test.ts packages/shared/src/composerTrigger.test.ts packages/client-runtime/src/managedTextResources/managedTextResources.test.ts`
- [x] `vp test run apps/server/src/managedTextResources/ManagedTextResourceRepository.test.ts apps/server/src/managedTextResources/ManagedTextResourceResolver.test.ts apps/server/src/managedTextResources/ManagedTextResourceRpc.test.ts`
- [x] `vp test run apps/web/src/composer-logic.test.ts apps/web/src/features/managedTextResources/managedTextResources.test.ts apps/mobile/src/features/threads/use-composer-command-menu.test.ts apps/mobile/src/features/managedTextResources/managedTextResources.test.ts`
- [x] `vp run -F @t3tools/contracts -F @t3tools/shared -F @t3tools/client-runtime -F t3 -F @t3tools/web -F @t3tools/mobile typecheck`
- [x] `vp lint packages/contracts/src/managedTextResources.ts packages/contracts/src/rpc.ts packages/shared/src/composerTrigger.ts packages/client-runtime/src/managedTextResources apps/server/src/managedTextResources apps/web/src/composer-logic.ts apps/web/src/components/chat/ChatComposer.tsx apps/web/src/components/chat/ComposerCommandMenu.tsx apps/web/src/features/managedTextResources apps/mobile/src/features/managedTextResources apps/mobile/src/features/threads apps/mobile/src/components/ComposerEditor.tsx --report-unused-disable-directives`

## Risks and rollback

- Web and mobile use different trigger parsers and draft editors. Shared expansion tests plus client-specific picker tests must cover both.
- Project files can change outside T3. Invalid overrides must not silently expose an inherited entry with the same key. Use atomic writes and revision checks.
- Disable the new catalog and picker paths if needed; existing native commands, skills, drafts, and provider configuration need no migration back.

## Outcome

Implemented managed commands and snippets across contracts, server persistence/RPC, client runtime, web/desktop, and mobile. The catalog supports environment and project definitions, disable/restore, thread enablement, revision conflicts, bounded summaries, content-on-demand, and mutation audit. Composer selection inserts editable text without sending; native commands and existing triggers remain available. Managed agents remain deferred by the native-agent feasibility decision.

Validation: shared/contract/runtime tests 4 files, 28 passed; server tests 3 files, 14 passed; web/mobile tests 6 files, 108 passed. Six-package scoped typecheck passed. Targeted lint passed with existing warnings; `git diff --check` passed. A live local web pass covered environment command and snippet create/edit/delete, environment disable/restore, project inheritance/disable/restore/override, thread disable/enable, command argument expansion, snippet insertion, separate managed/native collision choices, and retained draft text after deletion. No turns were sent. Connection-path inspection covered common RPC authorization/subscription usage for local, relay, and tunnel; live remote and mobile testing remain deferred. The unrelated pre-existing `pnpm-lock.yaml` worktree change was preserved.

A second local web pass used two browser sessions and a disposable project. It found that a stale editor's Retry button repeated the obsolete revision request, and a concurrently deleted entry had the same dead end. The editor now offers explicit recovery: Load latest version for an edit conflict, or Start new resource after deletion while keeping unsaved text readable until chosen. Both paths were verified in the browser. The pass also covered project edit conflicts, environment disable with a project override, argument insertion with and without `$ARGUMENTS`, literal `$&`/`$$`, partial-name keyboard selection, insertion at a middle caret, and distinct native/managed `/feedback` choices. After the fixes, web typecheck, 91 focused tests, targeted lint, format check, and `git diff --check` passed. Screenshots and exact observations are in [the isolated web evidence](/tmp/t3code-web-managed.VvjHOw/evidence/README.md). No turn was sent; mobile and live remote tests remain deferred.
