import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { sessionSkillDeliveryLabel } from "@t3tools/client-runtime/skills";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  ManagedSkillKey,
  type ManagedSkillContentDraft,
  type ProviderInstanceId,
  type SkillCatalogListResult,
  type SkillCatalogRevision,
  type SkillCatalogSummary,
  type SkillContentDetail,
  type SkillDeploymentTargetSummary,
  type SkillManagedCatalogSummary,
  type SkillNativeCatalogSummary,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { skillsEnvironment } from "../../state/resources";
import { serverEnvironment } from "../../state/server";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import { Textarea } from "../ui/textarea";
import {
  ResourceEmpty,
  ResourceFailure,
  ResourceHint,
  ResourceQueryNotice,
  ResourceRow,
} from "./ResourceSettingsParts";
import {
  describeResourceFailure,
  resourceEditorConflict,
} from "@t3tools/client-runtime/resource-actions";
import {
  resourceCatalogInput,
  skillActions,
  skillEntryId,
  skillKeyCollisions,
  skillReloadBaseline,
  type ResourceSettingsTarget,
} from "./resourceInventory";
import { SettingsSection } from "./settingsLayout";
import { useResourceCommand, type ResourceCommandRunner } from "./useResourceCommand";

const decodeKey = Schema.decodeUnknownOption(ManagedSkillKey);
const decodeName = Schema.decodeUnknownOption(TrimmedNonEmptyString);
const NATIVE_PREVIEW_BYTES = 64 * 1024;

type ManagedEntry = SkillManagedCatalogSummary;
type NativeEntry = SkillNativeCatalogSummary;

/** Create and project writes are checked against the catalog revision the dialog opened on. */
type SkillDialog =
  | {
      readonly kind: "create";
      readonly scope: "global" | "project";
      readonly catalogRevision: SkillCatalogRevision;
    }
  | {
      readonly kind: "edit";
      readonly entry: ManagedEntry;
      readonly catalogRevision: SkillCatalogRevision;
    }
  | {
      readonly kind: "override";
      readonly entry: ManagedEntry;
      readonly catalogRevision: SkillCatalogRevision;
    }
  | { readonly kind: "rename"; readonly entry: ManagedEntry }
  | { readonly kind: "history"; readonly entry: ManagedEntry }
  | { readonly kind: "install"; readonly entry: ManagedEntry }
  | { readonly kind: "native"; readonly entry: NativeEntry };

function useProviderNames(target: ResourceSettingsTarget) {
  const config = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const providers = config?.providers ?? [];
  return (id: ProviderInstanceId) => {
    const provider = providers.find((candidate) => candidate.instanceId === id);
    return provider ? resolveProviderInstanceDisplayName(provider) : id;
  };
}

function skillSourceLabel(
  entry: SkillCatalogSummary,
  providerName: (id: ProviderInstanceId) => string,
) {
  if (entry.origin === "native") return providerName(entry.providerInstanceId);
  return entry.scope === "project" ? "Project" : "Environment";
}

const skillCatalogInput = (target: ResourceSettingsTarget) => ({
  ...resourceCatalogInput(target),
  ...(target.threadId !== null && target.providerInstanceId !== null
    ? { providerInstanceId: target.providerInstanceId }
    : {}),
});

export function SkillsSettings({ target }: { target: ResourceSettingsTarget }) {
  const input = skillCatalogInput(target);
  const catalog = useEnvironmentQuery(
    skillsEnvironment.catalog({ environmentId: target.environmentId, input }),
  );
  const runner = useResourceCommand();
  const canWriteGlobal = useAtomValue(
    skillsEnvironment.globalUpdate.permissionAtom(target.environmentId),
  );
  const canWriteProject = useAtomValue(
    skillsEnvironment.projectSetOverride.permissionAtom(target.environmentId),
  );
  const canWriteSession = useAtomValue(
    skillsEnvironment.sessionSetEnabled.permissionAtom(target.environmentId),
  );
  const providerName = useProviderNames(target);
  const [dialog, setDialog] = useState<SkillDialog | null>(null);
  const data = catalog.data;
  const context = { projectId: target.projectId, threadId: target.threadId };
  const canWrite =
    target.threadId !== null
      ? canWriteSession && target.providerInstanceId !== null
      : target.projectId !== null
        ? canWriteProject
        : canWriteGlobal;
  const collisions = skillKeyCollisions(data?.entries ?? []);
  const managed = (data?.entries ?? []).filter(
    (entry): entry is ManagedEntry => entry.origin === "managed",
  );
  const native = (data?.entries ?? []).filter(
    (entry): entry is NativeEntry => entry.origin === "native",
  );

  // A row's failure shows on that row (keyed like its other actions); reset-all
  // shows under the section header.
  const sessionReset = (entry: ManagedEntry | null) => {
    if (data === null || target.threadId === null || target.providerInstanceId === null) return;
    void runner
      .run(entry === null ? "session-reset" : skillEntryId(entry), skillsEnvironment.sessionReset, {
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          providerInstanceId: target.providerInstanceId,
          expectedRevision: data.catalogRevision,
          ...(entry === null ? {} : { key: entry.key }),
        },
      })
      .then(catalog.refresh);
  };
  const sessionToggle = (entry: ManagedEntry, enabled: boolean) => {
    if (data === null || target.threadId === null || target.providerInstanceId === null) return;
    void runner
      .run(skillEntryId(entry), skillsEnvironment.sessionSetEnabled, {
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          providerInstanceId: target.providerInstanceId,
          expectedRevision: data.catalogRevision,
          key: entry.key,
          enabled,
        },
      })
      .then(catalog.refresh);
  };
  const projectChange = (entry: ManagedEntry, change: "disable" | "reset") => {
    if (data === null || target.projectId === null) return;
    const command =
      change === "disable"
        ? skillsEnvironment.projectSetDisabled
        : skillsEnvironment.projectDeleteState;
    void runner
      .run(skillEntryId(entry), command, {
        environmentId: target.environmentId,
        input: {
          projectId: target.projectId,
          expectedRevision: data.catalogRevision,
          key: entry.key,
        },
      })
      .then(catalog.refresh);
  };
  const remove = (entry: ManagedEntry) => {
    void runner
      .run(skillEntryId(entry), skillsEnvironment.globalDelete, {
        environmentId: target.environmentId,
        input: {
          environmentId: target.environmentId,
          skillId: entry.id,
          expectedHash: entry.revision.hash,
        },
      })
      .then(catalog.refresh);
  };

  const headerAction =
    target.threadId === null ? (
      <Button
        size="xs"
        variant="outline"
        disabled={!canWrite || data === null}
        onClick={() =>
          data &&
          setDialog({
            kind: "create",
            scope: target.projectId === null ? "global" : "project",
            catalogRevision: data.catalogRevision,
          })
        }
      >
        <PlusIcon className="size-3.5" />
        {target.projectId === null ? "New skill" : "New project skill"}
      </Button>
    ) : (
      <Button
        size="xs"
        variant="ghost"
        disabled={!canWrite || data === null || runner.busy}
        onClick={() => sessionReset(null)}
      >
        Reset thread changes
      </Button>
    );

  return (
    <SettingsSection id="skills" title="Skills" headerAction={headerAction}>
      <ResourceQueryNotice query={catalog} subject="skills" />
      {target.threadId !== null && runner.failureFor("session-reset") !== null ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
          <ResourceFailure message={runner.failureFor("session-reset")} />
          <Button
            size="xs"
            variant="outline"
            disabled={!canWrite || data === null || runner.busy}
            onClick={() => sessionReset(null)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {target.threadId !== null && target.providerInstanceId === null ? (
        <div className="px-3 py-2 sm:px-4">
          <ResourceHint>
            This thread has no provider yet, so session overlays are unavailable.
          </ResourceHint>
        </div>
      ) : null}
      {data !== null && managed.length === 0 && native.length === 0 ? (
        <ResourceEmpty>
          No skills yet. Managed skills you create here are delivered to supported providers;
          provider skills appear as each provider reports them.
        </ResourceEmpty>
      ) : null}
      {managed.map((entry) => (
        <SkillRow
          key={skillEntryId(entry)}
          entry={entry}
          collides={collisions.has(entry.key)}
          sourceLabel={skillSourceLabel(entry, providerName)}
          showDelivery={target.threadId !== null}
          runner={runner}
          actions={canWrite && data !== null ? skillActions(entry, context, data.entries) : []}
          onAction={(action) => {
            if (data === null) return;
            const catalogRevision = data.catalogRevision;
            switch (action) {
              case "edit":
              case "edit-override":
                setDialog({ kind: "edit", entry, catalogRevision });
                return;
              case "override":
                setDialog({ kind: "override", entry, catalogRevision });
                return;
              case "rename":
              case "rename-override":
                setDialog({ kind: "rename", entry });
                return;
              case "history":
                setDialog({ kind: "history", entry });
                return;
              case "install":
                setDialog({ kind: "install", entry });
                return;
              case "delete":
                remove(entry);
                return;
              case "disable-project":
                projectChange(entry, "disable");
                return;
              case "reset-project":
                projectChange(entry, "reset");
                return;
              case "session-enable":
                sessionToggle(entry, true);
                return;
              case "session-disable":
                sessionToggle(entry, false);
                return;
              case "session-reset":
                sessionReset(entry);
                return;
            }
          }}
        />
      ))}
      {native.map((entry) => (
        <SkillRow
          key={skillEntryId(entry)}
          entry={entry}
          collides={collisions.has(entry.key)}
          sourceLabel={skillSourceLabel(entry, providerName)}
          showDelivery={false}
          runner={runner}
          actions={skillActions(entry, context).filter(
            (action) => action !== "import-native" || canWriteGlobal,
          )}
          onAction={() => setDialog({ kind: "native", entry })}
        />
      ))}
      {data?.nativeDiscoveries
        ?.filter((discovery) => discovery.freshness !== "fresh")
        .map((discovery) => (
          <div key={discovery.providerInstanceId} className="px-3 py-2 sm:px-4">
            <ResourceHint>
              {providerName(discovery.providerInstanceId)} skills are{" "}
              {discovery.freshness === "stale" ? "from an earlier scan" : "unavailable"}
              {discovery.discoveryError ? `: ${discovery.discoveryError.message}` : "."}
            </ResourceHint>
          </div>
        ))}
      {data?.diagnostics?.map((diagnostic) => (
        <div
          key={`${diagnostic.scope}:${diagnostic.scopeId}:${diagnostic.name}`}
          className="px-3 py-2 sm:px-4"
        >
          <ResourceHint>
            {`Skipped "${diagnostic.name}": ${diagnostic.reasons.map((reason) => reason.message).join(" ")}`}
          </ResourceHint>
        </div>
      ))}
      {target.threadId === null && data !== null ? (
        <InstalledSkillCopies target={target} catalog={data} providerName={providerName} />
      ) : null}
      {dialog !== null && data !== null ? (
        <SkillDialogs
          key={JSON.stringify([
            dialog.kind,
            "entry" in dialog ? skillEntryId(dialog.entry) : null,
            "entry" in dialog ? dialog.entry.revision.hash : null,
          ])}
          dialog={dialog}
          target={target}
          catalog={data}
          canImport={canWriteGlobal}
          providerName={providerName}
          onDone={() => {
            setDialog(null);
            catalog.refresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

const ACTION_LABELS: Record<ReturnType<typeof skillActions>[number], string> = {
  edit: "Edit",
  rename: "Rename",
  history: "History",
  delete: "Delete",
  install: "Install to provider…",
  override: "Override for this project",
  "edit-override": "Edit project override",
  "rename-override": "Rename",
  "disable-project": "Turn off for this project",
  "reset-project": "Use environment version",
  "session-enable": "Turn on for this thread",
  "session-disable": "Turn off for this thread",
  "session-reset": "Follow project and environment",
  "view-native": "View",
  "import-native": "Import as managed skill",
};

function SkillRow({
  entry,
  collides,
  sourceLabel,
  showDelivery,
  runner,
  actions,
  onAction,
}: {
  entry: SkillCatalogSummary;
  collides: boolean;
  sourceLabel: string;
  showDelivery: boolean;
  runner: ResourceCommandRunner;
  actions: ReadonlyArray<ReturnType<typeof skillActions>[number]>;
  onAction: (action: ReturnType<typeof skillActions>[number]) => void;
}) {
  const id = skillEntryId(entry);
  const unsupported = entry.compatibility.filter((value) => value.support === "unsupported");
  const destructive = new Set(["delete", "disable-project", "session-disable"]);
  return (
    <ResourceRow
      title={
        <>
          <span className="font-medium">{entry.name}</span>
          <code className="text-xs text-muted-foreground">${entry.key}</code>
        </>
      }
      badges={
        <>
          <Badge size="sm" variant="secondary">
            {sourceLabel}
          </Badge>
          {entry.origin === "managed" && entry.projectState === "override" ? (
            <Badge size="sm" variant="info">
              Project override
            </Badge>
          ) : null}
          {!entry.effective ? (
            <Badge size="sm" variant="outline">
              Off
            </Badge>
          ) : null}
          {entry.validity === "invalid" ? (
            <Badge size="sm" variant="error">
              Invalid
            </Badge>
          ) : null}
          {collides ? (
            <Badge size="sm" variant="warning">
              Same name as another source
            </Badge>
          ) : null}
        </>
      }
      meta={
        <>
          {entry.conflict ? <span className="block">{entry.conflict.message}</span> : null}
          {unsupported.length > 0 ? (
            <span className="block">
              Not delivered to{" "}
              {unsupported.length === 1 ? "one provider" : `${unsupported.length} providers`}:{" "}
              {unsupported
                .flatMap((value) => value.reasons.map((reason) => reason.message))
                .join(" ")}
            </span>
          ) : null}
          {showDelivery && entry.origin === "managed" ? (
            <span className="block">{sessionSkillDeliveryLabel(entry)}</span>
          ) : null}
          {runner.pendingKey === id ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="size-3" /> Saving…
            </span>
          ) : null}
          <ResourceFailure message={runner.failureFor(id)} />
        </>
      }
      actions={
        actions.length === 0 ? null : actions.length === 1 && actions[0] === "view-native" ? (
          <Button size="xs" variant="ghost" onClick={() => onAction("view-native")}>
            View
          </Button>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${entry.name}`}
                  disabled={runner.busy}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {actions
                .filter((action) => !destructive.has(action))
                .map((action) => (
                  <MenuItem key={action} onClick={() => onAction(action)}>
                    {ACTION_LABELS[action]}
                  </MenuItem>
                ))}
              {actions.some((action) => destructive.has(action)) ? <MenuSeparator /> : null}
              {actions
                .filter((action) => destructive.has(action))
                .map((action) => (
                  <MenuItem key={action} variant="destructive" onClick={() => onAction(action)}>
                    {ACTION_LABELS[action]}
                  </MenuItem>
                ))}
            </MenuPopup>
          </Menu>
        )
      }
    />
  );
}

function SkillDialogs(props: {
  dialog: SkillDialog;
  target: ResourceSettingsTarget;
  catalog: SkillCatalogListResult;
  canImport: boolean;
  providerName: (id: ProviderInstanceId) => string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { dialog } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        {dialog.kind === "create" || dialog.kind === "edit" || dialog.kind === "override" ? (
          <SkillEditorForm {...props} dialog={dialog} />
        ) : dialog.kind === "rename" ? (
          <SkillRenameForm {...props} entry={dialog.entry} />
        ) : dialog.kind === "history" ? (
          <SkillHistoryPanel {...props} entry={dialog.entry} />
        ) : dialog.kind === "install" ? (
          <SkillInstallPanel {...props} entry={dialog.entry} />
        ) : (
          <NativeSkillPanel {...props} entry={dialog.entry} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SkillEditorForm({
  dialog,
  target,
  catalog,
  onDone,
  onClose,
}: {
  dialog: Extract<SkillDialog, { kind: "create" | "edit" | "override" }>;
  target: ResourceSettingsTarget;
  catalog: SkillCatalogListResult;
  onDone: () => void;
  onClose: () => void;
}) {
  const source = dialog.kind === "create" ? null : dialog.entry;
  const content = useEnvironmentQuery(
    source === null
      ? null
      : skillsEnvironment.content({
          environmentId: target.environmentId,
          input: {
            skillId: source.id,
            ...(target.projectId === null ? {} : { projectId: target.projectId }),
          },
        }),
  );
  const runner = useResourceCommand();
  const live = content.data;
  // The draft and everything a save is checked against come from one load and
  // change only through an explicit reload, never from a background refresh.
  const [editor, setEditor] = useState<{
    readonly draft: { key: string; name: string; body: string };
    readonly loaded: SkillContentDetail | null;
    readonly catalogRevision: SkillCatalogRevision;
  } | null>(
    source === null
      ? {
          draft: { key: "", name: "", body: "" },
          loaded: null,
          catalogRevision: dialog.catalogRevision,
        }
      : null,
  );
  const openFrom = (detail: SkillContentDetail, catalogRevision: SkillCatalogRevision) =>
    setEditor({
      draft: { key: detail.content.key, name: detail.content.name, body: detail.content.body },
      loaded: detail,
      catalogRevision,
    });
  if (editor === null && live !== null && source !== null && live.metadata.id === source.id)
    openFrom(live, dialog.catalogRevision);
  const loaded = editor?.loaded ?? null;
  const draft = editor?.draft ?? null;
  const setDraft = (patch: Partial<{ key: string; name: string; body: string }>) =>
    setEditor((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...patch } },
    );
  const liveEntry =
    source === null
      ? undefined
      : catalog.entries.find(
          (entry): entry is ManagedEntry =>
            entry.origin === "managed" && entry.id === source.id && entry.scope === source.scope,
        );
  const conflict =
    editor === null
      ? null
      : resourceEditorConflict(
          {
            // A global edit is checked against its content hash only; project and new writes against the catalog.
            catalogRevision:
              dialog.kind === "edit" && source?.scope === "global" ? null : editor.catalogRevision,
            entryRevision: editor.loaded?.metadata.revision.hash ?? null,
          },
          {
            catalogRevision: catalog.catalogRevision,
            entryRevision: source === null ? undefined : liveEntry?.revision.hash,
          },
        );
  const blocked = conflict !== null;
  const key = decodeKey(draft?.key.trim() ?? "");
  const name = decodeName(draft?.name.trim() ?? "");
  const title =
    dialog.kind === "create"
      ? dialog.scope === "project"
        ? "New project skill"
        : "New skill"
      : dialog.kind === "override"
        ? `Override ${dialog.entry.name} for this project`
        : `Edit ${dialog.entry.name}`;

  const registry = useContext(RegistryContext);
  // Bumped by each reload and by unmount, so only the newest reload of this editor lands.
  const reloadRequestRef = useRef(0);
  useEffect(
    () => () => {
      reloadRequestRef.current++;
    },
    [],
  );
  const [reloadState, setReloadState] = useState<
    | { readonly status: "idle" }
    | { readonly status: "loading" }
    | { status: "failed"; message: string }
  >({ status: "idle" });
  /**
   * Fetches the current content and catalog together and adopts them in one
   * step, only when the catalog names the fetched revision. The draft stays
   * until then, and stays on failure.
   */
  const reload = async () => {
    if (source === null) {
      // A new skill has nothing to overwrite; reloading keeps the text and adopts the current catalog.
      setEditor((current) =>
        current === null ? current : { ...current, catalogRevision: catalog.catalogRevision },
      );
      return;
    }
    const request = ++reloadRequestRef.current;
    setReloadState({ status: "loading" });
    const detail = await executeAtomQuery(
      registry,
      skillsEnvironment.content({
        environmentId: target.environmentId,
        input: {
          skillId: source.id,
          ...(target.projectId === null ? {} : { projectId: target.projectId }),
        },
      }),
      { refresh: true, reportFailure: false },
    );
    const current =
      detail._tag === "Success"
        ? await executeAtomQuery(
            registry,
            skillsEnvironment.catalog({
              environmentId: target.environmentId,
              input: skillCatalogInput(target),
            }),
            { refresh: true, reportFailure: false },
          )
        : detail;
    if (request !== reloadRequestRef.current) return;
    const failure =
      detail._tag !== "Success" ? detail : current._tag !== "Success" ? current : null;
    if (failure !== null) {
      setReloadState(
        isAtomCommandInterrupted(failure)
          ? { status: "idle" }
          : {
              status: "failed",
              message: `${describeResourceFailure(squashAtomCommandFailure(failure))} Your text is unchanged.`,
            },
      );
      return;
    }
    if (detail._tag !== "Success" || current._tag !== "Success") return;
    const adopted = skillReloadBaseline(source, detail.value, current.value);
    if (adopted === null) {
      setReloadState({
        status: "failed",
        message:
          "It changed again while loading, or was removed. Your text is unchanged; reload again.",
      });
      return;
    }
    setReloadState({ status: "idle" });
    openFrom(detail.value, adopted);
  };

  const save = async () => {
    if (editor === null || draft === null || key._tag === "None" || name._tag === "None" || blocked)
      return;
    const contentDraft: ManagedSkillContentDraft = {
      name: name.value,
      body: draft.body,
      ...(loaded?.content.assetPaths ? { assetPaths: loaded.content.assetPaths } : {}),
      ...(loaded?.content.frontmatter ? { frontmatter: loaded.content.frontmatter } : {}),
    };
    const result =
      dialog.kind === "edit" && dialog.entry.scope === "global" && loaded !== null
        ? await runner.run("save", skillsEnvironment.globalUpdate, {
            environmentId: target.environmentId,
            input: {
              environmentId: target.environmentId,
              skillId: dialog.entry.id,
              expectedHash: loaded.metadata.revision.hash,
              content: contentDraft,
            },
          })
        : dialog.kind === "create" && dialog.scope === "global"
          ? await runner.run("save", skillsEnvironment.globalCreate, {
              environmentId: target.environmentId,
              input: {
                environmentId: target.environmentId,
                expectedRevision: editor.catalogRevision,
                content: { ...contentDraft, key: key.value },
              },
            })
          : target.projectId !== null
            ? await runner.run("save", skillsEnvironment.projectSetOverride, {
                environmentId: target.environmentId,
                input: {
                  projectId: target.projectId,
                  expectedRevision: editor.catalogRevision,
                  key: key.value,
                  content: contentDraft,
                },
              })
            : { ok: false as const };
    if (result.ok) onDone();
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {dialog.kind === "override"
            ? "Only this project uses the override. The environment skill stays unchanged."
            : "Skill instructions are markdown. Providers that support managed skills receive the saved revision on their next delivery."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {draft === null ? (
          content.error ? (
            <div className="flex flex-wrap items-center gap-2">
              <ResourceFailure message={content.error} />
              <Button size="xs" variant="outline" onClick={content.refresh}>
                Retry
              </Button>
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Loading the current revision…
            </p>
          )
        ) : (
          <>
            {conflict !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                <ResourceFailure
                  message={
                    conflict === "removed"
                      ? "This skill was deleted elsewhere. Your text is kept here; close to discard it."
                      : "This changed elsewhere since you opened it. Your text is kept; reload to continue from the current version."
                  }
                />
                {conflict !== "removed" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={reloadState.status === "loading"}
                    onClick={() => void reload()}
                  >
                    {reloadState.status === "loading" ? <Spinner className="size-3" /> : null}
                    {source === null ? "Use current catalog" : "Reload current version"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {reloadState.status === "failed" ? (
              <ResourceFailure message={reloadState.message} />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm">
                <span>Name</span>
                <Input
                  autoFocus
                  value={draft.name}
                  onChange={(event) => setDraft({ name: event.target.value })}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>Key</span>
                <Input
                  value={draft.key}
                  disabled={dialog.kind !== "create"}
                  aria-invalid={draft.key.length > 0 && key._tag === "None"}
                  placeholder="review-pr"
                  onChange={(event) => setDraft({ key: event.target.value })}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers and single dashes. Users invoke it as{" "}
              <code>${draft.key.trim() || "key"}</code>.
            </p>
            <label className="block space-y-1.5 text-sm">
              <span>Instructions</span>
              <Textarea
                size="lg"
                value={draft.body}
                onChange={(event) => setDraft({ body: event.target.value })}
              />
            </label>
            {loaded?.content.assetPaths?.length ? (
              <ResourceHint>
                {`Bundled files are kept as they are: ${loaded.content.assetPaths.join(", ")}.`}
              </ResourceHint>
            ) : null}
            <ResourceFailure message={runner.failureFor("save")} />
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={runner.busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            draft === null || key._tag === "None" || name._tag === "None" || blocked || runner.busy
          }
        >
          {runner.busy ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function SkillRenameForm({
  entry,
  target,
  onDone,
  onClose,
}: {
  entry: ManagedEntry;
  target: ResourceSettingsTarget;
  onDone: () => void;
  onClose: () => void;
}) {
  const runner = useResourceCommand();
  const [value, setValue] = useState<string>(entry.key);
  const key = decodeKey(value.trim());
  const save = async () => {
    if (key._tag === "None" || key.value === entry.key) return;
    const result =
      entry.scope === "project" && target.projectId !== null
        ? await runner.run("rename", skillsEnvironment.projectRename, {
            environmentId: target.environmentId,
            input: {
              projectId: target.projectId,
              skillId: entry.id,
              expectedHash: entry.revision.hash,
              key: key.value,
            },
          })
        : await runner.run("rename", skillsEnvironment.globalRename, {
            environmentId: target.environmentId,
            input: {
              environmentId: target.environmentId,
              skillId: entry.id,
              expectedHash: entry.revision.hash,
              key: key.value,
            },
          });
    if (result.ok) onDone();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename {entry.name}</DialogTitle>
        <DialogDescription>
          The key is how people and agents invoke the skill. Drafts that already mention the old key
          keep their text.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        <ResourceFailure message={runner.failureFor("rename")} />
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={key._tag === "None" || runner.busy}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

function SkillHistoryPanel({
  entry,
  target,
  onDone,
  onClose,
}: {
  entry: ManagedEntry;
  target: ResourceSettingsTarget;
  onDone: () => void;
  onClose: () => void;
}) {
  const history = useEnvironmentQuery(
    skillsEnvironment.history({
      environmentId: target.environmentId,
      input: { skillId: entry.id },
    }),
  );
  const runner = useResourceCommand();
  const restore = async (revision: number) => {
    const result = await runner.run(`restore:${revision}`, skillsEnvironment.globalRollback, {
      environmentId: target.environmentId,
      input: {
        environmentId: target.environmentId,
        skillId: entry.id,
        expectedHash: entry.revision.hash,
        revision,
      },
    });
    if (result.ok) onDone();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>History of {entry.name}</DialogTitle>
        <DialogDescription>
          Restoring saves the old content as a new revision; nothing is lost.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ResourceQueryNotice query={history} subject="history" />
        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
          {[...(history.data?.entries ?? [])]
            .sort((left, right) => right.revision.revision - left.revision.revision)
            .map((item) => {
              const current = item.revision.hash === entry.revision.hash;
              const key = `restore:${item.revision.revision}`;
              return (
                <ResourceRow
                  key={item.revision.revision}
                  title={<span>Revision {item.revision.revision}</span>}
                  badges={
                    current ? (
                      <Badge size="sm" variant="success">
                        Current
                      </Badge>
                    ) : null
                  }
                  meta={
                    <>
                      {item.name} · {formatDayAwareTimestamp(item.createdAt, "locale")}
                      <ResourceFailure message={runner.failureFor(key)} />
                    </>
                  }
                  actions={
                    current ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={runner.busy}
                        onClick={() => void restore(item.revision.revision)}
                      >
                        Restore
                      </Button>
                    )
                  }
                />
              );
            })}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

const DEPLOYMENT_STATUS: Record<
  SkillDeploymentTargetSummary["status"],
  { label: string; variant: "secondary" | "success" | "warning" | "error" }
> = {
  absent: { label: "Not installed", variant: "secondary" },
  owned: { label: "Installed by T3 Code", variant: "success" },
  drifted: { label: "Edited outside T3 Code", variant: "warning" },
  blocked: { label: "Blocked", variant: "error" },
};

function SkillInstallPanel({
  entry,
  target,
  catalog,
  providerName,
  onClose,
}: {
  entry: ManagedEntry;
  target: ResourceSettingsTarget;
  catalog: SkillCatalogListResult;
  providerName: (id: ProviderInstanceId) => string;
  onClose: () => void;
}) {
  const providers = catalog.installProviderInstances ?? [];
  const [providerInstanceId, setProviderInstanceId] = useState<ProviderInstanceId | null>(
    providers[0] ?? null,
  );
  const input =
    providerInstanceId === null
      ? null
      : {
          skillId: entry.id,
          providerInstanceId,
          ...(target.projectId === null ? {} : { projectId: target.projectId }),
        };
  const deployments = useEnvironmentQuery(
    input === null
      ? null
      : skillsEnvironment.deployment({ environmentId: target.environmentId, input }),
  );
  const runner = useResourceCommand();
  const canChange = useAtomValue(
    skillsEnvironment.deploymentChange.permissionAtom(target.environmentId),
  );
  const change = async (
    targetId: SkillDeploymentTargetSummary["id"],
    operation: "install" | "uninstall",
  ) => {
    if (input === null) return;
    const result = await runner.run(
      `${targetId}:${operation}`,
      skillsEnvironment.deploymentChange,
      {
        environmentId: target.environmentId,
        input: {
          ...input,
          key: entry.key,
          target: targetId,
          operation,
          ...(operation === "install" ? { expectedHash: entry.revision.hash } : {}),
        },
      },
    );
    if (result.ok) deployments.refresh();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Install {entry.name}</DialogTitle>
        <DialogDescription>
          Copies this revision into a provider's own skills folder, for providers or tools that read
          skills from disk. T3 Code never overwrites a copy someone edited.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {providers.length === 0 ? (
          <ResourceHint>No provider on this environment accepts installed skills.</ResourceHint>
        ) : (
          <Select
            value={providerInstanceId}
            onValueChange={(value) => setProviderInstanceId(value as ProviderInstanceId)}
          >
            <SelectTrigger size="sm" aria-label="Provider">
              <SelectValue>
                {(value: ProviderInstanceId | null) =>
                  value === null ? "Provider" : providerName(value)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {providers.map((id) => (
                <SelectItem key={id} value={id}>
                  {providerName(id)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        {input !== null ? (
          <ResourceQueryNotice query={deployments} subject="install targets" />
        ) : null}
        <div className="divide-y divide-border/60 rounded-lg border border-border/60">
          {(deployments.data?.targets ?? []).map((item) => {
            const status = DEPLOYMENT_STATUS[item.status];
            const installKey = `${item.id}:install`;
            const removeKey = `${item.id}:uninstall`;
            const otherKey =
              item.status === "owned" && item.key !== undefined && item.key !== entry.key;
            return (
              <ResourceRow
                key={item.id}
                title={<code className="truncate text-xs">{item.path}</code>}
                badges={
                  <Badge size="sm" variant={status.variant}>
                    {status.label}
                  </Badge>
                }
                meta={
                  <>
                    {item.readers.length > 0 ? `Read by ${item.readers.join(", ")}` : null}
                    {item.detail ? <span className="block">{item.detail}</span> : null}
                    {otherKey ? (
                      <span className="block">{`Holds the installed copy of "${item.key}".`}</span>
                    ) : null}
                    <ResourceFailure
                      message={runner.failureFor(installKey) ?? runner.failureFor(removeKey)}
                    />
                  </>
                }
                actions={
                  <>
                    {item.status === "absent" || (item.status === "owned" && !otherKey) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canChange || runner.busy}
                        onClick={() => void change(item.id, "install")}
                      >
                        {item.status === "owned" ? "Update" : "Install"}
                      </Button>
                    ) : null}
                    {item.status === "owned" && !otherKey ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canChange || runner.busy}
                        onClick={() => void change(item.id, "uninstall")}
                      >
                        Uninstall
                      </Button>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Copies installed into provider skill folders, listed by folder rather than
 * by catalog entry, so a copy whose managed skill was renamed or deleted can
 * still be found and removed. Copies edited outside T3 Code are never deleted.
 */
function InstalledSkillCopies({
  target,
  catalog,
  providerName,
}: {
  target: ResourceSettingsTarget;
  catalog: SkillCatalogListResult;
  providerName: (id: ProviderInstanceId) => string;
}) {
  const providers = catalog.installProviderInstances ?? [];
  const [selected, setSelected] = useState<ProviderInstanceId | null>(null);
  const providerInstanceId = selected ?? providers[0] ?? null;
  const input =
    providerInstanceId === null
      ? null
      : {
          providerInstanceId,
          ...(target.projectId === null ? {} : { projectId: target.projectId }),
        };
  const deployments = useEnvironmentQuery(
    input === null
      ? null
      : skillsEnvironment.deployment({ environmentId: target.environmentId, input }),
  );
  const runner = useResourceCommand();
  const canChange = useAtomValue(
    skillsEnvironment.deploymentChange.permissionAtom(target.environmentId),
  );
  if (providers.length === 0) return null;
  const managedKeys = new Set(
    catalog.entries.flatMap((entry) => (entry.origin === "managed" ? [entry.key] : [])),
  );
  const copies = (deployments.data?.targets ?? []).filter((item) => item.status !== "absent");
  const uninstall = async (item: SkillDeploymentTargetSummary) => {
    if (input === null || item.key === undefined) return;
    const result = await runner.run(`${item.id}:${item.key}`, skillsEnvironment.deploymentChange, {
      environmentId: target.environmentId,
      input: { ...input, key: item.key, target: item.id, operation: "uninstall" },
    });
    if (result.ok) deployments.refresh();
  };
  return (
    <div className="border-t border-border/60">
      <ResourceRow
        title={<span className="font-medium">Installed copies</span>}
        meta="Skill folders T3 Code wrote for providers that read skills from disk."
        actions={
          providers.length > 1 ? (
            <Select
              value={providerInstanceId}
              onValueChange={(value) => setSelected(value as ProviderInstanceId)}
            >
              <SelectTrigger size="sm" aria-label="Provider">
                <SelectValue>
                  {(value: ProviderInstanceId | null) =>
                    value === null ? "Provider" : providerName(value)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {providers.map((id) => (
                  <SelectItem key={id} value={id}>
                    {providerName(id)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <span className="text-xs text-muted-foreground">
              {providerInstanceId === null ? null : providerName(providerInstanceId)}
            </span>
          )
        }
      />
      {input !== null ? (
        <ResourceQueryNotice query={deployments} subject="installed copies" />
      ) : null}
      {deployments.data !== null && copies.length === 0 ? (
        <ResourceEmpty>No installed copies for this provider.</ResourceEmpty>
      ) : null}
      {copies.map((item) => {
        const status = DEPLOYMENT_STATUS[item.status];
        const key = `${item.id}:${item.key ?? ""}`;
        const orphaned = item.key !== undefined && !managedKeys.has(item.key);
        return (
          <ResourceRow
            key={`${item.id}:${item.path}`}
            title={
              <>
                {item.key !== undefined ? <code className="text-xs">${item.key}</code> : null}
                <code className="truncate text-xs text-muted-foreground">{item.path}</code>
              </>
            }
            badges={
              <>
                <Badge size="sm" variant={status.variant}>
                  {status.label}
                </Badge>
                {orphaned ? (
                  <Badge size="sm" variant="warning">
                    No managed skill
                  </Badge>
                ) : null}
              </>
            }
            meta={
              <>
                {item.status === "drifted"
                  ? "Someone changed this copy, so T3 Code leaves it in place."
                  : orphaned
                    ? "Its managed skill was renamed or deleted; the copy is still read by the provider."
                    : null}
                {item.detail ? <span className="block">{item.detail}</span> : null}
                <ResourceFailure message={runner.failureFor(key)} />
              </>
            }
            actions={
              item.status === "owned" && item.key !== undefined ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canChange || runner.busy}
                  onClick={() => void uninstall(item)}
                >
                  Uninstall
                </Button>
              ) : null
            }
          />
        );
      })}
    </div>
  );
}

function NativeSkillPanel({
  entry,
  target,
  catalog,
  canImport,
  providerName,
  onDone,
  onClose,
}: {
  entry: NativeEntry;
  target: ResourceSettingsTarget;
  catalog: SkillCatalogListResult;
  canImport: boolean;
  providerName: (id: ProviderInstanceId) => string;
  onDone: () => void;
  onClose: () => void;
}) {
  const content = useEnvironmentQuery(
    skillsEnvironment.nativeContent({
      environmentId: target.environmentId,
      input: { observationId: entry.id, maxBytes: NATIVE_PREVIEW_BYTES },
    }),
  );
  const runner = useResourceCommand();
  const [key, setKey] = useState(() =>
    entry.key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  );
  const decodedKey = decodeKey(key.trim());
  const external = content.data?.observation.contentAccess === "external";
  const importable =
    canImport && target.projectId === null && target.threadId === null && !external;
  const save = async () => {
    if (decodedKey._tag === "None") return;
    const result = await runner.run("import", skillsEnvironment.nativeImport, {
      environmentId: target.environmentId,
      input: {
        environmentId: target.environmentId,
        expectedRevision: catalog.catalogRevision,
        observationId: entry.id,
        key: decodedKey.value,
      },
    });
    if (result.ok) onDone();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{entry.name}</DialogTitle>
        <DialogDescription>
          {providerName(entry.providerInstanceId)} discovered this skill. T3 Code shows it as the
          provider reports it and does not change the original.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {content.data === null && content.error === null ? (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> Loading…
          </p>
        ) : null}
        {content.error !== null ? (
          <ResourceHint>
            {`The content isn't readable from here (${content.error}). Skills on an external server stay with that server.`}
          </ResourceHint>
        ) : null}
        {content.data !== null ? (
          <>
            {content.data.provenance ? (
              <p className="text-xs text-muted-foreground">{content.data.provenance}</p>
            ) : null}
            <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 text-xs whitespace-pre-wrap">
              {content.data.content}
            </pre>
            {content.data.truncated ? <ResourceHint>Showing the first 64 KB.</ResourceHint> : null}
            {external ? (
              <ResourceHint>
                This skill lives on an external provider server, so it can't be imported.
              </ResourceHint>
            ) : null}
          </>
        ) : null}
        {importable ? (
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <label className="block space-y-1.5 text-sm">
              <span>Import as managed skill with key</span>
              <Input value={key} onChange={(event) => setKey(event.target.value)} />
            </label>
            <p className="text-xs text-muted-foreground">
              The provider's original stays as it is. Both will be listed, each with its source.
            </p>
            <ResourceFailure message={runner.failureFor("import")} />
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {importable ? (
          <Button
            disabled={decodedKey._tag === "None" || runner.busy || content.data === null}
            onClick={() => void save()}
          >
            Import
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
