import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShell } from "../../state/entities";
import { useResourceCatalogSubscriptions } from "../../state/resources";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { McpCatalogSettings } from "./McpCatalogSettings";
import { ResourceEmpty, ResourceHint, ResourceRow } from "./ResourceSettingsParts";
import {
  resolveResourceCheckout,
  type InventoryKindFilter,
  type ResourceSettingsTarget,
} from "./resourceInventory";
import { SettingsPageContainer, SettingsSection, useSettingsSearchTarget } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { SkillsSettings } from "./SkillsSettings";
import { TextResourcesSettings } from "./TextResourcesSettings";

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
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<InventoryKindFilter>("all");
  const filterRef = useSettingsSearchTarget<HTMLDivElement>("resource-inventory");
  useResourceCatalogSubscriptions({
    environmentId: target.environmentId,
    ...(target.projectId === null ? {} : { projectId: target.projectId }),
    ...(target.threadId === null ? {} : { threadId: target.threadId }),
  });
  return (
    <>
      <div
        id="resource-inventory"
        ref={filterRef}
        tabIndex={-1}
        className="flex flex-wrap items-center gap-3 px-3 sm:px-4"
      >
        <div className="w-full sm:w-64">
          <Input
            size="sm"
            type="search"
            aria-label="Filter resources"
            placeholder="Filter by name or key"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="max-w-full">
          <ToggleGroup
            aria-label="Resource kind"
            size="sm"
            wrap
            value={[kind]}
            onValueChange={(next) => {
              const value = next[0];
              if (
                value === "all" ||
                value === "mcp" ||
                value === "skill" ||
                value === "command" ||
                value === "snippet"
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
      </div>
      {kind === "all" || kind === "mcp" ? (
        <McpCatalogSettings target={target} query={query} />
      ) : null}
      {kind === "all" || kind === "skill" ? <SkillsSettings target={target} query={query} /> : null}
      {kind === "all" || kind === "command" || kind === "snippet" ? (
        <TextResourcesSettings target={target} query={query} kind={kind === "all" ? null : kind} />
      ) : null}
    </>
  );
}
