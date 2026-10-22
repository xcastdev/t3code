import { effectiveMcpCatalogDefinitions } from "@t3tools/client-runtime/resource-actions";
import { assistantHomeTarget } from "@t3tools/client-runtime/state/assistants";
import type {
  AssistantHomeBinding,
  AssistantResourceSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { useEnvironmentQuery } from "../../state/query";
import {
  managedTextEnvironment,
  mcpCatalogEnvironment,
  skillsEnvironment,
  useResourceCatalogSubscriptions,
} from "../../state/resources";
import { WorkBlock, WorkText } from "../work/WorkParts";
import {
  setAssistantMcpTools,
  toggleAssistantInstruction,
  toggleAssistantSkill,
} from "@t3tools/client-runtime/assistant-presentation";
import { AgentInput } from "./AssistantParts";

/**
 * Chooses from the catalogs the agent's home thread actually resolves, the
 * same ones Settings › Skills and commands edits. A selection pins a revision;
 * a changed entry stays pinned until the newer revision is picked on purpose.
 * MCP servers themselves are authored on web or desktop.
 */
export function AgentResourceBindings(props: {
  readonly binding: AssistantHomeBinding;
  readonly providerInstanceId: ProviderInstanceId;
  readonly value: AssistantResourceSelection;
  readonly disabled: boolean;
  readonly onChange: (value: AssistantResourceSelection) => void;
}) {
  const { value, disabled, onChange } = props;
  const target = assistantHomeTarget(props.binding);
  useResourceCatalogSubscriptions(target);
  const skills = useEnvironmentQuery(
    skillsEnvironment.catalog({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        threadId: target.threadId,
        providerInstanceId: props.providerInstanceId,
      },
    }),
  );
  const text = useEnvironmentQuery(
    managedTextEnvironment.catalog({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, threadId: target.threadId },
    }),
  );
  const globalMcp = useEnvironmentQuery(
    mcpCatalogEnvironment.read({
      environmentId: target.environmentId,
      input: { scope: "global", scopeId: target.environmentId },
    }),
  );
  const projectMcp = useEnvironmentQuery(
    mcpCatalogEnvironment.read({
      environmentId: target.environmentId,
      input: { scope: "project", scopeId: target.projectId },
    }),
  );

  const managedSkills = (skills.data?.entries ?? []).flatMap((entry) =>
    entry.origin === "managed" && entry.effective ? [entry] : [],
  );
  const instructions = (text.data?.entries ?? []).flatMap((entry) =>
    entry.id !== undefined && entry.effective ? [{ ...entry, id: entry.id }] : [],
  );
  const definitions =
    globalMcp.data === null
      ? null
      : effectiveMcpCatalogDefinitions({
          inherited: globalMcp.data.definitions,
          own: projectMcp.data?.definitions ?? [],
          overrides: projectMcp.data?.overrides ?? [],
        });
  const missingSkills = value.skills.filter(
    (selected) => !managedSkills.some((entry) => entry.id === selected.skillId),
  );
  const missingInstructions = value.instructions.filter(
    (selected) => !instructions.some((entry) => entry.id === selected.resourceId),
  );
  const servers = [
    ...(definitions ?? []).map((definition) => ({
      definitionId: definition.definitionId,
      name: String(definition.name),
    })),
    ...value.mcpTools
      .filter((tool) => !(definitions ?? []).some((def) => def.definitionId === tool.definitionId))
      .map((tool) => ({ definitionId: tool.definitionId, name: "Unavailable server" })),
  ];

  return (
    <>
      <ListSection
        title="Skills"
        footer="Managed skills its chat can use. Add or edit them in Settings › Skills and commands."
      >
        {skills.data === null ? (
          <WorkBlock>
            <WorkText muted>
              {skills.error ? "Skills aren't available." : "Loading skills…"}
            </WorkText>
          </WorkBlock>
        ) : managedSkills.length === 0 ? (
          <WorkBlock>
            <WorkText muted>No managed skills here yet.</WorkText>
          </WorkBlock>
        ) : (
          managedSkills.map((entry) => {
            const selected = value.skills.find((skill) => skill.skillId === entry.id);
            const changed =
              selected !== undefined &&
              (selected.revision.revision !== entry.revision.revision ||
                selected.revision.hash !== entry.revision.hash);
            const pick = { skillId: entry.id, revision: entry.revision };
            return (
              <View key={entry.id}>
                <ListChoiceRow
                  label={entry.name}
                  description={changed ? "A newer revision is available" : undefined}
                  selected={selected !== undefined}
                  disabled={disabled}
                  onPress={() => onChange(toggleAssistantSkill(value, pick))}
                />
                {changed ? (
                  <ListActionRow
                    label="Use current revision"
                    disabled={disabled}
                    onPress={() =>
                      onChange(toggleAssistantSkill(toggleAssistantSkill(value, pick), pick))
                    }
                  />
                ) : null}
              </View>
            );
          })
        )}
        {missingSkills.map((skill) => (
          <ListActionRow
            key={skill.skillId}
            label="Remove a skill that is no longer available"
            tone="danger"
            disabled={disabled}
            onPress={() => onChange(toggleAssistantSkill(value, skill))}
          />
        ))}
      </ListSection>
      <ListSection
        title="Instructions"
        footer="Commands and snippets added to the agent's instructions on each turn."
      >
        {text.data === null ? (
          <WorkBlock>
            <WorkText muted>
              {text.error ? "Commands aren't available." : "Loading commands…"}
            </WorkText>
          </WorkBlock>
        ) : instructions.length === 0 ? (
          <WorkBlock>
            <WorkText muted>No commands or snippets here yet.</WorkText>
          </WorkBlock>
        ) : (
          instructions.map((entry) => {
            const selected = value.instructions.find((item) => item.resourceId === entry.id);
            const pick = { resourceId: entry.id, revision: entry.revision };
            const changed = selected !== undefined && selected.revision !== entry.revision;
            return (
              <View key={entry.id}>
                <ListChoiceRow
                  label={entry.name ?? entry.key}
                  description={
                    changed ? `${entry.kind} · a newer revision is available` : entry.kind
                  }
                  selected={selected !== undefined}
                  disabled={disabled}
                  onPress={() => onChange(toggleAssistantInstruction(value, pick))}
                />
                {changed ? (
                  <ListActionRow
                    label="Use current revision"
                    disabled={disabled}
                    onPress={() =>
                      onChange(
                        toggleAssistantInstruction(
                          toggleAssistantInstruction(value, selected),
                          pick,
                        ),
                      )
                    }
                  />
                ) : null}
              </View>
            );
          })
        )}
        {missingInstructions.map((item) => (
          <ListActionRow
            key={item.resourceId}
            label="Remove an instruction that is no longer available"
            tone="danger"
            disabled={disabled}
            onPress={() => onChange(toggleAssistantInstruction(value, item))}
          />
        ))}
      </ListSection>
      <ListSection
        title="MCP tools"
        footer="Name each tool the agent may call, separated by commas. A server with no names is not available to it. Servers are added on web or desktop."
      >
        {definitions === null ? (
          <WorkBlock>
            <WorkText muted>
              {globalMcp.error ? "MCP servers aren't available." : "Loading MCP servers…"}
            </WorkText>
          </WorkBlock>
        ) : servers.length === 0 ? (
          <WorkBlock>
            <WorkText muted>No MCP servers here.</WorkText>
          </WorkBlock>
        ) : (
          servers.map((server) => (
            <McpToolsField
              key={`${server.definitionId}:${(
                value.mcpTools.find((tool) => tool.definitionId === server.definitionId)
                  ?.toolNames ?? []
              ).join(",")}`}
              name={server.name}
              toolNames={
                value.mcpTools.find((tool) => tool.definitionId === server.definitionId)
                  ?.toolNames ?? []
              }
              disabled={disabled}
              onCommit={(names) =>
                onChange(setAssistantMcpTools(value, server.definitionId, names))
              }
            />
          ))
        )}
      </ListSection>
    </>
  );
}

function McpToolsField(props: {
  readonly name: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onCommit: (text: string) => void;
}) {
  // Keyed by the committed names, so a saved or remote change replaces stale text.
  const [text, setText] = useState(props.toolNames.join(", "));
  const committed = props.toolNames.join(", ");
  return (
    <WorkBlock>
      <AgentInput
        label={props.name}
        value={text}
        placeholder="No tools"
        disabled={props.disabled}
        onChange={setText}
      />
      {text.trim() !== committed ? (
        <ListActionRow
          label="Apply tool names"
          disabled={props.disabled}
          onPress={() => props.onCommit(text)}
        />
      ) : null}
    </WorkBlock>
  );
}
