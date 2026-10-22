import { composeManagedResourceInventory } from "@t3tools/client-runtime/state/managedResources";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import {
  managedTextEnvironment,
  skillsEnvironment,
  useResourceCatalogSubscriptions,
} from "../../state/resources";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { McpCatalogSettings, useMcpCatalogView } from "./McpCatalogSettings";
import { ResourceEmpty, ResourceHint, ResourceRow } from "./ResourceSettingsParts";
import {
  effectiveMcpDefinitions,
  filterInventoryRows,
  INVENTORY_KIND_LABELS,
  inventoryScopeLabel,
  resolveResourceCheckout,
  resourceCatalogInput,
  skillApplicationLabel,
  type InventoryKindFilter,
  type ResourceSettingsTarget,
} from "./resourceInventory";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SkillsSettings } from "./SkillsSettings";
import { TextResourcesSettings } from "./TextResourcesSettings";

const INVENTORY_VISIBLE_ROWS = 200;

/**
 * Settings → Resources. One destination at a time: the selected environment,
 * optionally one project checkout, optionally one of its threads.
 */
export function ResourcesSettings({ thread }: { thread?: string | undefined }) {
  const { target: scopeTarget, scope, search, selectScope } = useSettingsScope();
  const environmentId = scopeTarget?.environmentId ?? null;
  const threadShell = useThreadShell(
    environmentId !== null && thread ? { environmentId, threadId: ThreadId.make(thread) } : null,
  );
  if (scopeTarget === null || environmentId === null)
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect an environment to manage its resources.
        </p>
      </SettingsPageContainer>
    );
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  // A grouped project spans checkouts; writes need exactly one, chosen explicitly.
  const checkout = projectScope
    ? resolveResourceCheckout(
        scope.members.filter((member) => member.environmentId === environmentId),
      )
    : null;
  if (checkout !== null && checkout.kind !== "single")
    return (
      <SettingsPageContainer>
        <SettingsSection id="resource-checkout" title="Choose a checkout">
          {checkout.kind === "none" ? (
            <ResourceEmpty>This project has no checkout on {environmentId}.</ResourceEmpty>
          ) : (
            <>
              <div className="px-3 py-2 sm:px-4">
                <ResourceHint>
                  This project has several checkouts on this environment, and each keeps its own
                  resources. Choose the one to view and change.
                </ResourceHint>
              </div>
              {checkout.members.map((member) => (
                <ResourceRow
                  key={member.physicalProjectKey}
                  title={<code className="truncate text-xs">{member.workspaceRoot}</code>}
                  actions={
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        selectScope({ ...search, checkout: member.physicalProjectKey })
                      }
                    >
                      Open
                    </Button>
                  }
                />
              ))}
            </>
          )}
        </SettingsSection>
      </SettingsPageContainer>
    );
  const projectId = checkout?.kind === "single" ? checkout.projectId : null;
  // A thread outside the selected project would widen the destination; drop it instead.
  const threadMatches =
    threadShell !== null && projectId !== null && threadShell.projectId === projectId;
  const target: ResourceSettingsTarget = {
    environmentId,
    projectId,
    threadId: threadMatches ? threadShell.id : null,
    providerInstanceId: threadMatches ? threadShell.providerInstanceId : null,
  };
  return (
    <SettingsPageContainer>
      {thread ? (
        <ThreadTargetNotice
          environmentId={environmentId}
          title={threadMatches ? threadShell.title : null}
        />
      ) : null}
      <ResourcesContent
        key={JSON.stringify([target.environmentId, target.projectId, target.threadId])}
        target={target}
      />
    </SettingsPageContainer>
  );
}

function ThreadTargetNotice({
  environmentId,
  title,
}: {
  environmentId: EnvironmentId;
  title: string | null;
}) {
  const navigate = useNavigate();
  const clear = () =>
    void navigate({
      to: "/settings/resources",
      search: ({ thread: _thread, ...rest }) => rest,
    });
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-sm sm:px-4">
      <span className="min-w-0 truncate">
        {title === null ? (
          <span className="text-muted-foreground">
            That thread isn't in the selected project on {environmentId}. Showing project resources.
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">Thread overrides for </span>
            <span className="font-medium">{title}</span>
          </>
        )}
      </span>
      <Button size="xs" variant="ghost" onClick={clear}>
        <XIcon className="size-3.5" />
        {title === null ? "Dismiss" : "Show project"}
      </Button>
    </div>
  );
}

function ResourcesContent({ target }: { target: ResourceSettingsTarget }) {
  useResourceCatalogSubscriptions({
    environmentId: target.environmentId,
    ...(target.projectId === null ? {} : { projectId: target.projectId }),
    ...(target.threadId === null ? {} : { threadId: target.threadId }),
  });
  return (
    <>
      <ResourceInventory target={target} />
      <McpCatalogSettings target={target} />
      <SkillsSettings target={target} />
      <TextResourcesSettings target={target} />
    </>
  );
}

/**
 * A read-only view across the three catalogs for this destination. It holds
 * no bodies, transports or secrets, and the catalogs remain the only stores.
 */
function ResourceInventory({ target }: { target: ResourceSettingsTarget }) {
  const input = resourceCatalogInput(target);
  const skillInput = {
    ...input,
    ...(target.threadId !== null && target.providerInstanceId !== null
      ? { providerInstanceId: target.providerInstanceId }
      : {}),
  };
  const skills = useEnvironmentQuery(
    skillsEnvironment.catalog({ environmentId: target.environmentId, input: skillInput }),
  );
  const text = useEnvironmentQuery(
    managedTextEnvironment.catalog({ environmentId: target.environmentId, input }),
  );
  const mcpView = useMcpCatalogView(target);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<InventoryKindFilter>("all");
  // What this destination effectively gets, overrides applied, not every raw definition.
  const mcp =
    mcpView.view === null
      ? null
      : {
          revision: mcpView.view.own?.data?.revision ?? 0,
          definitions: effectiveMcpDefinitions(mcpView.view.rows),
          overrides: [],
        };
  const inventory =
    skills.data === null || text.data === null || mcp === null
      ? null
      : composeManagedResourceInventory({ skills: skills.data, text: text.data, mcp });
  const rows = inventory === null ? [] : filterInventoryRows(inventory.rows, query, kind);
  const loadFailed = [skills, text, mcpView.globalRead, mcpView.projectRead].some(
    (view) => view.error !== null,
  );

  return (
    <SettingsSection
      id="resource-inventory"
      title="Overview"
      headerAction={
        inventory === null ? null : (
          <span className="text-xs text-muted-foreground">
            {inventory.rows.length}
            {inventory.truncated ? "+" : ""} resources
          </span>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <Input
          size="sm"
          type="search"
          aria-label="Filter resources"
          placeholder="Filter by name or key"
          className="max-w-64"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ToggleGroup
          aria-label="Resource kind"
          size="sm"
          value={[kind]}
          onValueChange={(next) => {
            const value = next[0];
            if (
              value === "all" ||
              value === "skill" ||
              value === "command" ||
              value === "snippet" ||
              value === "mcp"
            )
              setKind(value);
          }}
        >
          <Toggle value="all">All</Toggle>
          <Toggle value="mcp">MCP</Toggle>
          <Toggle value="skill">Skills</Toggle>
          <Toggle value="command">Commands</Toggle>
          <Toggle value="snippet">Snippets</Toggle>
        </ToggleGroup>
      </div>
      {inventory === null ? (
        <ResourceEmpty>
          {loadFailed
            ? "Some catalogs couldn't load; see their sections below."
            : "Loading resources…"}
        </ResourceEmpty>
      ) : rows.length === 0 ? (
        <ResourceEmpty>
          {inventory.rows.length === 0
            ? "Nothing configured here yet."
            : "No resource matches this filter."}
        </ResourceEmpty>
      ) : (
        rows.slice(0, INVENTORY_VISIBLE_ROWS).map((row) => (
          <ResourceRow
            key={row.id}
            title={
              <>
                <span className="font-medium">{row.name}</span>
                <code className="text-xs text-muted-foreground">
                  {row.kind === "skill" ? "$" : row.kind === "mcp" ? "" : "/"}
                  {row.key}
                </code>
              </>
            }
            badges={
              <>
                <Badge size="sm" variant="secondary">
                  {INVENTORY_KIND_LABELS[row.kind]}
                </Badge>
                <Badge size="sm" variant="outline">
                  {inventoryScopeLabel(row)}
                </Badge>
                {!row.enabled ? (
                  <Badge size="sm" variant="outline">
                    Off
                  </Badge>
                ) : null}
              </>
            }
            meta={
              row.kind === "skill" && row.application
                ? skillApplicationLabel(row.application)
                : undefined
            }
          />
        ))
      )}
      {inventory?.truncated || rows.length > INVENTORY_VISIBLE_ROWS ? (
        <div className="px-3 py-2 sm:px-4">
          <ResourceHint>
            Showing the first {Math.min(rows.length, INVENTORY_VISIBLE_ROWS)}. Filter to find
            others; each section below lists its full catalog.
          </ResourceHint>
        </div>
      ) : null}
    </SettingsSection>
  );
}
