import { useAtomValue } from "@effect/atom-react";
import {
  ManagedTextResourceKey,
  type ManagedTextResourceCatalogRevision,
  type ManagedTextResourceKind,
  type ManagedTextResourceMutationResult,
  type ManagedTextResourceSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  BracesIcon,
  FileTextIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useEnvironmentQuery } from "../../state/query";
import { managedTextResourcesEnvironment } from "../../state/managedTextResources";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  pinManagedTextResourceCatalogRevision,
  resolveManagedTextResourceMutationEffects,
  resolveManagedTextResourceState,
} from "./managedTextResources.logic";

const isManagedTextResourceKey = Schema.is(ManagedTextResourceKey);

function resourceToken(entry: ManagedTextResourceSummary): string {
  return `${entry.kind}:${entry.key}:${entry.scope}:${entry.scopeId}`;
}

function resourceTrigger(kind: ManagedTextResourceKind, key: string): string {
  return `${kind === "command" ? "/" : ":"}${key}`;
}

function sourceLabel(entry: ManagedTextResourceSummary): string {
  return entry.scope === "environment" ? "Environment" : "Project";
}

function projectStateLabel(entry: ManagedTextResourceSummary): string {
  return resolveManagedTextResourceState(entry).projectStateLabel;
}

export function ManagedTextResourcesSettings() {
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const projectId = target?.projectId ?? null;
  if (!environmentId) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Choose a connected environment to manage commands and snippets.
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <ManagedTextResourcesCatalogSettings
      environmentId={environmentId}
      projectId={projectId}
      targetLabel={target?.label ?? null}
    />
  );
}

function ManagedTextResourcesCatalogSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly targetLabel: string | null;
}) {
  const { environmentId, projectId } = props;
  const [kind, setKind] = useState<ManagedTextResourceKind>("command");
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [newEditorVersion, setNewEditorVersion] = useState(0);
  const catalogInput = useMemo(() => (projectId ? { projectId } : {}), [projectId]);
  useAtomValue(managedTextResourcesEnvironment.changes({ environmentId, input: catalogInput }));
  const catalog = useEnvironmentQuery(
    managedTextResourcesEnvironment.catalog({ environmentId, input: catalogInput }),
  );
  const entries = catalog.data?.entries ?? [];
  const visibleEntries = entries.filter((entry) => entry.kind === kind);
  const selected = entries.find((entry) => resourceToken(entry) === selectedToken) ?? null;

  const startNew = (nextKind: ManagedTextResourceKind) => {
    setKind(nextKind);
    setSelectedToken(null);
    setNewEditorVersion((version) => version + 1);
  };

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        {...searchableSetting("managed-text-resources")}
        title="Commands and snippets"
        icon={<FileTextIcon className="size-4" />}
        headerAction={
          <div className="flex flex-wrap justify-end gap-1">
            <Button type="button" variant="outline" size="xs" onClick={() => startNew("command")}>
              <PlusIcon /> Command
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={() => startNew("snippet")}>
              <PlusIcon /> Snippet
            </Button>
          </div>
        }
      >
        <div className="grid min-h-[32rem] md:grid-cols-[minmax(14rem,0.8fr)_minmax(24rem,1.4fr)]">
          <div className="border-b border-border/50 md:border-e md:border-b-0">
            <div className="flex gap-1 border-b border-border/50 p-2" aria-label="Resource kind">
              {(["command", "snippet"] as const).map((candidate) => (
                <Button
                  key={candidate}
                  type="button"
                  variant={kind === candidate ? "secondary" : "ghost"}
                  size="xs"
                  aria-pressed={kind === candidate}
                  onClick={() => {
                    setKind(candidate);
                    setSelectedToken(null);
                  }}
                >
                  {candidate === "command" ? "Commands" : "Snippets"}
                </Button>
              ))}
            </div>
            {catalog.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">Reading catalog…</p>
            ) : null}
            {catalog.error ? (
              <div className="grid gap-2 p-4 text-sm text-destructive">
                <p>{catalog.error}</p>
                <Button type="button" variant="outline" size="xs" onClick={catalog.refresh}>
                  Retry
                </Button>
              </div>
            ) : null}
            {!catalog.isPending && !catalog.error && visibleEntries.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No {kind === "command" ? "commands" : "snippets"} are defined in this scope.
              </p>
            ) : null}
            {visibleEntries.map((entry) => {
              const resourceState = resolveManagedTextResourceState(entry);
              return (
                <button
                  key={resourceToken(entry)}
                  type="button"
                  aria-current={resourceToken(entry) === selectedToken ? "true" : undefined}
                  className={`grid w-full gap-1 border-b border-border/40 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${resourceToken(entry) === selectedToken ? "bg-accent/70" : "hover:bg-accent/40"}`}
                  onClick={() => {
                    setSelectedToken(resourceToken(entry));
                    setSelectionVersion((version) => version + 1);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="shrink-0 text-sm font-medium">
                      {resourceTrigger(entry.kind, entry.key)}
                    </code>
                    {entry.name && entry.name !== entry.key ? (
                      <span className="truncate text-sm">{entry.name}</span>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{sourceLabel(entry)}</span>
                    <span>{resourceState.effectiveLabel}</span>
                    {projectId ? <span>{projectStateLabel(entry)}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <ManagedTextResourceEditor
            key={
              selectedToken
                ? `selected:${environmentId}:${projectId ?? "environment"}:${selectionVersion}`
                : `new:${environmentId}:${projectId ?? "environment"}:${kind}:${newEditorVersion}`
            }
            environmentId={environmentId}
            {...(projectId ? { projectId } : {})}
            kind={kind}
            selected={selected?.kind === kind ? selected : null}
            catalogRevision={catalog.data?.catalogRevision ?? null}
            catalogPending={catalog.isPending || Boolean(catalog.error)}
            refreshCatalog={catalog.refresh}
            onSelectionChange={(entry) => setSelectedToken(resourceToken(entry))}
            onResetSelection={() => setSelectedToken(null)}
          />
        </div>
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground">
        {projectId
          ? `Editing ${props.targetLabel ?? "this project"}. Project entries override or disable matching environment commands and snippets.`
          : `Editing ${props.targetLabel ?? "this environment"}. These resources are available to projects in this environment.`}
      </p>
    </SettingsPageContainer>
  );
}

function ManagedTextResourceEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly kind: ManagedTextResourceKind;
  readonly selected: ManagedTextResourceSummary | null;
  readonly catalogRevision: ManagedTextResourceCatalogRevision | null;
  readonly catalogPending: boolean;
  readonly refreshCatalog: () => void;
  readonly onSelectionChange: (entry: ManagedTextResourceSummary) => void;
  readonly onResetSelection: () => void;
}) {
  const [selected, setSelected] = useState(props.selected);
  const selectedIdAtOpen = selected?.id ?? null;
  const selectedRevisionAtOpen = selected?.revision ?? null;
  const [catalogRevisionAtOpen, setCatalogRevisionAtOpen] = useState(props.catalogRevision);
  const contentHydratedRef = useRef(false);
  const [contentHydrated, setContentHydrated] = useState(selectedIdAtOpen === null);
  const [keyDraft, setKeyDraft] = useState(selected?.key ?? "");
  const [nameDraft, setNameDraft] = useState(selected?.name ?? "");
  const [bodyDraft, setBodyDraft] = useState("");
  const content = useEnvironmentQuery(
    selectedIdAtOpen && selectedRevisionAtOpen
      ? managedTextResourcesEnvironment.content({
          environmentId: props.environmentId,
          input: {
            kind: props.kind,
            id: selectedIdAtOpen,
            expectedRevision: selectedRevisionAtOpen,
            ...(props.projectId ? { projectId: props.projectId } : {}),
          },
        })
      : null,
  );
  const environmentCreate = useAtomCommand(managedTextResourcesEnvironment.environmentCreate, {
    reportFailure: true,
  });
  const environmentUpdate = useAtomCommand(managedTextResourcesEnvironment.environmentUpdate, {
    reportFailure: true,
  });
  const environmentDelete = useAtomCommand(managedTextResourcesEnvironment.environmentDelete, {
    reportFailure: true,
  });
  const projectSetOverride = useAtomCommand(managedTextResourcesEnvironment.projectSetOverride, {
    reportFailure: true,
  });
  const projectSetDisabled = useAtomCommand(managedTextResourcesEnvironment.projectSetDisabled, {
    reportFailure: true,
  });
  const projectDeleteState = useAtomCommand(managedTextResourcesEnvironment.projectDeleteState, {
    reportFailure: true,
  });
  const environmentSetEnabled = useAtomCommand(
    managedTextResourcesEnvironment.environmentSetEnabled,
    { reportFailure: true },
  );
  const validKey = isManagedTextResourceKey(keyDraft);
  const contentReady =
    contentHydrated &&
    (!selectedIdAtOpen ||
      (content.data?.id === selectedIdAtOpen && content.data.revision === selectedRevisionAtOpen));
  const selectedState = selected ? resolveManagedTextResourceState(selected) : null;
  const unavailable = selectedState?.unavailable ?? false;
  const canEditSelected = !unavailable && (selected === null || Boolean(selected.id));
  const selectedWasRemoved =
    selectedIdAtOpen !== null && props.selected === null && !props.catalogPending;
  const latestSelected =
    props.selected?.id === selectedIdAtOpen && props.selected?.revision !== selectedRevisionAtOpen
      ? props.selected
      : null;

  const loadLatestSelected = () => {
    if (!latestSelected) return;
    contentHydratedRef.current = false;
    setContentHydrated(false);
    setSelected(latestSelected);
  };

  const applyMutationSuccess = (
    result:
      | { readonly _tag: "Success"; readonly value: ManagedTextResourceMutationResult }
      | { readonly _tag: "Failure" },
    clearEditorOnSuccess = false,
  ) => {
    const effects = resolveManagedTextResourceMutationEffects(result, clearEditorOnSuccess);
    if (!effects.applied || result._tag !== "Success") return effects;
    const mutation = result.value;
    setCatalogRevisionAtOpen(mutation.catalogRevision);
    if (selected) {
      const updated = mutation.summaries.find(
        (summary) =>
          summary.kind === selected.kind &&
          summary.key === selected.key &&
          (summary.scope === selected.scope || props.projectId !== undefined),
      );
      if (updated) {
        setSelected(updated);
        props.onSelectionChange(updated);
      }
    }
    props.refreshCatalog();
    return effects;
  };

  useEffect(() => {
    const nextRevision = pinManagedTextResourceCatalogRevision(
      catalogRevisionAtOpen,
      props.catalogRevision,
    );
    if (catalogRevisionAtOpen !== nextRevision) {
      setCatalogRevisionAtOpen(nextRevision);
    }
  }, [catalogRevisionAtOpen, props.catalogRevision]);

  useEffect(() => {
    if (
      !contentHydratedRef.current &&
      content.data &&
      selectedIdAtOpen === content.data.id &&
      selectedRevisionAtOpen === content.data.revision
    ) {
      contentHydratedRef.current = true;
      setNameDraft(content.data.name === selected?.key ? "" : (content.data.name ?? ""));
      setBodyDraft(content.data.body);
      setContentHydrated(true);
    }
  }, [content.data, selected?.key, selectedIdAtOpen, selectedRevisionAtOpen]);

  const save = () => {
    if (!validKey || catalogRevisionAtOpen === null || props.catalogPending || !contentReady) {
      return;
    }
    const name = nameDraft.trim() || keyDraft;
    const common = {
      environmentId: props.environmentId,
      kind: props.kind,
      key: ManagedTextResourceKey.make(keyDraft),
      ...(name ? { name } : {}),
      body: bodyDraft,
    };
    if (props.projectId) {
      void projectSetOverride({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          kind: props.kind,
          expectedCatalogRevision: catalogRevisionAtOpen,
          key: common.key,
          ...(common.name ? { name: common.name } : {}),
          body: common.body,
        },
      }).then((result) => {
        const effects = applyMutationSuccess(result, selected === null);
        if (!effects.applied) return;
        if (effects.clearEditor) {
          setKeyDraft("");
          setNameDraft("");
          setBodyDraft("");
        }
      });
      return;
    }
    if (selected?.id) {
      void environmentUpdate({
        environmentId: props.environmentId,
        input: {
          environmentId: props.environmentId,
          kind: props.kind,
          id: selected.id,
          expectedRevision: selected.revision,
          ...(common.name ? { name: common.name } : {}),
          body: common.body,
        },
      }).then((result) => {
        applyMutationSuccess(result);
      });
      return;
    }
    void environmentCreate({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        kind: props.kind,
        expectedCatalogRevision: catalogRevisionAtOpen,
        key: common.key,
        ...(common.name ? { name: common.name } : {}),
        body: common.body,
      },
    }).then((result) => {
      const effects = applyMutationSuccess(result, true);
      if (!effects.applied) return;
      if (effects.clearEditor) {
        setKeyDraft("");
        setNameDraft("");
        setBodyDraft("");
      }
    });
  };

  const resetProjectState = () => {
    if (!props.projectId || !selected || catalogRevisionAtOpen === null) return;
    void projectDeleteState({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        kind: props.kind,
        expectedCatalogRevision: catalogRevisionAtOpen,
        key: selected.key,
      },
    }).then((result) => {
      if (!applyMutationSuccess(result).applied) return;
      props.onResetSelection();
    });
  };

  const disableInProject = () => {
    if (!props.projectId || !selected || catalogRevisionAtOpen === null) return;
    void projectSetDisabled({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        kind: props.kind,
        expectedCatalogRevision: catalogRevisionAtOpen,
        key: selected.key,
      },
    }).then((result) => {
      if (!applyMutationSuccess(result).applied) return;
      props.onResetSelection();
    });
  };

  const deleteEnvironmentResource = () => {
    if (!selected?.id) return;
    void environmentDelete({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        kind: props.kind,
        id: selected.id,
        expectedRevision: selected.revision,
      },
    }).then((result) => {
      if (!applyMutationSuccess(result).applied) return;
      props.onResetSelection();
    });
  };

  const setEnvironmentEnabled = () => {
    if (props.projectId || !selected?.id || selected.scope !== "environment") return;
    void environmentSetEnabled({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        kind: props.kind,
        id: selected.id,
        expectedRevision: selected.revision,
        enabled: selected.environmentState === "disabled",
      },
    }).then((result) => {
      applyMutationSuccess(result);
    });
  };

  return (
    <div className="grid content-start gap-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">
            {selected ? resourceTrigger(props.kind, selected.key) : `New ${props.kind}`}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {selected
              ? `${sourceLabel(selected)} resource · ${projectIdDescription(props.projectId)}`
              : props.projectId
                ? "Create a project override or a new project resource."
                : "Create an environment command or snippet."}
          </p>
        </div>
        {selected ? (
          <Badge
            variant={unavailable ? "warning" : selectedState?.effective ? "success" : "outline"}
          >
            {selectedState?.effectiveLabel}
          </Badge>
        ) : (
          <Badge variant="outline">{props.projectId ? "Project" : "Environment"}</Badge>
        )}
      </div>
      {unavailable ? (
        <div className="grid gap-2 rounded-lg border border-warning/30 bg-warning-surface/40 p-3 text-sm">
          <p className="font-medium">This entry is unavailable.</p>
          <p className="text-xs text-muted-foreground">
            Its project state is {selected?.projectState}. Reset it to use the current environment
            definition.
          </p>
        </div>
      ) : null}
      {selected?.projectState === "disabled" ? (
        <div className="rounded-lg border border-border/50 p-3 text-sm text-muted-foreground">
          This resource is disabled for this project. Follow the environment to restore it.
        </div>
      ) : null}
      {selected?.id && content.isPending ? (
        <p className="text-sm text-muted-foreground">Loading resource text…</p>
      ) : null}
      {selected?.id && content.error ? (
        <div className="grid gap-2 text-sm text-destructive">
          <p>
            {selectedWasRemoved
              ? "This resource was deleted elsewhere. Copy any unsaved text before starting a new resource."
              : latestSelected
                ? "This resource changed elsewhere. Load its latest version before editing. Your unsaved text will be replaced."
                : content.error}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={
              selectedWasRemoved
                ? props.onResetSelection
                : latestSelected
                  ? loadLatestSelected
                  : content.refresh
            }
          >
            {selectedWasRemoved
              ? "Start new resource"
              : latestSelected
                ? "Load latest version"
                : "Retry"}
          </Button>
        </div>
      ) : null}
      {canEditSelected ? (
        <>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Key
            <Input
              value={keyDraft}
              disabled={selected !== null}
              maxLength={64}
              aria-label="Command or snippet key"
              placeholder="review-changes"
              onChange={(event) => setKeyDraft(event.currentTarget.value)}
            />
            <span className="font-normal">Use lowercase letters, numbers, and single hyphens.</span>
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Display name (optional)
            <Input
              value={nameDraft}
              disabled={!contentReady && !selectedWasRemoved}
              readOnly={selectedWasRemoved}
              maxLength={128}
              aria-label="Display name"
              placeholder="Review changes"
              onChange={(event) => setNameDraft(event.currentTarget.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            {props.kind === "command" ? "Command template" : "Snippet text"}
            <Textarea
              value={bodyDraft}
              disabled={!contentReady && !selectedWasRemoved}
              readOnly={selectedWasRemoved}
              maxLength={65_536}
              rows={12}
              aria-label={props.kind === "command" ? "Command template" : "Snippet text"}
              placeholder={
                props.kind === "command"
                  ? "Review $ARGUMENTS and call out risks."
                  : "Thanks for the detailed report. I’ll take a look."
              }
              onChange={(event) => setBodyDraft(event.currentTarget.value)}
            />
          </label>
          {props.kind === "command" ? (
            <p className="text-xs text-muted-foreground">
              Use <code>$ARGUMENTS</code> where typed text should go. Without it, the text is
              appended on a new line.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <Button
              type="button"
              size="sm"
              disabled={
                !validKey ||
                catalogRevisionAtOpen === null ||
                props.catalogPending ||
                content.isPending ||
                Boolean(content.error) ||
                !contentReady
              }
              onClick={save}
            >
              <SaveIcon />
              {selected ? (props.projectId ? "Save project override" : "Save changes") : "Create"}
            </Button>
            {props.projectId && selected && !selectedWasRemoved ? (
              <>
                {selected.projectState === "override" && selected.effective ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(content.error) || content.isPending || props.catalogPending}
                    onClick={disableInProject}
                  >
                    Disable in project
                  </Button>
                ) : selected.projectState !== "inherit" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(content.error) || content.isPending || props.catalogPending}
                    onClick={resetProjectState}
                  >
                    <RotateCcwIcon /> Follow environment
                  </Button>
                ) : selected.effective && selected.scope === "environment" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(content.error) || content.isPending || props.catalogPending}
                    onClick={disableInProject}
                  >
                    Disable in project
                  </Button>
                ) : null}
              </>
            ) : null}
            {!props.projectId &&
            selected?.id &&
            selected.scope === "environment" &&
            !selectedWasRemoved ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(content.error) || content.isPending || props.catalogPending}
                  onClick={setEnvironmentEnabled}
                >
                  {selected.environmentState === "disabled"
                    ? "Enable in environment"
                    : "Disable in environment"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(content.error) || content.isPending || props.catalogPending}
                  onClick={deleteEnvironmentResource}
                >
                  <Trash2Icon /> Delete
                </Button>
              </>
            ) : null}
          </div>
        </>
      ) : props.projectId && selected ? (
        <Button type="button" variant="outline" size="sm" onClick={resetProjectState}>
          <RotateCcwIcon />
          {selected.projectState === "disabled" ? "Follow environment" : "Reset project state"}
        </Button>
      ) : null}
      {!selected ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BracesIcon className="size-3.5" />
          {props.projectId
            ? "A project definition takes precedence over the environment key."
            : "Environment definitions are shared by projects on this server."}
        </div>
      ) : null}
    </div>
  );
}

function projectIdDescription(projectId: ProjectId | undefined): string {
  return projectId
    ? "project state can override or disable it"
    : "shared with projects in this environment";
}
