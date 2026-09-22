import { useAtomValue } from "@effect/atom-react";
import {
  ManagedSkillKey,
  type EnvironmentId,
  type ProjectId,
  SkillCatalogRevision,
  type SkillCatalogSummary,
  type SkillManagedCatalogSummary,
} from "@t3tools/contracts";
import { BookOpenIcon, CloudCogIcon, ImportIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { skillsEnvironment } from "../../state/skills";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { compatibilityLabel, skillStatusLabel, skillSurfaceSections } from "./skillCatalogModel";

function SkillRow({
  entry,
  selected,
  onSelect,
}: {
  readonly entry: SkillCatalogSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`grid w-full gap-1 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? "bg-accent/70" : "hover:bg-accent/40"}`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{entry.name}</span>
        <Badge variant={entry.origin === "managed" ? "info" : "outline"} size="sm">
          {entry.origin === "managed" ? "T3 managed" : "Provider owned"}
        </Badge>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <code>${entry.key}</code>
        <span>{entry.projectState}</span>
        <span>{entry.effective ? "enabled" : "not effective"}</span>
      </span>
    </button>
  );
}

function ManagedSkillEditor({
  entry,
  environmentId,
  projectId,
  catalogRevision,
  refresh,
}: {
  readonly entry: SkillManagedCatalogSummary;
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly catalogRevision: ReturnType<typeof SkillCatalogRevision.make>;
  readonly refresh: () => void;
}) {
  const contentState = useEnvironmentQuery(
    skillsEnvironment.content({
      environmentId,
      input: { skillId: entry.id, ...(projectId ? { projectId } : {}) },
    }),
  );
  const historyState = useEnvironmentQuery(
    entry.scope === "global"
      ? skillsEnvironment.history({ environmentId, input: { skillId: entry.id } })
      : null,
  );
  const update = useAtomCommand(skillsEnvironment.globalUpdate, { reportFailure: true });
  const remove = useAtomCommand(skillsEnvironment.globalDelete, { reportFailure: true });
  const rollback = useAtomCommand(skillsEnvironment.globalRollback, { reportFailure: true });
  const projectOverride = useAtomCommand(skillsEnvironment.projectSetOverride, {
    reportFailure: true,
  });
  const projectDisable = useAtomCommand(skillsEnvironment.projectSetDisabled, {
    reportFailure: true,
  });
  const projectReset = useAtomCommand(skillsEnvironment.projectDeleteState, {
    reportFailure: true,
  });
  const globalRename = useAtomCommand(skillsEnvironment.globalRename, { reportFailure: true });
  const projectRename = useAtomCommand(skillsEnvironment.projectRename, { reportFailure: true });
  const [name, setName] = useState(entry.name);
  const [body, setBody] = useState("");
  const [key, setKey] = useState<string>(entry.key);
  const canRename =
    (!projectId || entry.scope === "project") &&
    key.length <= 64 &&
    key !== entry.key &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key);

  useEffect(() => {
    if (!contentState.data) return;
    setName(contentState.data.content.name);
    setBody(contentState.data.content.body);
  }, [contentState.data]);

  const save = async () => {
    if (projectId) {
      await projectOverride({
        environmentId,
        input: {
          projectId,
          expectedRevision: catalogRevision,
          key: entry.key,
          content: { name: name.trim(), body },
        },
      });
    } else if (entry.scope === "global") {
      await update({
        environmentId,
        input: {
          environmentId,
          skillId: entry.id,
          expectedHash: entry.revision.hash,
          content: { name: name.trim(), body },
        },
      });
    }
    refresh();
  };

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={entry.validity === "valid" ? "success" : "error"}>{entry.validity}</Badge>
        <span className="text-xs text-muted-foreground">{compatibilityLabel(entry)}</span>
        {entry.application ? (
          <Badge variant={entry.application.status === "failed" ? "error" : "outline"}>
            {skillStatusLabel(entry.application.status)}
          </Badge>
        ) : null}
      </div>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Portable key
        <Input value={key} onChange={(event) => setKey(event.currentTarget.value)} />
      </label>
      {!projectId && entry.scope === "global" && key !== entry.key ? (
        <p className="text-xs text-muted-foreground">
          Renaming leaves existing project overrides and disabled entries at the old key. Those
          projects will inherit the renamed skill separately.
        </p>
      ) : null}
      {entry.conflict ? (
        <p className="text-sm text-muted-foreground">{entry.conflict.message}</p>
      ) : null}
      {entry.application?.failure ? (
        <p className="text-sm text-destructive">{entry.application.failure.message}</p>
      ) : null}
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Display name
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Instructions
        <Textarea
          className="font-mono"
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!name.trim() || contentState.isPending}
        >
          {projectId && entry.scope === "global" ? "Save as project override" : "Save skill"}
        </Button>
        {canRename ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const nextKey = ManagedSkillKey.make(key);
              const rename =
                projectId && entry.scope === "project"
                  ? projectRename({
                      environmentId,
                      input: {
                        projectId,
                        skillId: entry.id,
                        expectedHash: entry.revision.hash,
                        key: nextKey,
                      },
                    })
                  : !projectId && entry.scope === "global"
                    ? globalRename({
                        environmentId,
                        input: {
                          environmentId,
                          skillId: entry.id,
                          expectedHash: entry.revision.hash,
                          key: nextKey,
                        },
                      })
                    : Promise.resolve();
              void rename.then(refresh);
            }}
          >
            Rename key
          </Button>
        ) : null}
        {projectId ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void projectDisable({
                  environmentId,
                  input: { projectId, expectedRevision: catalogRevision, key: entry.key },
                }).then(refresh)
              }
            >
              Disable for project
            </Button>
            {entry.projectState !== "inherit" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void projectReset({
                    environmentId,
                    input: { projectId, expectedRevision: catalogRevision, key: entry.key },
                  }).then(refresh)
                }
              >
                Return to inheritance
              </Button>
            ) : null}
          </>
        ) : null}
        {entry.scope === "global" && !projectId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void remove({
                environmentId,
                input: { environmentId, skillId: entry.id, expectedHash: entry.revision.hash },
              }).then(refresh)
            }
          >
            Delete
          </Button>
        ) : null}
      </div>
      {historyState.data?.entries.length ? (
        <div className="grid gap-2 border-t border-border/50 pt-4">
          <h3 className="text-xs font-medium text-muted-foreground">Previous versions</h3>
          {historyState.data.entries.map((history) => (
            <div
              key={history.revision.revision}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span>
                Revision {history.revision.revision} · {history.name}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void rollback({
                    environmentId,
                    input: {
                      environmentId,
                      skillId: entry.id,
                      expectedHash: entry.revision.hash,
                      revision: history.revision.revision,
                    },
                  }).then(refresh)
                }
              >
                <RotateCcwIcon /> Restore
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NativeSkillDetail({
  environmentId,
  entry,
  catalogRevision,
  refresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: Extract<SkillCatalogSummary, { readonly origin: "native" }>;
  readonly catalogRevision: ReturnType<typeof SkillCatalogRevision.make>;
  readonly refresh: () => void;
}) {
  const native = useEnvironmentQuery(
    skillsEnvironment.nativeContent({
      environmentId,
      input: { observationId: entry.id, maxBytes: 64 * 1024 },
    }),
  );
  const importNative = useAtomCommand(skillsEnvironment.nativeImport, { reportFailure: true });
  const [importKey, setImportKey] = useState<string>(
    entry.key.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.key) ? entry.key : "",
  );
  const validImportKey = importKey.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(importKey);
  return (
    <div className="grid content-start gap-4 p-4">
      <div>
        <h3 className="font-medium">{entry.name}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Provider-owned · {entry.scopeId}. T3 will never edit or delete this source.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Import creates an independent T3-owned copy. Later provider changes will not overwrite it.
      </p>
      {native.data?.content ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
          {native.data.content}
        </pre>
      ) : null}
      {native.isPending ? (
        <p className="text-sm text-muted-foreground">Reading native skill…</p>
      ) : null}
      {native.error ? <p className="text-sm text-destructive">{native.error}</p> : null}
      {native.data ? (
        <p className="text-xs text-muted-foreground">
          {native.data.provenance} · {native.data.observation.freshness}
          {native.data.truncated ? " · Preview truncated to 64 KiB" : ""}
        </p>
      ) : null}
      {entry.conflict ? (
        <p className="text-xs text-muted-foreground">{entry.conflict.message}</p>
      ) : null}
      <label className="grid gap-1.5 text-xs text-muted-foreground">
        Portable key for the T3 copy
        <Input
          value={importKey}
          placeholder="portable-key"
          onChange={(event) => setImportKey(event.currentTarget.value)}
        />
      </label>
      <Button
        className="justify-self-start"
        size="sm"
        disabled={!validImportKey}
        onClick={() =>
          void importNative({
            environmentId,
            input: {
              environmentId,
              expectedRevision: catalogRevision,
              observationId: entry.id,
              key: ManagedSkillKey.make(importKey),
            },
          }).then(refresh)
        }
      >
        <ImportIcon /> Import into T3
      </Button>
    </div>
  );
}

export function SkillsSettings() {
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId;
  const projectId = target?.projectId;
  const catalogInput = useMemo(() => (projectId ? { projectId } : {}), [projectId]);
  const catalog = useEnvironmentQuery(
    environmentId ? skillsEnvironment.catalog({ environmentId, input: catalogInput }) : null,
  );
  const create = useAtomCommand(skillsEnvironment.globalCreate, { reportFailure: true });
  const createProject = useAtomCommand(skillsEnvironment.projectSetOverride, {
    reportFailure: true,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const sections = skillSurfaceSections(catalog.data?.entries ?? []);
  const selected = (catalog.data?.entries ?? []).find((entry) => entry.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && catalog.data?.entries[0]) setSelectedId(catalog.data.entries[0].id);
  }, [catalog.data?.entries, selectedId]);

  if (!environmentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Choose a connected environment to manage its skills.
      </p>
    );
  }

  return (
    <SettingsPageContainer width="wide" className="space-y-6">
      <SkillCatalogSubscription environmentId={environmentId} input={catalogInput} />
      <SettingsSection
        id="skills-catalog"
        title="Portable skills"
        icon={<BookOpenIcon className="size-4" />}
      >
        <div className="grid min-h-96 md:grid-cols-[minmax(14rem,0.8fr)_minmax(22rem,1.4fr)]">
          <div className="border-b border-border/50 md:border-e md:border-b-0">
            {catalog.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">Reading catalog…</p>
            ) : null}
            {catalog.error ? <p className="p-4 text-sm text-destructive">{catalog.error}</p> : null}
            {catalog.data?.nativeDiscoveries
              ?.filter((discovery) => discovery.freshness !== "fresh" || discovery.discoveryError)
              .map((discovery) => (
                <p
                  key={discovery.providerInstanceId}
                  className="border-b border-border/50 p-3 text-xs text-muted-foreground"
                >
                  {discovery.providerInstanceId} · Native discovery {discovery.freshness}
                  {discovery.discoveryError ? `: ${discovery.discoveryError.message}` : ""}
                </p>
              ))}
            {catalog.data?.diagnostics?.map((diagnostic) => (
              <div
                key={`${diagnostic.scope}:${diagnostic.scopeId}:${diagnostic.name}`}
                className="border-b border-border/50 p-3 text-sm"
                role="status"
              >
                <p className="font-medium text-destructive">{diagnostic.name} · Unavailable</p>
                <p className="text-xs text-muted-foreground">
                  {diagnostic.scope === "global" ? "Environment skill" : "Project skill"}
                </p>
                {diagnostic.reasons.map((reason) => (
                  <p
                    key={`${reason.code}:${reason.message}`}
                    className="mt-1 text-xs text-muted-foreground"
                  >
                    {reason.message}
                  </p>
                ))}
              </div>
            ))}
            {sections.managed.length === 0 && sections.native.length === 0 && !catalog.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">
                {catalog.data?.diagnostics?.length
                  ? "No valid skill definitions were found."
                  : "No managed or provider-native skills were found."}
              </p>
            ) : null}
            {sections.managed.map((entry) => (
              <SkillRow
                key={entry.id}
                entry={entry}
                selected={entry.id === selected?.id}
                onSelect={() => setSelectedId(entry.id)}
              />
            ))}
            {sections.native.length ? (
              <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Provider-owned
              </div>
            ) : null}
            {sections.native.map((entry) => (
              <SkillRow
                key={entry.id}
                entry={entry}
                selected={entry.id === selected?.id}
                onSelect={() => setSelectedId(entry.id)}
              />
            ))}
          </div>
          {selected?.origin === "managed" ? (
            <ManagedSkillEditor
              key={selected.id}
              entry={selected}
              environmentId={environmentId}
              {...(projectId ? { projectId } : {})}
              catalogRevision={catalog.data?.catalogRevision ?? SkillCatalogRevision.make(0)}
              refresh={catalog.refresh}
            />
          ) : selected?.origin === "native" ? (
            <NativeSkillDetail
              key={selected.id}
              environmentId={environmentId}
              entry={selected}
              catalogRevision={catalog.data?.catalogRevision ?? SkillCatalogRevision.make(0)}
              refresh={catalog.refresh}
            />
          ) : (
            <div className="grid place-items-center p-8 text-sm text-muted-foreground">
              Select a skill to inspect its provenance and delivery state.
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Create a managed skill" icon={<PlusIcon className="size-4" />}>
        <div className="grid gap-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              placeholder="portable-key"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.currentTarget.value)}
            />
            <Input
              placeholder="Display name"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
            />
          </div>
          <Textarea
            placeholder="Instructions the provider should load…"
            value={bodyDraft}
            onChange={(event) => setBodyDraft(event.currentTarget.value)}
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              <CloudCogIcon className="me-1 inline size-3.5" />
              {projectId
                ? "Stored in this project's Git workspace."
                : "Stored in this environment's global skills."}
            </p>
            <Button
              size="sm"
              disabled={
                !nameDraft.trim() ||
                keyDraft.length > 64 ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(keyDraft)
              }
              onClick={() => {
                const key = ManagedSkillKey.make(keyDraft);
                const creation = projectId
                  ? createProject({
                      environmentId,
                      input: {
                        projectId,
                        expectedRevision:
                          catalog.data?.catalogRevision ?? SkillCatalogRevision.make(0),
                        key,
                        content: { name: nameDraft.trim(), body: bodyDraft },
                      },
                    })
                  : create({
                      environmentId,
                      input: {
                        environmentId,
                        expectedRevision:
                          catalog.data?.catalogRevision ?? SkillCatalogRevision.make(0),
                        content: { key, name: nameDraft.trim(), body: bodyDraft },
                      },
                    });
                void creation.then(() => {
                  setKeyDraft("");
                  setNameDraft("");
                  setBodyDraft("");
                  catalog.refresh();
                });
              }}
            >
              Create skill
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function SkillCatalogSubscription({
  environmentId,
  input,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly projectId?: ProjectId };
}) {
  useAtomValue(skillsEnvironment.changes({ environmentId, input }));
  return null;
}
