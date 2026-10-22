import { useAtomValue } from "@effect/atom-react";
import { managedTextResourceScopeLabel } from "@t3tools/client-runtime/resource-actions";
import {
  ManagedTextResourceBody,
  ManagedTextResourceKey,
  ManagedTextResourceName,
  type ManagedTextResourceCatalogListResult,
  type ManagedTextResourceCatalogRevision,
  type ManagedTextResourceKind,
  type ManagedTextResourceSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { managedTextEnvironment } from "../../state/resources";
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
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  ResourceEmpty,
  ResourceFailure,
  ResourceHint,
  ResourceQueryNotice,
  ResourceRow,
} from "./ResourceSettingsParts";
import { resourceEditorConflict } from "@t3tools/client-runtime/resource-actions";
import {
  resourceCatalogInput,
  textResourceActions,
  type ResourceSettingsTarget,
} from "./resourceInventory";
import { SettingsSection } from "./settingsLayout";
import { useResourceCommand } from "./useResourceCommand";

const decodeKey = Schema.decodeUnknownOption(ManagedTextResourceKey);
const decodeName = Schema.decodeUnknownOption(ManagedTextResourceName);
const decodeBody = Schema.decodeUnknownOption(ManagedTextResourceBody);

type TextAction = ReturnType<typeof textResourceActions>[number];

/** Every dialog carries the catalog revision it opened on; saves never use a newer one. */
type TextDialog =
  | {
      readonly kind: "create";
      readonly resourceKind: ManagedTextResourceKind;
      readonly catalogRevision: ManagedTextResourceCatalogRevision;
    }
  | {
      readonly kind: "edit" | "override";
      readonly entry: ManagedTextResourceSummary;
      readonly catalogRevision: ManagedTextResourceCatalogRevision;
    };

const ACTION_LABELS: Record<TextAction, string> = {
  edit: "Edit",
  disable: "Turn off",
  enable: "Turn on",
  delete: "Delete",
  override: "Override for this project",
  "edit-override": "Edit project override",
  "disable-project": "Turn off for this project",
  "reset-project": "Use environment version",
  "thread-enable": "Turn on for this thread",
  "thread-disable": "Turn off for this thread",
  "thread-reset": "Follow project and environment",
};
const DESTRUCTIVE = new Set<TextAction>(["delete", "disable", "disable-project", "thread-disable"]);

const entryId = (entry: ManagedTextResourceSummary) =>
  JSON.stringify([entry.kind, entry.scope, entry.scopeId, entry.key]);

export function TextResourcesSettings({ target }: { target: ResourceSettingsTarget }) {
  const catalog = useEnvironmentQuery(
    managedTextEnvironment.catalog({
      environmentId: target.environmentId,
      input: resourceCatalogInput(target),
    }),
  );
  const runner = useResourceCommand();
  const canWrite = useAtomValue(
    (target.threadId !== null
      ? managedTextEnvironment.threadSetEnabled
      : target.projectId !== null
        ? managedTextEnvironment.projectSetOverride
        : managedTextEnvironment.environmentUpdate
    ).permissionAtom(target.environmentId),
  );
  const [dialog, setDialog] = useState<TextDialog | null>(null);
  const data = catalog.data;
  const context = { projectId: target.projectId, threadId: target.threadId };
  const overlays = new Set(
    (data?.threadOverlays ?? []).map((overlay) => `${overlay.kind}:${overlay.key}`),
  );

  const act = (entry: ManagedTextResourceSummary, action: TextAction) => {
    if (data === null) return;
    const environmentId = target.environmentId;
    const key = entryId(entry);
    const done = () => catalog.refresh();
    switch (action) {
      case "edit":
      case "edit-override":
        setDialog({ kind: "edit", entry, catalogRevision: data.catalogRevision });
        return;
      case "override":
        setDialog({ kind: "override", entry, catalogRevision: data.catalogRevision });
        return;
      case "enable":
      case "disable":
      case "delete":
        if (entry.id === undefined) return;
        if (action === "delete") {
          void runner
            .run(key, managedTextEnvironment.environmentDelete, {
              environmentId,
              input: {
                environmentId,
                kind: entry.kind,
                id: entry.id,
                expectedRevision: entry.revision,
              },
            })
            .then(done);
          return;
        }
        void runner
          .run(key, managedTextEnvironment.environmentSetEnabled, {
            environmentId,
            input: {
              environmentId,
              kind: entry.kind,
              id: entry.id,
              expectedRevision: entry.revision,
              enabled: action === "enable",
            },
          })
          .then(done);
        return;
      case "disable-project":
      case "reset-project":
        if (target.projectId === null) return;
        void runner
          .run(
            key,
            action === "disable-project"
              ? managedTextEnvironment.projectSetDisabled
              : managedTextEnvironment.projectDeleteState,
            {
              environmentId,
              input: {
                projectId: target.projectId,
                kind: entry.kind,
                expectedCatalogRevision: data.catalogRevision,
                key: entry.key,
              },
            },
          )
          .then(done);
        return;
      case "thread-enable":
      case "thread-disable":
        if (target.threadId === null) return;
        void runner
          .run(key, managedTextEnvironment.threadSetEnabled, {
            environmentId,
            input: {
              threadId: target.threadId,
              kind: entry.kind,
              expectedCatalogRevision: data.catalogRevision,
              key: entry.key,
              enabled: action === "thread-enable",
            },
          })
          .then(done);
        return;
      case "thread-reset":
        if (target.threadId === null) return;
        void runner
          .run(key, managedTextEnvironment.threadReset, {
            environmentId,
            input: {
              threadId: target.threadId,
              kind: entry.kind,
              expectedCatalogRevision: data.catalogRevision,
              key: entry.key,
            },
          })
          .then(done);
        return;
    }
  };

  const newMenu =
    target.threadId === null ? (
      <Menu>
        <MenuTrigger
          render={<Button size="xs" variant="outline" disabled={!canWrite || data === null} />}
        >
          <PlusIcon className="size-3.5" />
          New
        </MenuTrigger>
        <MenuPopup align="end">
          {(["command", "snippet"] as const).map((resourceKind) => (
            <MenuItem
              key={resourceKind}
              onClick={() =>
                data &&
                setDialog({ kind: "create", resourceKind, catalogRevision: data.catalogRevision })
              }
            >
              {resourceKind === "command" ? "Command" : "Snippet"}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    ) : null;

  return (
    <SettingsSection id="commands-snippets" title="Commands and snippets" headerAction={newMenu}>
      <ResourceQueryNotice query={catalog} subject="commands and snippets" />
      {data !== null && data.entries.length === 0 ? (
        <ResourceEmpty>
          Commands expand from <code>/name</code> and snippets insert reusable text. Both become
          ordinary draft text you can edit before sending.
        </ResourceEmpty>
      ) : null}
      {data?.entries.map((entry) => {
        const key = entryId(entry);
        const actions = canWrite
          ? textResourceActions(entry, context, overlays.has(`${entry.kind}:${entry.key}`))
          : [];
        return (
          <ResourceRow
            key={key}
            title={
              <>
                <span className="font-medium">{entry.name ?? entry.key}</span>
                <code className="text-xs text-muted-foreground">/{entry.key}</code>
              </>
            }
            badges={
              <>
                <Badge size="sm" variant="secondary">
                  {entry.kind === "command" ? "Command" : "Snippet"}
                </Badge>
                <Badge size="sm" variant="outline">
                  {managedTextResourceScopeLabel(entry)}
                </Badge>
                {!entry.effective ? (
                  <Badge size="sm" variant="outline">
                    Off
                  </Badge>
                ) : null}
                {entry.projectState === "invalid" || entry.projectState === "orphan" ? (
                  <Badge size="sm" variant="warning">
                    {entry.projectState === "orphan" ? "Original removed" : "Invalid override"}
                  </Badge>
                ) : null}
                {overlays.has(`${entry.kind}:${entry.key}`) ? (
                  <Badge size="sm" variant="info">
                    Set for this thread
                  </Badge>
                ) : null}
              </>
            }
            meta={
              <>
                {runner.pendingKey === key ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="size-3" /> Saving…
                  </span>
                ) : null}
                <ResourceFailure message={runner.failureFor(key)} />
              </>
            }
            actions={
              actions.length === 0 ? null : (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Actions for ${entry.name ?? entry.key}`}
                        disabled={runner.busy}
                      />
                    }
                  >
                    <MoreHorizontalIcon className="size-4" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {actions
                      .filter((action) => !DESTRUCTIVE.has(action))
                      .map((action) => (
                        <MenuItem key={action} onClick={() => act(entry, action)}>
                          {ACTION_LABELS[action]}
                        </MenuItem>
                      ))}
                    {actions.some((action) => DESTRUCTIVE.has(action)) ? <MenuSeparator /> : null}
                    {actions
                      .filter((action) => DESTRUCTIVE.has(action))
                      .map((action) => (
                        <MenuItem
                          key={action}
                          variant="destructive"
                          onClick={() => act(entry, action)}
                        >
                          {ACTION_LABELS[action]}
                        </MenuItem>
                      ))}
                  </MenuPopup>
                </Menu>
              )
            }
          />
        );
      })}
      {dialog !== null && data !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        >
          <DialogPopup>
            <TextResourceEditorForm
              key={
                dialog.kind === "create"
                  ? "create"
                  : JSON.stringify([
                      entryId(dialog.entry),
                      dialog.entry.revision,
                      dialog.catalogRevision,
                    ])
              }
              dialog={dialog}
              target={target}
              catalog={data}
              onDone={() => {
                setDialog(null);
                catalog.refresh();
              }}
              onReopen={(entry, catalogRevision) =>
                setDialog((current) =>
                  current === null || current.kind === "create"
                    ? current
                    : { kind: current.kind, entry, catalogRevision },
                )
              }
              onClose={() => setDialog(null)}
            />
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}

function TextResourceEditorForm({
  dialog,
  target,
  catalog,
  onDone,
  onReopen,
  onClose,
}: {
  dialog: TextDialog;
  target: ResourceSettingsTarget;
  catalog: ManagedTextResourceCatalogListResult;
  onDone: () => void;
  /** Starts over from the current entry, replacing this editor and its draft. */
  onReopen: (
    entry: ManagedTextResourceSummary,
    catalogRevision: ManagedTextResourceCatalogRevision,
  ) => void;
  onClose: () => void;
}) {
  const source = dialog.kind === "create" ? null : dialog.entry;
  const content = useEnvironmentQuery(
    source === null || source.id === undefined
      ? null
      : managedTextEnvironment.content({
          environmentId: target.environmentId,
          input: {
            kind: source.kind,
            id: source.id,
            expectedRevision: source.revision,
            ...resourceCatalogInput(target),
          },
        }),
  );
  const runner = useResourceCommand();
  // Saves use the revisions this editor opened with; a refreshed catalog never replaces them.
  const [baseline, setBaseline] = useState(() => ({
    catalogRevision: dialog.catalogRevision,
    entryRevision: source?.revision ?? null,
  }));
  const [draft, setDraft] = useState<{
    kind: ManagedTextResourceKind;
    key: string;
    name: string;
    body: string;
  } | null>(
    dialog.kind === "create" ? { kind: dialog.resourceKind, key: "", name: "", body: "" } : null,
  );
  if (
    draft === null &&
    content.data !== null &&
    source !== null &&
    content.data.id === source.id &&
    content.data.revision === baseline.entryRevision
  ) {
    setDraft({
      kind: source.kind,
      key: content.data.key,
      name: content.data.name ?? "",
      body: content.data.body,
    });
  }
  const liveEntry =
    source === null
      ? undefined
      : catalog.entries.find((entry) => entryId(entry) === entryId(source));
  const conflict = resourceEditorConflict(baseline, {
    catalogRevision: catalog.catalogRevision,
    entryRevision: source === null ? undefined : liveEntry?.revision,
  });
  const reload = () => {
    if (source === null) {
      // A new entry has nothing to overwrite, so the typed text stays.
      setBaseline((current) => ({ ...current, catalogRevision: catalog.catalogRevision }));
      return;
    }
    if (liveEntry === undefined) return;
    onReopen(liveEntry, catalog.catalogRevision);
  };
  const key = decodeKey(draft?.key.trim() ?? "");
  const body = decodeBody(draft?.body ?? "");
  const nameText = draft?.name.trim() ?? "";
  const name = decodeName(nameText);
  const nameValid = nameText.length === 0 || name._tag === "Some";
  const valid =
    draft !== null && key._tag === "Some" && body._tag === "Some" && nameValid && conflict === null;
  const kindLabel = (draft?.kind ?? source?.kind) === "snippet" ? "snippet" : "command";

  const save = async () => {
    if (!valid) return;
    const named = name._tag === "Some" ? { name: name.value } : {};
    const environmentId = target.environmentId;
    const result =
      dialog.kind === "edit" && dialog.entry.scope === "environment" && dialog.entry.id
        ? await runner.run("save", managedTextEnvironment.environmentUpdate, {
            environmentId,
            input: {
              environmentId,
              kind: dialog.entry.kind,
              id: dialog.entry.id,
              expectedRevision: dialog.entry.revision,
              ...named,
              body: body.value,
            },
          })
        : target.projectId === null
          ? await runner.run("save", managedTextEnvironment.environmentCreate, {
              environmentId,
              input: {
                environmentId,
                kind: draft.kind,
                expectedCatalogRevision: baseline.catalogRevision,
                key: key.value,
                ...named,
                body: body.value,
              },
            })
          : await runner.run("save", managedTextEnvironment.projectSetOverride, {
              environmentId,
              input: {
                projectId: target.projectId,
                kind: draft.kind,
                expectedCatalogRevision: baseline.catalogRevision,
                key: key.value,
                ...named,
                body: body.value,
              },
            });
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
        <DialogTitle>
          {dialog.kind === "create"
            ? target.projectId === null
              ? `New ${kindLabel}`
              : `New project ${kindLabel}`
            : dialog.kind === "override"
              ? `Override /${dialog.entry.key} for this project`
              : `Edit /${dialog.entry.key}`}
        </DialogTitle>
        <DialogDescription>
          {kindLabel === "command"
            ? "Choosing the command in the composer replaces it with this text. $ARGUMENTS becomes whatever follows the command on that line."
            : "Choosing the snippet inserts this text where you typed it."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {draft === null ? (
          content.error !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              <ResourceFailure message={content.error} />
              <Button size="xs" variant="outline" onClick={content.refresh}>
                Retry
              </Button>
            </div>
          ) : content.data !== null && content.data.revision !== baseline.entryRevision ? (
            <div className="flex flex-wrap items-center gap-2">
              <ResourceFailure message="This changed after the list loaded." />
              <Button size="xs" variant="outline" onClick={reload}>
                Open the current version
              </Button>
            </div>
          ) : (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Loading the current revision…
            </p>
          )
        ) : (
          <>
            {dialog.kind === "create" ? (
              <ToggleGroup
                aria-label="Kind"
                value={[draft.kind]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "command" || value === "snippet")
                    setDraft((current) =>
                      current === null ? current : { ...current, kind: value },
                    );
                }}
              >
                <Toggle value="command">Command</Toggle>
                <Toggle value="snippet">Snippet</Toggle>
              </ToggleGroup>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm">
                <span>Key</span>
                <Input
                  autoFocus={dialog.kind === "create"}
                  value={draft.key}
                  disabled={dialog.kind !== "create"}
                  placeholder="review"
                  aria-invalid={draft.key.length > 0 && key._tag === "None"}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((current) =>
                      current === null ? current : { ...current, key: value },
                    );
                  }}
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>Name (optional)</span>
                <Input
                  value={draft.name}
                  aria-invalid={!nameValid}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((current) =>
                      current === null ? current : { ...current, name: value },
                    );
                  }}
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span>Text</span>
              <Textarea
                size="lg"
                autoFocus={dialog.kind !== "create"}
                value={draft.body}
                aria-invalid={body._tag === "None"}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((current) => (current === null ? current : { ...current, body: value }));
                }}
              />
            </label>
            {conflict !== null ? (
              <div className="flex flex-wrap items-center gap-2">
                <ResourceFailure
                  message={
                    conflict === "removed"
                      ? "This was deleted or reset elsewhere. Your text is kept here; close to discard it."
                      : "This changed elsewhere since you opened it. Your text is kept; reload to continue from the current version."
                  }
                />
                {conflict === "changed" ? (
                  <Button size="xs" variant="outline" onClick={reload}>
                    {source === null ? "Use current catalog" : "Reload current version"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {body._tag === "None" ? <ResourceHint>Text is limited to 64 KB.</ResourceHint> : null}
            <ResourceFailure message={runner.failureFor("save")} />
          </>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={runner.busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || runner.busy}>
          {runner.busy ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
