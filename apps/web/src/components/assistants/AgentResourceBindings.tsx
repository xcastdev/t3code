import { assistantHomeTarget } from "@t3tools/client-runtime/state/assistants";
import type {
  AssistantHomeBinding,
  AssistantResourceSelection,
  ClientSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  managedTextEnvironment,
  skillsEnvironment,
  useResourceCatalogSubscriptions,
} from "../../state/resources";
import { useMcpCatalogView } from "../settings/McpCatalogSettings";
import { effectiveMcpDefinitions } from "../settings/resourceInventory";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { WorkEmpty, WorkMeta, WorkRow } from "../work/WorkLayout";
import {
  setAssistantMcpTools,
  toggleAssistantInstruction,
  toggleAssistantSkill,
} from "@t3tools/client-runtime/assistant-presentation";

const selectGrouping = (settings: ClientSettings) => ({
  sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
  sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
});

/** The Resources settings destination for the agent's home thread, if its project is visible. */
function useAgentResourceSettingsSearch(binding: AssistantHomeBinding) {
  const projects = useProjects();
  const grouping = useClientSettings(selectGrouping);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const groups = buildSidebarProjectSnapshots({
    projects,
    settings: grouping,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  });
  for (const group of groups) {
    const member = group.memberProjects.find(
      (project) =>
        project.environmentId === binding.environmentId && project.id === binding.backingProjectId,
    );
    if (member)
      return {
        project: group.projectKey,
        machine: binding.environmentId,
        checkout: member.physicalProjectKey,
        thread: binding.canonicalThreadId,
      };
  }
  return null;
}

/**
 * Chooses from the catalogs the agent's home thread actually resolves. The
 * selection pins a revision; a changed catalog entry shows as changed until
 * the user picks the new revision deliberately.
 */
export function AgentResourceBindings({
  binding,
  providerInstanceId,
  value,
  disabled,
  onChange,
}: {
  readonly binding: AssistantHomeBinding;
  readonly providerInstanceId: ProviderInstanceId;
  readonly value: AssistantResourceSelection;
  readonly disabled: boolean;
  readonly onChange: (value: AssistantResourceSelection) => void;
}) {
  const navigate = useNavigate();
  // The home thread's exact destination, the same one Resources settings edits for it.
  const target = assistantHomeTarget(binding);
  useResourceCatalogSubscriptions(target);
  const skills = useEnvironmentQuery(
    skillsEnvironment.catalog({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, threadId: target.threadId, providerInstanceId },
    }),
  );
  const text = useEnvironmentQuery(
    managedTextEnvironment.catalog({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, threadId: target.threadId },
    }),
  );
  const mcp = useMcpCatalogView({ ...target, providerInstanceId });
  const settingsSearch = useAgentResourceSettingsSearch(binding);

  const managedSkills = (skills.data?.entries ?? []).flatMap((entry) =>
    entry.origin === "managed" && entry.effective ? [entry] : [],
  );
  const instructions = (text.data?.entries ?? []).flatMap((entry) =>
    entry.id !== undefined && entry.effective ? [{ ...entry, id: entry.id }] : [],
  );
  const definitions = mcp.view === null ? [] : effectiveMcpDefinitions(mcp.view.rows);
  const missingSkills = value.skills.filter(
    (selected) => !managedSkills.some((entry) => entry.id === selected.skillId),
  );
  const missingInstructions = value.instructions.filter(
    (selected) => !instructions.some((entry) => entry.id === selected.resourceId),
  );

  return (
    <>
      <WorkRow>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Skills</p>
          {settingsSearch ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void navigate({ to: "/settings/resources", search: settingsSearch })}
            >
              Manage skills, commands and MCP
            </Button>
          ) : null}
        </div>
        {skills.data === null ? (
          <WorkMeta>{skills.error ? "Skills aren't available." : "Loading skills…"}</WorkMeta>
        ) : managedSkills.length === 0 ? (
          <WorkMeta>No managed skills here yet. Add them in Resources settings.</WorkMeta>
        ) : (
          managedSkills.map((entry) => {
            const selected = value.skills.find((skill) => skill.skillId === entry.id);
            const changed =
              selected !== undefined &&
              (selected.revision.revision !== entry.revision.revision ||
                selected.revision.hash !== entry.revision.hash);
            return (
              <div key={entry.id} className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected !== undefined}
                    disabled={disabled}
                    onCheckedChange={() =>
                      onChange(
                        toggleAssistantSkill(value, {
                          skillId: entry.id,
                          revision: entry.revision,
                        }),
                      )
                    }
                  />
                  <span className="truncate">{entry.name}</span>
                </label>
                {changed ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      onChange(
                        toggleAssistantSkill(
                          toggleAssistantSkill(value, {
                            skillId: entry.id,
                            revision: entry.revision,
                          }),
                          { skillId: entry.id, revision: entry.revision },
                        ),
                      )
                    }
                  >
                    Use current revision
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
        {missingSkills.map((skill) => (
          <div key={skill.skillId} className="flex items-center justify-between gap-2">
            <WorkMeta>Selected skill is no longer available here.</WorkMeta>
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={disabled}
              onClick={() => onChange(toggleAssistantSkill(value, skill))}
            >
              Remove
            </Button>
          </div>
        ))}
      </WorkRow>

      <WorkRow>
        <p className="text-sm font-medium">Instructions</p>
        <WorkMeta>Commands and snippets added to the agent's instructions on each turn.</WorkMeta>
        {text.data === null ? (
          <WorkMeta>{text.error ? "Commands aren't available." : "Loading commands…"}</WorkMeta>
        ) : instructions.length === 0 ? (
          <WorkMeta>No commands or snippets here yet.</WorkMeta>
        ) : (
          instructions.map((entry) => {
            const selected = value.instructions.find((item) => item.resourceId === entry.id);
            return (
              <div key={entry.id} className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected !== undefined}
                    disabled={disabled}
                    onCheckedChange={() =>
                      onChange(
                        toggleAssistantInstruction(value, {
                          resourceId: entry.id,
                          revision: entry.revision,
                        }),
                      )
                    }
                  />
                  <span className="truncate">{entry.name ?? entry.key}</span>
                  <WorkMeta>{entry.kind}</WorkMeta>
                </label>
                {selected !== undefined && selected.revision !== entry.revision ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      onChange(
                        toggleAssistantInstruction(toggleAssistantInstruction(value, selected), {
                          resourceId: entry.id,
                          revision: entry.revision,
                        }),
                      )
                    }
                  >
                    Use current revision
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
        {missingInstructions.map((item) => (
          <div key={item.resourceId} className="flex items-center justify-between gap-2">
            <WorkMeta>Selected instruction is no longer available here.</WorkMeta>
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={disabled}
              onClick={() => onChange(toggleAssistantInstruction(value, item))}
            >
              Remove
            </Button>
          </div>
        ))}
      </WorkRow>

      <WorkRow>
        <p className="text-sm font-medium">MCP tools</p>
        <WorkMeta>
          Name each tool the agent may call, separated by commas. A server with no names is not
          available to the agent.
        </WorkMeta>
        {mcp.view === null ? (
          <WorkMeta>Loading MCP servers…</WorkMeta>
        ) : definitions.length === 0 && value.mcpTools.length === 0 ? (
          <WorkEmpty title="No MCP servers here" />
        ) : (
          [
            ...definitions.map((definition) => ({
              definitionId: definition.definitionId,
              name: definition.name as string,
            })),
            ...value.mcpTools
              .filter((tool) => !definitions.some((def) => def.definitionId === tool.definitionId))
              .map((tool) => ({ definitionId: tool.definitionId, name: "Unavailable server" })),
          ].map((definition) => (
            <McpToolsField
              key={definition.definitionId}
              name={definition.name}
              disabled={disabled}
              toolNames={
                value.mcpTools.find((tool) => tool.definitionId === definition.definitionId)
                  ?.toolNames ?? []
              }
              onCommit={(text) =>
                onChange(setAssistantMcpTools(value, definition.definitionId, text))
              }
            />
          ))
        )}
      </WorkRow>
    </>
  );
}

function McpToolsField({
  name,
  toolNames,
  disabled,
  onCommit,
}: {
  readonly name: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onCommit: (text: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-3">
      <span className="min-w-0 truncate sm:w-40">{name}</span>
      <Input
        size="sm"
        className="min-w-0 flex-1"
        disabled={disabled}
        // Keyed by the committed value, so a server-side change replaces stale text.
        key={toolNames.join(",")}
        defaultValue={toolNames.join(", ")}
        placeholder="No tools"
        onBlur={(event) => onCommit(event.currentTarget.value)}
      />
    </label>
  );
}
