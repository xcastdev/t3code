import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  McpCatalogOverrideId,
  McpServerId,
  type McpCatalogDefinition,
  type McpCatalogReadResult,
  type McpCatalogSnapshot,
  type McpCatalogTransportInput,
  type ProjectMcpOAuthStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { mcpCatalogEnvironment } from "../../state/resources";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  ResourceEmpty,
  ResourceFailure,
  ResourceHint,
  ResourceQueryNotice,
  ResourceRow,
} from "./ResourceSettingsParts";
import {
  EMPTY_MCP_SERVER_FORM,
  mcpApplicationSummary,
  mcpCatalogRows,
  mcpDefinitionInputFromForm,
  mcpFormFromDefinition,
  mcpOverrideFieldsFromRow,
  mcpOverrideInput,
  mcpOverridePatchFromFields,
  mcpTransportInputFromForm,
  prepareMcpFormSecrets,
  withNewCredentialValues,
  type McpCatalogRow,
  type McpCredentialField,
  type McpNamedCredential,
  type McpOverrideFields,
  type McpOverridePatch,
  type McpServerForm,
  type ResourceSettingsTarget,
} from "./resourceInventory";
import { SettingsSection } from "./settingsLayout";
import { useResourceCommand, type ResourceCommandRunner } from "./useResourceCommand";

/** The scope and revision an editor opened against; its save never uses a newer one. */
interface McpWriteBaseline {
  readonly scope: "global" | "project" | "session";
  readonly scopeId: string;
  readonly revision: number;
}

type McpDialog =
  | {
      readonly kind: "create";
      readonly baseline: McpWriteBaseline;
      /** Chosen up front so prepared secrets are bound to the server they are saved with. */
      readonly logicalServerId: McpServerId;
    }
  | {
      readonly kind: "edit";
      readonly baseline: McpWriteBaseline;
      readonly definition: McpCatalogDefinition;
    }
  | { readonly kind: "override"; readonly baseline: McpWriteBaseline; readonly row: McpCatalogRow };

type ProviderOption = { id: ProviderInstanceId; label: string; enabled: boolean };

function useProviderOptions(target: ResourceSettingsTarget): ReadonlyArray<ProviderOption> {
  const config = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  return (config?.providers ?? []).map((provider) => ({
    id: provider.instanceId,
    label: resolveProviderInstanceDisplayName(provider),
    enabled: provider.enabled,
  }));
}

/**
 * The MCP servers one destination has: the environment's, a project's with its
 * overrides, or a thread session's on top of the baseline it started from.
 * A thread without a session shows its project's servers and nothing to edit.
 */
export function useMcpCatalogView(target: ResourceSettingsTarget) {
  const environmentId = target.environmentId;
  const globalRead = useEnvironmentQuery(
    mcpCatalogEnvironment.read({
      environmentId,
      input: { scope: "global", scopeId: environmentId },
    }),
  );
  const projectRead = useEnvironmentQuery(
    target.projectId === null
      ? null
      : mcpCatalogEnvironment.read({
          environmentId,
          input: { scope: "project", scopeId: target.projectId },
        }),
  );
  // A live view of the thread's session that never starts a provider; null means it has none yet.
  const threadSession = useEnvironmentQuery(
    target.threadId === null
      ? null
      : mcpCatalogEnvironment.sessionForThread({
          environmentId,
          input: { threadId: target.threadId },
        }),
  );
  const snapshot = threadSession.data?.snapshot ?? null;
  const sessionRead = useEnvironmentQuery(
    snapshot === null
      ? null
      : mcpCatalogEnvironment.read({
          environmentId,
          input: { scope: "session", scopeId: snapshot.catalogSessionId },
        }),
  );
  const view = (() => {
    if (globalRead.data === null) return null;
    if (target.projectId === null)
      return {
        own: globalRead,
        scope: { scope: "global" as const, scopeId: environmentId },
        rows: mcpCatalogRows({ inherited: [], own: globalRead.data.definitions, overrides: [] }),
      };
    if (projectRead.data === null) return null;
    const projectRows = mcpCatalogRows({
      inherited: globalRead.data.definitions,
      own: projectRead.data.definitions,
      overrides: projectRead.data.overrides,
    });
    if (target.threadId === null)
      return {
        own: projectRead,
        scope: { scope: "project" as const, scopeId: target.projectId },
        rows: projectRows,
      };
    if (snapshot === null || sessionRead.data === null)
      return { own: null, scope: null, rows: projectRows };
    return {
      own: sessionRead,
      scope: { scope: "session" as const, scopeId: snapshot.catalogSessionId },
      rows: mcpCatalogRows({
        inherited: snapshot.baseline,
        own: sessionRead.data.definitions,
        overrides: sessionRead.data.overrides,
      }),
    };
  })();
  return { globalRead, projectRead, threadSession, snapshot, sessionRead, view };
}

/**
 * Global definitions are edited for the environment. A project view inherits
 * them and overrides any field for itself; a thread view does the same for
 * its live MCP session, once the thread has one. Delivered state is shown only
 * where the server reports it.
 */
export function McpCatalogSettings({ target }: { target: ResourceSettingsTarget }) {
  const environmentId = target.environmentId;
  const { globalRead, projectRead, threadSession, snapshot, sessionRead, view } =
    useMcpCatalogView(target);
  const canWrite = useAtomValue(mcpCatalogEnvironment.write.permissionAtom(environmentId));
  const canOAuth = useAtomValue(mcpCatalogEnvironment.oauthBegin.permissionAtom(environmentId));
  const canReset = useAtomValue(mcpCatalogEnvironment.sessionReset.permissionAtom(environmentId));
  const providers = useProviderOptions(target);
  const providerLabel = (id: ProviderInstanceId) =>
    providers.find((provider) => provider.id === id)?.label ?? id;
  const runner = useResourceCommand();
  const [dialog, setDialog] = useState<McpDialog | null>(null);

  const baseline: McpWriteBaseline | null =
    view?.own?.data && view.scope ? { ...view.scope, revision: view.own.data.revision } : null;
  const writable = canWrite && baseline !== null;
  const rows = view?.rows ?? [];
  const sessionScope = baseline?.scope === "session";
  const inheritedFrom = sessionScope ? "From the project" : "From environment";

  const write = async (
    key: string,
    against: McpWriteBaseline,
    operation: Parameters<typeof mcpCatalogEnvironment.write.run>[1]["input"]["operation"],
  ) => {
    const result = await runner.run(key, mcpCatalogEnvironment.write, {
      environmentId,
      input: { ...against, expectedRevision: against.revision, operation },
    });
    view?.own?.refresh();
    return result.ok;
  };

  /** Exchanges typed values for one-use references bound to this exact write. */
  const prepareSecrets = (
    key: string,
    against: McpWriteBaseline,
    logicalServerId: McpServerId,
    form: McpServerForm,
  ) =>
    prepareMcpFormSecrets(form, async (value) => {
      const result = await runner.run(key, mcpCatalogEnvironment.secretPrepare, {
        environmentId,
        input: {
          scope: against.scope,
          scopeId: against.scopeId,
          expectedRevision: against.revision,
          logicalServerId,
          secret: Redacted.make(value),
        },
      });
      return result.ok ? result.value.secretRef : null;
    });

  const putOverride = (row: McpCatalogRow, against: McpWriteBaseline, patch: McpOverridePatch) => {
    if (against.scope === "global") return Promise.resolve(false);
    const override = mcpOverrideInput({
      scope: against.scope,
      scopeId: against.scopeId,
      row,
      patch,
      newId: McpCatalogOverrideId.make(randomUUID()),
    });
    if (!override.ok) {
      runner.reportFailure(row.definition.definitionId, override.error);
      return Promise.resolve(false);
    }
    return write(row.definition.definitionId, against, {
      type: "put-override",
      override: override.value,
    });
  };

  const toggleOwn = (definition: McpCatalogDefinition, against: McpWriteBaseline) => {
    const input = mcpDefinitionInputFromForm({
      ...mcpFormFromDefinition(definition),
      enabled: !definition.enabled,
    });
    if (!input.ok) {
      runner.reportFailure(definition.definitionId, input.error);
      return;
    }
    void write(definition.definitionId, against, {
      type: "update",
      logicalServerId: definition.logicalServerId,
      definition: input.value,
    });
  };

  const saveDefinition = async (
    current: Extract<McpDialog, { kind: "create" | "edit" }>,
    form: McpServerForm,
  ) => {
    const logicalServerId =
      current.kind === "create" ? current.logicalServerId : current.definition.logicalServerId;
    const prepared = await prepareSecrets("editor", current.baseline, logicalServerId, form);
    if (!prepared.ok) {
      if (prepared.error) runner.reportFailure("editor", prepared.error);
      return;
    }
    const input = mcpDefinitionInputFromForm(prepared.value);
    if (!input.ok) {
      runner.reportFailure("editor", input.error);
      return;
    }
    const ok = await write(
      "editor",
      current.baseline,
      current.kind === "edit"
        ? { type: "update", logicalServerId, definition: input.value }
        : { type: "create", logicalServerId, definition: input.value },
    );
    if (ok) setDialog(null);
  };

  const saveOverride = async (
    current: Extract<McpDialog, { kind: "override" }>,
    form: McpOverrideForm,
  ) => {
    let transport: McpCatalogTransportInput | null = null;
    if (form.replaceTransport) {
      const prepared = await prepareSecrets(
        current.row.definition.definitionId,
        current.baseline,
        current.row.definition.logicalServerId,
        form.server,
      );
      if (!prepared.ok) {
        if (prepared.error)
          runner.reportFailure(current.row.definition.definitionId, prepared.error);
        return;
      }
      const input = mcpTransportInputFromForm(prepared.value);
      if (!input.ok) {
        runner.reportFailure(current.row.definition.definitionId, input.error);
        return;
      }
      transport = input.value;
    }
    const patch = mcpOverridePatchFromFields(form.fields);
    // Nothing pinned is no override: follow the definition entirely.
    if (
      transport === null &&
      patch.name === null &&
      patch.enabled === null &&
      patch.providerInstanceIds === null
    ) {
      const ok =
        current.row.override === null ||
        (await write(current.row.definition.definitionId, current.baseline, {
          type: "remove-override",
          overrideId: current.row.override.id,
        }));
      if (ok) setDialog(null);
      return;
    }
    const ok = await putOverride(current.row, current.baseline, { ...patch, transport });
    if (ok) setDialog(null);
  };

  // An open editor whose scope moved on shows it instead of saving over newer state.
  const dialogConflict = (() => {
    if (dialog === null) return null;
    if (baseline === null || baseline.scope !== dialog.baseline.scope)
      return "This destination isn't editable anymore.";
    if (baseline.scopeId !== dialog.baseline.scopeId)
      return "This thread started a new MCP session since you opened this.";
    if (dialog.kind === "edit" || dialog.kind === "override") {
      const logicalServerId =
        dialog.kind === "edit"
          ? dialog.definition.logicalServerId
          : dialog.row.definition.logicalServerId;
      if (!rows.some((row) => row.definition.logicalServerId === logicalServerId))
        return "This server was removed elsewhere. Your changes are kept here; close to discard them.";
    }
    if (baseline.revision !== dialog.baseline.revision)
      return "These servers changed elsewhere since you opened this. Saving would be rejected; reload to start from the current version.";
    return null;
  })();
  const reloadDialog = () => {
    if (dialog === null || baseline === null) return;
    if (dialog.kind === "create") return setDialog({ ...dialog, baseline });
    if (dialog.kind === "edit") {
      const definition = rows.find(
        (row) =>
          !row.inherited && row.definition.logicalServerId === dialog.definition.logicalServerId,
      )?.definition;
      setDialog(definition ? { kind: "edit", baseline, definition } : null);
      return;
    }
    const row = rows.find(
      (candidate) =>
        candidate.inherited &&
        candidate.definition.logicalServerId === dialog.row.definition.logicalServerId,
    );
    setDialog(row ? { kind: "override", baseline, row } : null);
  };

  const dialogKey =
    dialog === null
      ? ""
      : // A new server has nothing stored to replace, so reloading its baseline
        // keeps the typed form mounted; existing servers remount on their new version.
        dialog.kind === "create"
        ? JSON.stringify([dialog.kind, dialog.logicalServerId])
        : JSON.stringify([
            dialog.kind,
            dialog.baseline,
            dialog.kind === "edit"
              ? dialog.definition.logicalServerId
              : dialog.row.definition.logicalServerId,
          ]);

  return (
    <SettingsSection
      id="mcp-servers"
      title="MCP servers"
      headerAction={
        target.threadId === null || sessionScope ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!writable}
            onClick={() =>
              baseline &&
              setDialog({
                kind: "create",
                baseline,
                logicalServerId: McpServerId.make(randomUUID()),
              })
            }
          >
            <PlusIcon className="size-3.5" />
            {sessionScope
              ? "Add for this thread"
              : target.projectId !== null
                ? "Add project server"
                : "Add server"}
          </Button>
        ) : null
      }
    >
      <ResourceQueryNotice query={globalRead} subject="environment MCP servers" />
      {target.projectId !== null && projectRead.data === null && projectRead.error !== null ? (
        <ResourceQueryNotice query={projectRead} subject="project MCP servers" />
      ) : null}
      {target.threadId !== null ? (
        <McpSessionStatus
          threadSession={threadSession}
          sessionRead={sessionRead}
          snapshot={snapshot}
          runner={runner}
          canReset={canReset && target.threadId !== null}
          onReset={async () => {
            if (snapshot === null || sessionRead.data === null || target.threadId === null) return;
            const result = await runner.run("session-reset", mcpCatalogEnvironment.sessionReset, {
              environmentId,
              input: {
                threadId: target.threadId,
                mcpCatalogSessionId: snapshot.catalogSessionId,
                expectedRevision: sessionRead.data.revision,
              },
            });
            // The thread's session is a live stream and updates itself; only the read is a query.
            if (result.ok) sessionRead.refresh();
          }}
        />
      ) : null}
      {view !== null && rows.length === 0 ? (
        <ResourceEmpty>
          No MCP servers. Servers added here reach only the providers you assign them to.
        </ResourceEmpty>
      ) : null}
      {rows.map((row) => (
        <McpServerRow
          key={row.definition.definitionId}
          row={row}
          inheritedLabel={inheritedFrom}
          overrideLabel={sessionScope ? "Thread override" : "Project override"}
          scopeLabel={sessionScope ? "this thread" : "this project"}
          target={target}
          oauthSession={
            sessionScope && snapshot !== null && target.threadId !== null
              ? { threadId: target.threadId, mcpCatalogSessionId: snapshot.catalogSessionId }
              : null
          }
          runner={runner}
          writable={writable}
          canOAuth={canOAuth}
          providerLabel={providerLabel}
          onEdit={() =>
            baseline && setDialog({ kind: "edit", baseline, definition: row.definition })
          }
          onOverride={() => baseline && setDialog({ kind: "override", baseline, row })}
          onToggle={() => {
            if (baseline === null) return;
            if (row.inherited) void putOverride(row, baseline, { enabled: !row.enabled });
            else toggleOwn(row.definition, baseline);
          }}
          onResetOverride={() =>
            row.override === null || baseline === null
              ? undefined
              : void write(row.definition.definitionId, baseline, {
                  type: "remove-override",
                  overrideId: row.override.id,
                })
          }
          onRemove={() =>
            baseline &&
            void write(row.definition.definitionId, baseline, {
              type: "remove",
              logicalServerId: row.definition.logicalServerId,
            })
          }
        />
      ))}
      {dialog !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        >
          <DialogPopup className="max-w-2xl">
            {dialog.kind === "override" ? (
              <McpOverrideEditor
                key={dialogKey}
                row={dialog.row}
                scopeLabel={dialog.baseline.scope === "session" ? "this thread" : "this project"}
                providers={providers}
                runner={runner}
                conflict={dialogConflict}
                onReload={reloadDialog}
                onSave={(form) => void saveOverride(dialog, form)}
                onClose={() => setDialog(null)}
              />
            ) : (
              <McpServerEditor
                key={dialogKey}
                initial={
                  dialog.kind === "edit"
                    ? mcpFormFromDefinition(dialog.definition)
                    : EMPTY_MCP_SERVER_FORM
                }
                isNew={dialog.kind === "create"}
                providers={providers}
                runner={runner}
                conflict={dialogConflict}
                onReload={reloadDialog}
                onSave={(form) => void saveDefinition(dialog, form)}
                onClose={() => setDialog(null)}
              />
            )}
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}

/**
 * What the thread's MCP session wants and what its provider confirmed. A
 * thread without a session has nothing applied yet, and reading this never
 * starts one.
 */
function McpSessionStatus({
  threadSession,
  sessionRead,
  snapshot,
  runner,
  canReset,
  onReset,
}: {
  threadSession: Parameters<typeof ResourceQueryNotice>[0]["query"];
  sessionRead: Parameters<typeof ResourceQueryNotice>[0]["query"] & {
    data: McpCatalogReadResult | null;
  };
  snapshot: McpCatalogSnapshot | null;
  runner: ResourceCommandRunner;
  canReset: boolean;
  onReset: () => void;
}) {
  if (threadSession.data === null)
    return <ResourceQueryNotice query={threadSession} subject="this thread's MCP session" />;
  if (snapshot === null)
    return (
      <div className="px-3 py-2 sm:px-4">
        <ResourceHint>
          This thread has no MCP session yet, so nothing is applied to it. It starts from the
          project's servers below when its agent next runs; thread-only changes are available then.
        </ResourceHint>
      </div>
    );
  const summary = mcpApplicationSummary(snapshot);
  const customized =
    sessionRead.data !== null &&
    (sessionRead.data.definitions.length > 0 || sessionRead.data.overrides.length > 0);
  return (
    <div className="space-y-1.5 px-3 py-2 sm:px-4">
      <ResourceQueryNotice query={sessionRead} subject="this thread's MCP servers" />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge
          size="sm"
          variant={
            summary.tone === "success"
              ? "success"
              : summary.tone === "warning"
                ? "warning"
                : summary.tone === "error"
                  ? "error"
                  : "info"
          }
        >
          {summary.label}
        </Badge>
        {customized ? (
          <Button
            size="xs"
            variant="ghost"
            className="ms-auto"
            disabled={!canReset || runner.busy}
            onClick={onReset}
          >
            Use project servers again
          </Button>
        ) : null}
      </div>
      <ResourceFailure message={runner.failureFor("session-reset")} />
    </div>
  );
}

function McpServerRow({
  row,
  inheritedLabel,
  overrideLabel,
  scopeLabel,
  target,
  oauthSession,
  runner,
  writable,
  canOAuth,
  providerLabel,
  onEdit,
  onOverride,
  onToggle,
  onResetOverride,
  onRemove,
}: {
  row: McpCatalogRow;
  inheritedLabel: string;
  overrideLabel: string;
  scopeLabel: string;
  target: ResourceSettingsTarget;
  oauthSession: McpOAuthSession | null;
  runner: ResourceCommandRunner;
  writable: boolean;
  canOAuth: boolean;
  providerLabel: (id: ProviderInstanceId) => string;
  onEdit: () => void;
  onOverride: () => void;
  onToggle: () => void;
  onResetOverride: () => void;
  onRemove: () => void;
}) {
  const key = row.definition.definitionId;
  const transport = row.transport;
  const oauth = transport.type !== "stdio" && transport.authorization.type === "oauth";
  const location = transport.type === "stdio" ? transport.command : transport.url;
  return (
    <ResourceRow
      title={<span className="font-medium">{row.name}</span>}
      badges={
        <>
          <Badge size="sm" variant="secondary">
            {transport.type === "stdio"
              ? "Local command"
              : transport.type === "legacy-sse"
                ? "SSE"
                : "HTTP"}
          </Badge>
          {row.inherited ? (
            <Badge size="sm" variant="outline">
              {inheritedLabel}
            </Badge>
          ) : null}
          {row.override !== null ? (
            <Badge size="sm" variant="info">
              {overrideLabel}
              {row.override.transport !== undefined ? " · own connection" : ""}
            </Badge>
          ) : null}
          {!row.enabled ? (
            <Badge size="sm" variant="outline">
              Off
            </Badge>
          ) : null}
        </>
      }
      meta={
        <>
          <span className="block truncate">{location}</span>
          <span className="block">
            {row.providerInstanceIds.length === 0
              ? "Not assigned to any provider, so no session receives it."
              : `For ${row.providerInstanceIds.map(providerLabel).join(", ")}`}
          </span>
          {runner.pendingKey === key ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="size-3" /> Saving…
            </span>
          ) : null}
          <ResourceFailure message={runner.failureFor(key)} />
          {oauth ? (
            <McpOAuthControls
              target={target}
              logicalServerId={row.definition.logicalServerId}
              transportDefinitionId={row.transportDefinitionId}
              session={oauthSession}
              enabled={canOAuth}
            />
          ) : null}
        </>
      }
      actions={
        writable ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${row.name}`}
                  disabled={runner.busy}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {row.inherited ? (
                <>
                  <MenuItem onClick={onOverride}>Override for {scopeLabel}…</MenuItem>
                  {row.override !== null ? (
                    <MenuItem onClick={onResetOverride}>Remove override</MenuItem>
                  ) : null}
                </>
              ) : (
                <MenuItem onClick={onEdit}>Edit…</MenuItem>
              )}
              <MenuItem onClick={onToggle}>
                {row.enabled
                  ? row.inherited
                    ? `Turn off for ${scopeLabel}`
                    : "Turn off"
                  : row.inherited
                    ? `Turn on for ${scopeLabel}`
                    : "Turn on"}
              </MenuItem>
              {row.inherited ? null : (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={onRemove}>
                    Remove
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        ) : null
      }
    />
  );
}

interface McpOAuthSession {
  readonly threadId: NonNullable<ResourceSettingsTarget["threadId"]>;
  readonly mcpCatalogSessionId: McpCatalogSnapshot["catalogSessionId"];
}

const OAUTH_STATUS_LABELS: Record<ProjectMcpOAuthStatus, string> = {
  "not-required": "This server didn't ask for sign-in.",
  "not-connected": "Not signed in.",
  "authorization-pending": "Sign-in started. Finish it in your browser, then continue.",
  // A stored grant is all the server knows; it doesn't prove the server accepts it right now.
  connected: "Sign-in saved. Sessions use it on their next delivery.",
  error: "Sign-in failed. Connect again.",
};

/**
 * OAuth grants belong to a project and the exact connection in use, or to one
 * thread's session. The status is what the server has stored, never a claim
 * about the live connection.
 */
function McpOAuthControls({
  target,
  logicalServerId,
  transportDefinitionId,
  session,
  enabled,
}: {
  target: ResourceSettingsTarget;
  logicalServerId: McpServerId;
  transportDefinitionId: McpCatalogDefinition["definitionId"];
  session: McpOAuthSession | null;
  enabled: boolean;
}) {
  const runner = useResourceCommand();
  const environmentId = target.environmentId;
  const oauthTarget =
    target.projectId === null
      ? null
      : {
          projectId: target.projectId,
          logicalServerId,
          transportDefinitionId,
          ...(session === null ? {} : session),
        };
  const status = useEnvironmentQuery(
    oauthTarget === null
      ? null
      : mcpCatalogEnvironment.oauthStatus({ environmentId, input: oauthTarget }),
  );
  if (oauthTarget === null)
    return (
      <span className="mt-1 block">
        Uses OAuth. Choose a project to sign in; sign-ins are kept per project.
      </span>
    );
  const current = status.data?.status ?? null;
  const begin = async () => {
    const result = await runner.run("oauth", mcpCatalogEnvironment.oauthBegin, {
      environmentId,
      input: oauthTarget,
    });
    if (result.ok) void readLocalApi()?.shell.openExternal(result.value.authorizationUrl);
  };
  const finish = () =>
    runner.run("oauth", mcpCatalogEnvironment.oauthContinue, { environmentId, input: oauthTarget });
  const disconnect = () =>
    runner.run("oauth", mcpCatalogEnvironment.oauthDisconnect, {
      environmentId,
      input: oauthTarget,
    });
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span>
        {current === null
          ? status.error !== null
            ? `Sign-in state unavailable: ${status.error}`
            : "Checking sign-in…"
          : OAUTH_STATUS_LABELS[current]}
      </span>
      {current === "authorization-pending" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!enabled || runner.busy}
          onClick={() => void finish()}
        >
          Continue
        </Button>
      ) : null}
      {current !== "not-required" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!enabled || runner.busy || current === null}
          onClick={() => void begin()}
        >
          {current === "connected" || current === "error" ? "Sign in again" : "Sign in"}
        </Button>
      ) : null}
      {current === "connected" || current === "authorization-pending" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={!enabled || runner.busy}
          onClick={() => void disconnect()}
        >
          Sign out
        </Button>
      ) : null}
      <ResourceFailure message={runner.failureFor("oauth")} />
    </span>
  );
}

function ProviderChecklist({
  providers,
  selected,
  onChange,
}: {
  providers: ReadonlyArray<{ id: ProviderInstanceId; label: string; enabled: boolean }>;
  selected: ReadonlyArray<ProviderInstanceId>;
  onChange: (next: ReadonlyArray<ProviderInstanceId>) => void;
}) {
  const known = new Set(providers.map((provider) => provider.id));
  const unknown = selected.filter((id) => !known.has(id));
  return (
    <fieldset className="space-y-1.5 text-sm">
      <legend className="mb-1.5">Providers</legend>
      <div className="divide-y divide-border/60 rounded-lg border border-input">
        {[...providers, ...unknown.map((id) => ({ id, label: id, enabled: false }))].map(
          (provider) => (
            <label key={provider.id} className="flex cursor-pointer items-center gap-3 px-3 py-2">
              <Checkbox
                checked={selected.includes(provider.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...selected.filter((id) => id !== provider.id), provider.id]
                      : selected.filter((id) => id !== provider.id),
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate text-xs">{provider.label}</span>
              {!provider.enabled ? (
                <span className="text-xs text-muted-foreground">
                  {known.has(provider.id) ? "Disabled" : "Not on this environment"}
                </span>
              ) : null}
            </label>
          ),
        )}
      </div>
      {selected.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          With no provider selected, no session receives it.
        </p>
      ) : null}
    </fieldset>
  );
}

interface McpOverrideForm {
  readonly fields: McpOverrideFields;
  /** The replacement connection, used only when `replaceTransport` is on. */
  readonly server: McpServerForm;
  readonly replaceTransport: boolean;
}

/** Says whether a field follows the definition, with the way back when it doesn't. */
function McpInheritedFieldHint({
  overridden,
  inherited,
  subject,
  onFollow,
}: {
  overridden: boolean;
  inherited: string;
  subject: string;
  onFollow: () => void;
}) {
  if (!overridden)
    return <ResourceHint>{subject} follows the definition until you change it.</ResourceHint>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ResourceHint>{subject} is set here.</ResourceHint>
      <Button type="button" size="xs" variant="ghost" onClick={onFollow}>
        Follow definition ({inherited})
      </Button>
    </div>
  );
}

function McpEditorConflict({
  conflict,
  onReload,
}: {
  conflict: string | null;
  onReload: () => void;
}) {
  if (conflict === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ResourceFailure message={conflict} />
      <Button size="xs" variant="outline" onClick={onReload}>
        Reload current version
      </Button>
    </div>
  );
}

/**
 * Overrides one inherited server for a project or a thread. Every field can
 * be overridden; leaving one as inherited keeps following the definition.
 */
function McpOverrideEditor({
  row,
  scopeLabel,
  providers,
  runner,
  conflict,
  onReload,
  onSave,
  onClose,
}: {
  row: McpCatalogRow;
  scopeLabel: string;
  providers: ReadonlyArray<ProviderOption>;
  runner: ResourceCommandRunner;
  conflict: string | null;
  onReload: () => void;
  onSave: (form: McpOverrideForm) => void;
  onClose: () => void;
}) {
  const ownTransport = row.override?.transport;
  const [form, setForm] = useState<McpOverrideForm>(() => ({
    fields: mcpOverrideFieldsFromRow(row),
    server:
      ownTransport !== undefined
        ? mcpFormFromDefinition({ ...row.definition, transport: ownTransport })
        : withNewCredentialValues(mcpFormFromDefinition(row.definition)),
    replaceTransport: ownTransport !== undefined,
  }));
  const update = (patch: Partial<McpOverrideFields>) =>
    setForm((current) => ({ ...current, fields: { ...current.fields, ...patch } }));
  const { fields } = form;
  const key = row.definition.definitionId;
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          Override {row.definition.name} for {scopeLabel}
        </DialogTitle>
        <DialogDescription>
          The definition stays the same everywhere else. Remove the override to follow it again.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <McpEditorConflict conflict={conflict} onReload={onReload} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block space-y-1.5 text-sm">
            <span>Name in {scopeLabel}</span>
            <Input
              value={fields.name}
              placeholder={row.definition.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Switch
              checked={fields.enabled ?? row.definition.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
            On
          </label>
        </div>
        <McpInheritedFieldHint
          overridden={fields.enabled !== null}
          inherited={row.definition.enabled ? "on" : "off"}
          subject="On or off"
          onFollow={() => update({ enabled: null })}
        />
        <ProviderChecklist
          providers={providers}
          selected={fields.providerInstanceIds ?? row.definition.providerInstanceIds}
          onChange={(providerInstanceIds) => update({ providerInstanceIds })}
        />
        <McpInheritedFieldHint
          overridden={fields.providerInstanceIds !== null}
          inherited="the definition's providers"
          subject="Providers"
          onFollow={() => update({ providerInstanceIds: null })}
        />
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Use a different connection in {scopeLabel}</span>
          <Switch
            checked={form.replaceTransport}
            onCheckedChange={(replaceTransport) =>
              setForm((current) => ({ ...current, replaceTransport }))
            }
          />
        </label>
        {form.replaceTransport ? (
          <>
            <McpTransportFields
              form={form.server}
              onChange={(server) => setForm((current) => ({ ...current, server }))}
            />
            {ownTransport === undefined ? (
              <ResourceHint>
                Secrets don't carry over from the inherited connection. Enter each one again for
                this override.
              </ResourceHint>
            ) : null}
          </>
        ) : null}
        <ResourceFailure message={runner.failureFor(key)} />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={runner.busy || conflict !== null}>
          {runner.busy ? <Spinner className="size-3.5" /> : null}
          Save override
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * A stored secret shows only that it exists. A new value is typed into a
 * masked field and leaves this client only through the protected secret
 * request when saving.
 */
function CredentialEditor({
  value,
  label,
  onChange,
}: {
  value: McpCredentialField;
  label: string;
  onChange: (next: McpCredentialField) => void;
}) {
  if (value.kind === "new-secret")
    return (
      <Input
        size="sm"
        type="password"
        aria-label={`${label} secret value`}
        placeholder="Secret value"
        autoComplete="new-password"
        spellCheck={false}
        value={value.value}
        onChange={(event) => onChange({ ...value, value: event.target.value })}
      />
    );
  return (
    <div className="flex items-center gap-2">
      <Badge size="sm" variant="secondary">
        Stored secret
      </Badge>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => onChange({ kind: "new-secret", name: value.name, value: "" })}
      >
        Replace
      </Button>
    </div>
  );
}

function CredentialList({
  title,
  namePlaceholder,
  items,
  onChange,
}: {
  title: string;
  namePlaceholder: string;
  items: ReadonlyArray<McpNamedCredential>;
  onChange: (next: ReadonlyArray<McpNamedCredential>) => void;
}) {
  return (
    <fieldset className="space-y-1.5 text-sm">
      <legend className="mb-1.5">{title}</legend>
      {items.map((item, index) => (
        <div
          key={item.rowId}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2"
        >
          <Input
            size="sm"
            aria-label={`${title} name`}
            placeholder={namePlaceholder}
            value={item.name}
            onChange={(event) => {
              const name = event.target.value;
              onChange(
                items.map((entry, position) =>
                  position === index
                    ? { ...entry, name, credential: { ...entry.credential, name } }
                    : entry,
                ),
              );
            }}
          />
          <CredentialEditor
            value={item.credential}
            label={item.name || title}
            onChange={(credential) =>
              onChange(
                items.map((entry, position) =>
                  position === index ? { ...entry, credential } : entry,
                ),
              )
            }
          />
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${item.name || title}`}
            onClick={() => onChange(items.filter((_, position) => position !== index))}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          onChange([
            ...items,
            {
              rowId: randomUUID(),
              name: "",
              credential: { kind: "new-secret", name: "", value: "" },
            },
          ])
        }
      >
        <PlusIcon className="size-3.5" />
        Add
      </Button>
    </fieldset>
  );
}

/** The connection part of a server form, shared by definitions and overrides. */
function McpTransportFields({
  form,
  onChange,
}: {
  form: McpServerForm;
  onChange: (next: McpServerForm) => void;
}) {
  const update = (patch: Partial<McpServerForm>) => onChange({ ...form, ...patch });
  const authorization = form.authorization;
  return (
    <>
      <label className="block space-y-1.5 text-sm">
        <span>Transport</span>
        <Select
          value={form.transport}
          onValueChange={(value) => {
            if (value === "streamable-http" || value === "legacy-sse" || value === "stdio")
              update({ transport: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Transport">
            <SelectValue>
              {(value: McpServerForm["transport"]) =>
                value === "stdio"
                  ? "Local command"
                  : value === "legacy-sse"
                    ? "HTTP with SSE (legacy)"
                    : "Streamable HTTP"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
            <SelectItem value="legacy-sse">HTTP with SSE (legacy)</SelectItem>
            <SelectItem value="stdio">Local command</SelectItem>
          </SelectPopup>
        </Select>
      </label>
      {form.transport !== "stdio" ? (
        <>
          <label className="block space-y-1.5 text-sm">
            <span>URL</span>
            <Input
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(event) => update({ url: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Sign-in</span>
            <Select
              value={authorization.type}
              onValueChange={(value) => {
                if (value === "none" || value === "oauth-automatic")
                  update({ authorization: { type: value } });
                if (value === "oauth-pre-registered")
                  update({ authorization: { type: value, clientId: "", clientSecret: null } });
              }}
            >
              <SelectTrigger size="sm" aria-label="Sign-in">
                <SelectValue>
                  {(value: McpServerForm["authorization"]["type"]) =>
                    value === "none"
                      ? "None or headers"
                      : value === "oauth-automatic"
                        ? "OAuth"
                        : "OAuth with a registered client"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="none">None or headers</SelectItem>
                <SelectItem value="oauth-automatic">OAuth</SelectItem>
                <SelectItem value="oauth-pre-registered">OAuth with a registered client</SelectItem>
              </SelectPopup>
            </Select>
          </label>
          {authorization.type === "oauth-pre-registered" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm">
                <span>Client ID</span>
                <Input
                  value={authorization.clientId}
                  onChange={(event) =>
                    update({ authorization: { ...authorization, clientId: event.target.value } })
                  }
                />
              </label>
              <div className="space-y-1.5 text-sm">
                <span className="block">Client secret (optional)</span>
                {authorization.clientSecret === null ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      update({
                        authorization: {
                          ...authorization,
                          clientSecret: { kind: "new-secret", name: "client-secret", value: "" },
                        },
                      })
                    }
                  >
                    <PlusIcon className="size-3.5" /> Add
                  </Button>
                ) : (
                  <CredentialEditor
                    value={authorization.clientSecret}
                    label="Client secret"
                    onChange={(clientSecret) =>
                      update({ authorization: { ...authorization, clientSecret } })
                    }
                  />
                )}
              </div>
            </div>
          ) : null}
          <CredentialList
            title="Secret headers"
            namePlaceholder="X-Api-Key"
            items={form.headers}
            onChange={(headers) => update({ headers })}
          />
        </>
      ) : (
        <>
          <label className="block space-y-1.5 text-sm">
            <span>Command</span>
            <Input
              value={form.command}
              placeholder="npx"
              onChange={(event) => update({ command: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Arguments, one per line</span>
            <Textarea
              size="sm"
              value={form.args}
              onChange={(event) => update({ args: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Working directory (optional)</span>
            <Input value={form.cwd} onChange={(event) => update({ cwd: event.target.value })} />
          </label>
          <CredentialList
            title="Secret environment variables"
            namePlaceholder="API_TOKEN"
            items={form.env}
            onChange={(env) => update({ env })}
          />
        </>
      )}
      <ResourceHint>
        Secret values are sent once, privately, when you save, and are never shown again. Stored
        secrets stay as they are unless replaced.
      </ResourceHint>
    </>
  );
}

function McpServerEditor({
  initial,
  isNew,
  providers,
  runner,
  conflict,
  onReload,
  onSave,
  onClose,
}: {
  initial: McpServerForm;
  isNew: boolean;
  providers: ReadonlyArray<ProviderOption>;
  runner: ResourceCommandRunner;
  conflict: string | null;
  onReload: () => void;
  onSave: (form: McpServerForm) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial);
  const update = (patch: Partial<McpServerForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <DialogHeader>
        <DialogTitle>{isNew ? "Add MCP server" : `Edit ${initial.name}`}</DialogTitle>
        <DialogDescription>
          Saving updates what new and running sessions should receive. Each session reports when it
          actually applied the change.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <McpEditorConflict conflict={conflict} onReload={onReload} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              autoFocus
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Switch checked={form.enabled} onCheckedChange={(enabled) => update({ enabled })} />
            On
          </label>
        </div>
        <ProviderChecklist
          providers={providers}
          selected={form.providerInstanceIds}
          onChange={(providerInstanceIds) => update({ providerInstanceIds })}
        />
        <McpTransportFields form={form} onChange={setForm} />
        <ResourceFailure message={runner.failureFor("editor")} />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={runner.busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={runner.busy || conflict !== null}>
          {runner.busy ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

export type { McpCatalogReadResult };
