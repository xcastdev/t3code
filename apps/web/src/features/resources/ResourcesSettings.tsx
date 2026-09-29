import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { BlocksIcon, PlusIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { managedTextResourcesEnvironment } from "../../state/managedTextResources";
import { mcpCatalogEnvironment } from "../../state/projects";
import { skillsEnvironment } from "../../state/skills";
import { useEnvironmentQuery } from "../../state/query";
import { projectResourceInventory, type InventoryKind } from "./resourceInventory";
import {
  buildResourceTarget,
  makeEnvironmentCreateTarget,
  makeProjectCreateTarget,
  type ResourceTarget,
} from "./resourceTarget";
import { resolveResourceScope } from "./resourceScope";

const KIND_LABELS: Readonly<Record<InventoryKind, string>> = {
  mcp: "MCP servers",
  skill: "Skills",
  command: "Commands",
  snippet: "Snippets",
};

function ResourceSubscriptions({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  useAtomValue(
    skillsEnvironment.changes({
      environmentId,
      input: projectId ? { projectId } : {},
    }),
  );
  useAtomValue(
    managedTextResourcesEnvironment.changes({
      environmentId,
      input: projectId ? { projectId } : {},
    }),
  );
  return null;
}

function McpResourceSubscription({ environmentId }: { readonly environmentId: EnvironmentId }) {
  useAtomValue(mcpCatalogEnvironment.changes({ environmentId, input: {} }));
  return null;
}

function CatalogState({
  title,
  pending,
  error,
  retry,
}: {
  readonly title: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly retry: () => void;
}) {
  if (pending) return <p className="text-sm text-muted-foreground">Reading {title}…</p>;
  if (error === null) return null;
  return (
    <div className="grid gap-2 text-sm text-destructive" role="alert">
      <p>
        {title} could not be read: {error}
      </p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="justify-self-start"
        onClick={retry}
      >
        Retry {title}
      </Button>
    </div>
  );
}

function ResourceLink({
  target,
  search,
  children,
}: {
  readonly target: ResourceTarget;
  readonly search: {
    readonly project?: string;
    readonly machine?: string;
    readonly checkout?: string;
  };
  readonly children: ReactNode;
}) {
  const to =
    target.kind === "skill"
      ? "/settings/skills"
      : target.kind === "command" || target.kind === "snippet"
        ? "/settings/commands"
        : target.scope === "project"
          ? "/settings/projects"
          : "/settings/integrations";
  const hash =
    target.intent !== "create"
      ? undefined
      : target.kind === "skill"
        ? "create-managed-skill"
        : target.kind === "mcp"
          ? target.scope === "project"
            ? "mcp-catalog-project"
            : "mcp-catalog"
          : "managed-text-resources";
  return (
    <Link
      to={to}
      search={{ ...search, resource: buildResourceTarget(target) }}
      {...(hash ? { hash } : {})}
      className="grid w-full gap-1 border-b border-border/40 px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}

export function ResourcesSettings() {
  const { scope, environments, targets, search } = useSettingsScope();
  const resolution = useMemo(
    () => resolveResourceScope({ scope, environments, targets }),
    [environments, scope, targets],
  );
  const environmentId = resolution.kind === "ready" ? resolution.environmentId : null;
  const projectId = resolution.kind === "ready" ? resolution.projectId : null;
  const skillInput = useMemo(() => (projectId ? { projectId } : {}), [projectId]);
  const textInput = useMemo(() => (projectId ? { projectId } : {}), [projectId]);
  const skills = useEnvironmentQuery(
    resolution.kind === "ready"
      ? skillsEnvironment.catalog({ environmentId: resolution.environmentId, input: skillInput })
      : null,
  );
  const textResources = useEnvironmentQuery(
    resolution.kind === "ready"
      ? managedTextResourcesEnvironment.catalog({
          environmentId: resolution.environmentId,
          input: textInput,
        })
      : null,
  );
  const globalMcp = useEnvironmentQuery(
    resolution.kind === "ready" && resolution.mcpMode === "global"
      ? mcpCatalogEnvironment.globalState({
          environmentId: resolution.environmentId,
          input: { scope: "global", scopeId: resolution.environmentId },
        })
      : null,
  );
  const projectMcp = useEnvironmentQuery(
    resolution.kind === "ready" && resolution.mcpMode === "scoped" && resolution.projectId
      ? mcpCatalogEnvironment.projectState({
          environmentId: resolution.environmentId,
          input: { scope: "project", scopeId: resolution.projectId },
        })
      : null,
  );
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<InventoryKind | "all">("all");
  const rows = useMemo(() => {
    if (resolution.kind !== "ready") return [];
    return projectResourceInventory({
      environmentId: resolution.environmentId,
      skills: skills.data ?? undefined,
      textResources: textResources.data ?? undefined,
      globalMcp: globalMcp.data ?? undefined,
      projectMcp: projectMcp.data ?? undefined,
      ...(projectId ? { projectId } : {}),
    });
  }, [globalMcp.data, projectId, projectMcp.data, resolution, skills.data, textResources.data]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      (kindFilter === "all" || row.kind === kindFilter) &&
      (normalizedQuery.length === 0 ||
        `${row.name} ${row.identity} ${row.ownerScope} ${row.status} ${row.statusDetail ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );
  const targetSearch = {
    ...(search.project ? { project: search.project } : {}),
    ...(search.machine ? { machine: search.machine } : {}),
    ...(search.checkout ? { checkout: search.checkout } : {}),
  };
  const createTarget = (kind: InventoryKind) =>
    projectId
      ? makeProjectCreateTarget(kind, projectId)
      : environmentId
        ? makeEnvironmentCreateTarget(kind, environmentId)
        : null;
  const canCreateMcp =
    resolution.kind === "ready" &&
    (resolution.mcpMode === "global" || resolution.mcpMode === "scoped");

  return (
    <SettingsPageContainer width="wide" className="space-y-5">
      {resolution.kind !== "ready" ? (
        <SettingsSection title="Resources">
          <p className="p-4 text-sm text-muted-foreground">{resolution.message}</p>
        </SettingsSection>
      ) : (
        <>
          <ResourceSubscriptions environmentId={resolution.environmentId} projectId={projectId} />
          {resolution.mcpMode === "global" || resolution.mcpMode === "scoped" ? (
            <McpResourceSubscription environmentId={resolution.environmentId} />
          ) : null}
          <SettingsSection
            title="Resources"
            icon={<BlocksIcon className="size-4" />}
            headerAction={
              <div className="flex flex-wrap gap-1">
                {(["mcp", "skill", "command", "snippet"] as const).map((kind) => {
                  if (kind === "mcp" && !canCreateMcp) return null;
                  const target = createTarget(kind);
                  return target ? (
                    <ResourceLink key={kind} target={target} search={targetSearch}>
                      <span className="flex items-center gap-1 text-sm">
                        <PlusIcon className="size-3.5" />
                        {KIND_LABELS[kind].replace(/s$/, "")}
                      </span>
                    </ResourceLink>
                  ) : null;
                })}
              </div>
            }
          >
            <div className="grid gap-3 border-b border-border/50 p-3">
              <label className="relative block">
                <SearchIcon className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  aria-label="Search resources"
                  className="ps-8"
                  placeholder="Search by name or key"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
              <div className="flex flex-wrap gap-1" aria-label="Filter resource type">
                {(["all", "mcp", "skill", "command", "snippet"] as const).map((kind) => (
                  <Button
                    key={kind}
                    type="button"
                    variant={kindFilter === kind ? "secondary" : "ghost"}
                    size="xs"
                    aria-pressed={kindFilter === kind}
                    onClick={() => setKindFilter(kind)}
                  >
                    {kind === "all" ? "All" : KIND_LABELS[kind]}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 p-3">
              <CatalogState
                title="skills"
                pending={skills.isPending}
                error={skills.error}
                retry={skills.refresh}
              />
              <CatalogState
                title="commands and snippets"
                pending={textResources.isPending}
                error={textResources.error}
                retry={textResources.refresh}
              />
              {resolution.mcpMode === "global" ? (
                <CatalogState
                  title="MCP servers"
                  pending={globalMcp.isPending}
                  error={globalMcp.error}
                  retry={globalMcp.refresh}
                />
              ) : resolution.mcpMode === "scoped" ? (
                <CatalogState
                  title="MCP servers"
                  pending={projectMcp.isPending}
                  error={projectMcp.error}
                  retry={projectMcp.refresh}
                />
              ) : resolution.mcpMode === "legacy" ? (
                <p className="text-sm text-muted-foreground">
                  Scoped MCP inventory is unavailable on this server. Use the project MCP editor
                  below.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  MCP inventory is unavailable on this server.
                </p>
              )}
              {resolution.mcpMode === "legacy" ? (
                <Link
                  to="/settings/projects"
                  search={targetSearch}
                  className="text-sm text-primary underline underline-offset-4"
                >
                  Open project MCP settings
                </Link>
              ) : null}
            </div>
            <div className="divide-y divide-border/40">
              {visibleRows.map((row) => (
                <ResourceLink key={row.key} target={row.target} search={targetSearch}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{row.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {KIND_LABELS[row.kind]}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <code>{row.identity}</code>
                    <span>{row.ownerScope}</span>
                    <span>{row.status}</span>
                    {row.statusDetail ? <span>{row.statusDetail}</span> : null}
                    {row.diagnostic ? <span>Recovery</span> : null}
                  </span>
                </ResourceLink>
              ))}
              {visibleRows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {rows.length === 0
                    ? "No resources are defined in this scope."
                    : "No resources match this search."}
                </p>
              ) : null}
            </div>
          </SettingsSection>
        </>
      )}
    </SettingsPageContainer>
  );
}
