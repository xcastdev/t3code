import { assistantStatus } from "@t3tools/client-runtime/assistant-presentation";
import { assistantHomeTarget } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type {
  AssistantSummary,
  EnvironmentId,
  EnvironmentMachineKind,
  ThreadId,
} from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { AgentAvatar } from "../assistants/AgentAvatar";
import * as Schema from "effect/Schema";
import {
  BotIcon,
  BotMessageSquareIcon,
  ChevronRightIcon,
  ListFilterIcon,
  MessageSquareIcon,
  PlusIcon,
  SquarePenIcon,
} from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import {
  useEnvironmentMachines,
  useEnvironments,
  type EnvironmentPresentation,
} from "~/state/environments";

import {
  useAllAgents,
  useAssistantConnection,
  useAssistantRoster,
} from "../assistants/useAssistants";
import { useCreateAgentChat } from "../assistants/useCreateAgentChat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import {
  SidebarGroup,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import {
  type AgentSidebarFilter,
  agentChatTitle,
  agentChats,
  agentFilterIsActive,
  agentKey,
  agentPassesFilter,
  environmentsWithAgents,
  NO_AGENT_FILTER,
  toggleAgentFilterValue,
} from "./SidebarAgentsList.logic";
import { SidebarScopeRowIcon } from "./SidebarScopeRowIcon";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { RelativeTimeLabel } from "./SidebarThreadRow";

const VISIBLE_CHATS = 5;
const COLLAPSED_AGENTS_KEY = "t3code:sidebar:collapsed-agents";
const CollapsedAgents = Schema.Array(Schema.String);

/** The sidebar's Agents view: each agent's home and its chats, across environments. */
export function SidebarAgentsList(props: {
  readonly query: string;
  readonly filter: AgentSidebarFilter;
  readonly onNavigate: () => void;
}) {
  const { environments } = useEnvironments();
  const threads = useQuietThreadShells();
  const [collapsed, setCollapsed] = useLocalStorage(
    COLLAPSED_AGENTS_KEY,
    [] as ReadonlyArray<string>,
    CollapsedAgents,
  );
  const toggleCollapsed = (key: string) =>
    setCollapsed((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  const shown = environmentsWithAgents(environments, props.filter);
  const machines = useEnvironmentMachines();
  // One list across environments; an environment without agents, or whose roster fails, adds nothing.
  return (
    <SidebarGroup className="flex-1" role="presentation">
      <div className="flex flex-col gap-px">
        {shown.map((environment) => (
          <EnvironmentAgents
            key={environment.environmentId}
            environment={environment}
            machine={machines.get(environment.environmentId) ?? "server"}
            threads={threads}
            query={props.query}
            filter={props.filter}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onNavigate={props.onNavigate}
          />
        ))}
      </div>
    </SidebarGroup>
  );
}

function EnvironmentAgents(props: {
  readonly environment: EnvironmentPresentation;
  readonly machine: EnvironmentMachineKind;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly query: string;
  readonly filter: AgentSidebarFilter;
  readonly collapsed: ReadonlyArray<string>;
  readonly onToggleCollapsed: (key: string) => void;
  readonly onNavigate: () => void;
}) {
  const { environmentId } = props.environment;
  const roster = useAssistantRoster(environmentId, false);
  const connection = useAssistantConnection(environmentId);
  const query = props.query.trim().toLowerCase();
  const agents = (roster.data?.assistants ?? []).flatMap((agent) => {
    if (!agentPassesFilter(agent, props.filter)) return [];
    const chats = agentChats(props.threads, agent);
    if (query.length === 0 || agent.name.toLowerCase().includes(query)) return [{ agent, chats }];
    const matching = chats.filter((chat) =>
      agentChatTitle(chat.title).toLowerCase().includes(query),
    );
    return matching.length > 0 ? [{ agent, chats: matching }] : [];
  });
  return agents.map(({ agent, chats }) => (
    <SidebarAgent
      key={agent.assistantId}
      agent={agent}
      chats={chats}
      lastActivityAt={agentLastActivityAt(props.threads, agent)}
      environment={{ label: props.environment.label, machine: props.machine }}
      connected={connection.connected}
      expanded={query.length > 0 || !props.collapsed.includes(agentKey(agent))}
      onToggle={() => props.onToggleCollapsed(agentKey(agent))}
      onNavigate={props.onNavigate}
    />
  ));
}

/** The newest update across the agent's Home and its chats. */
function agentLastActivityAt(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  agent: AssistantSummary,
): string {
  let latest = agent.updatedAt;
  for (const thread of threads) {
    if (
      thread.environmentId === agent.environmentId &&
      thread.projectId === agent.binding.backingProjectId &&
      thread.updatedAt > latest
    ) {
      latest = thread.updatedAt;
    }
  }
  return latest;
}

function SidebarAgent(props: {
  readonly agent: AssistantSummary;
  readonly chats: ReadonlyArray<EnvironmentThreadShell>;
  readonly environment: { readonly label: string; readonly machine: EnvironmentMachineKind };
  readonly lastActivityAt: string;
  readonly connected: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const createChat = useCreateAgentChat(props.onNavigate);
  const [showAll, setShowAll] = useState(false);
  const { agent } = props;
  const home = assistantHomeTarget(agent.binding);
  const status = assistantStatus({ connected: props.connected, summary: agent });
  // Disabled and archived describe the agent, not its work, so they sit with the environment.
  const lifecycleNote =
    agent.lifecycle === "active"
      ? null
      : agent.lifecycle.charAt(0).toUpperCase() + agent.lifecycle.slice(1);
  // Idle is just "no work"; the time since the last activity says more.
  const workStatus = status.label !== "Idle" && status.label !== lifecycleNote;
  const ready = agent.provisioningState === "ready";
  const openThread = (threadId: ThreadId) => {
    props.onNavigate();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: home.environmentId, threadId },
    });
  };
  const chats = showAll ? props.chats : props.chats.slice(0, VISIBLE_CHATS);
  const hiddenChats = props.chats.length - chats.length;
  return (
    <div>
      <div className="relative">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                size="lg"
                isActive={pathname === `/${home.environmentId}/${home.threadId}`}
                onClick={() => {
                  // An agent still being set up has no chat yet; its page shows the progress.
                  if (!ready) {
                    props.onNavigate();
                    void navigate({
                      to: "/agents/$environmentId/$assistantId",
                      params: {
                        environmentId: agent.environmentId,
                        assistantId: agent.assistantId,
                      },
                      search: { section: "overview" },
                    });
                    return;
                  }
                  if (!props.expanded) props.onToggle();
                  openThread(home.threadId);
                }}
              >
                <AgentAvatar agent={agent} size="row" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
                    <span
                      className={cn(
                        "shrink-0 text-2xs tabular-nums",
                        status.tone === "info"
                          ? "text-info"
                          : status.tone === "warning"
                            ? "text-warning"
                            : status.tone === "danger"
                              ? "text-destructive"
                              : "text-sidebar-muted-foreground",
                      )}
                    >
                      {workStatus ? (
                        status.label
                      ) : (
                        <RelativeTimeLabel timestamp={props.lastActivityAt} />
                      )}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1 text-2xs text-sidebar-muted-foreground">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={props.environment.machine}
                      className="size-3 shrink-0"
                    />
                    <span className="min-w-0 truncate">
                      {[
                        props.environment.label,
                        lifecycleNote,
                        props.chats.length > 0
                          ? `${props.chats.length} ${props.chats.length === 1 ? "chat" : "chats"}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </span>
                {ready ? <span aria-hidden className="size-5 shrink-0" /> : null}
              </SidebarMenuButton>
            }
          />
          <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
            <ThreadHoverCard title={agent.name}>
              <div className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  kind={props.environment.machine}
                  className="size-3 shrink-0 stroke-muted-foreground"
                />
                <div className="min-w-0 truncate text-foreground/75">{props.environment.label}</div>
              </div>
              <div className="min-w-0 truncate">
                {status.label}
                {status.detail ? ` · ${status.detail}` : ""}
              </div>
              {ready ? (
                <div>
                  {props.chats.length === 0
                    ? "Home only"
                    : `Home and ${props.chats.length} ${props.chats.length === 1 ? "chat" : "chats"}`}
                </div>
              ) : null}
            </ThreadHoverCard>
          </ThreadHoverCardPopup>
        </Tooltip>
        {ready ? (
          <button
            type="button"
            aria-expanded={props.expanded}
            aria-label={props.expanded ? `Collapse ${agent.name}` : `Expand ${agent.name}`}
            className="absolute end-(--sidebar-row-content-inset) top-1/2 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
            onClick={props.onToggle}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", props.expanded && "rotate-90")}
            />
          </button>
        ) : null}
      </div>
      {props.expanded && ready ? (
        <SidebarMenuSub>
          {chats.map((chat) => (
            <SidebarMenuSubItem key={chat.id}>
              <SidebarMenuSubButton
                render={<button type="button" />}
                isActive={pathname === `/${chat.environmentId}/${chat.id}`}
                onClick={() => openThread(chat.id)}
              >
                <MessageSquareIcon />
                <span className="min-w-0 flex-1 truncate text-left">
                  {agentChatTitle(chat.title)}
                </span>
                {threadRuntimeIsActive(chat.runtime) ? (
                  <Spinner size="xs" tone="muted" aria-label="Working" />
                ) : chat.hasPendingApprovals || chat.hasPendingUserInput ? (
                  <span className="shrink-0 text-2xs text-warning">Needs you</span>
                ) : null}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
          {hiddenChats > 0 || showAll ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowAll(!showAll)}
              >
                <span>{showAll ? "Show fewer" : `Show ${hiddenChats} more`}</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              render={<button type="button" />}
              size="sm"
              className="text-muted-foreground"
              onClick={() => void createChat(agent)}
            >
              <PlusIcon />
              <span>New chat</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        </SidebarMenuSub>
      ) : null}
    </div>
  );
}

/** Filter, New agent and New chat, shown in the sidebar header while the Agents view is open. */
export function SidebarAgentsHeaderActions(props: {
  /** The header search field the filter popup lines up with, like the Projects filter. */
  readonly filterAnchor: RefObject<HTMLDivElement | null>;
  readonly filter: AgentSidebarFilter;
  readonly onFilterChange: (filter: AgentSidebarFilter) => void;
  readonly onNewAgent: () => void;
  readonly onNavigate: () => void;
}) {
  return (
    <>
      <AgentFilter
        anchor={props.filterAnchor}
        filter={props.filter}
        onFilterChange={props.onFilterChange}
      />
      <SidebarHeaderIconButton label="New agent" onClick={props.onNewAgent}>
        <BotMessageSquareIcon />
      </SidebarHeaderIconButton>
      <PickAgentNewChatButton onNavigate={props.onNavigate} />
    </>
  );
}

type AgentFilterItem =
  | { readonly value: "all"; readonly label: string; readonly kind: "all" }
  | {
      readonly value: string;
      readonly label: string;
      readonly kind: "agent";
      readonly agent: AssistantSummary;
    }
  | {
      readonly value: string;
      readonly label: string;
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly machine: EnvironmentMachineKind;
    };

/**
 * The same search popup as the Projects filter: select one row, or Shift-select to add
 * more. Environments join the list when more than one is connected.
 */
function AgentFilter(props: {
  readonly anchor: RefObject<HTMLDivElement | null>;
  readonly filter: AgentSidebarFilter;
  readonly onFilterChange: (filter: AgentSidebarFilter) => void;
}) {
  const { environments } = useEnvironments();
  const machines = useEnvironmentMachines();
  const agents = useAllAgents(environments.map((environment) => environment.environmentId));
  const comboboxFilter = useComboboxFilter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const highlighted = useRef<AgentFilterItem | null>(null);
  const { filter, onFilterChange } = props;
  const items: AgentFilterItem[] = [
    { value: "all", label: "All agents", kind: "all" },
    ...agents.map((agent) => ({
      value: `agent:${agentKey(agent)}`,
      label: agent.name,
      kind: "agent" as const,
      agent,
    })),
    ...(environments.length > 1
      ? environments.map((environment) => ({
          value: `environment:${environment.environmentId}`,
          label: environment.label,
          kind: "environment" as const,
          environmentId: environment.environmentId,
          machine: machines.get(environment.environmentId) ?? "server",
        }))
      : []),
  ];
  const filteredItems = items.filter((item) =>
    comboboxFilter.contains(item, query, (candidate) => candidate.label),
  );
  const isSelected = (item: AgentFilterItem) =>
    item.kind === "all"
      ? !agentFilterIsActive(filter)
      : item.kind === "agent"
        ? filter.agents.includes(agentKey(item.agent))
        : filter.environments.includes(item.environmentId);
  const only = (item: AgentFilterItem): AgentSidebarFilter =>
    item.kind === "all"
      ? NO_AGENT_FILTER
      : item.kind === "agent"
        ? { agents: [agentKey(item.agent)], environments: [] }
        : { agents: [], environments: [item.environmentId] };
  const toggle = (item: AgentFilterItem) => {
    if (item.kind === "all") onFilterChange(NO_AGENT_FILTER);
    else if (item.kind === "agent")
      onFilterChange(toggleAgentFilterValue(filter, "agents", agentKey(item.agent)));
    else onFilterChange(toggleAgentFilterValue(filter, "environments", item.environmentId));
  };
  const selectedAgents = agents.filter((agent) => filter.agents.includes(agentKey(agent)));
  const label = agentFilterIsActive(filter)
    ? `Filter agents: ${items
        .filter((item) => item.kind !== "all" && isSelected(item))
        .map((item) => item.label)
        .join(", ")}`
    : "Filter agents";
  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      onItemHighlighted={(item) => {
        highlighted.current = item ?? null;
      }}
      value={null}
      onValueChange={(item, eventDetails) => {
        if (!item) return;
        if (eventDetails.event instanceof MouseEvent && eventDetails.event.shiftKey) {
          // Canceling keeps the popup open and its query, so several rows can be picked.
          eventDetails.cancel();
          toggle(item);
          return;
        }
        onFilterChange(only(item));
      }}
    >
      <ComboboxTrigger render={<SidebarHeaderIconButton label={label} />}>
        {selectedAgents.length > 1 ? (
          <span className="flex shrink-0 -space-x-1.5">
            {selectedAgents.slice(0, 2).map((agent) => (
              <AgentAvatar key={agentKey(agent)} agent={agent} size="icon" />
            ))}
          </span>
        ) : selectedAgents[0] ? (
          <AgentAvatar agent={selectedAgents[0]} size="icon" />
        ) : filter.environments.length > 0 ? (
          <EnvironmentMachineIcon
            kind={machines.get(filter.environments[0] as EnvironmentId) ?? "server"}
            className="size-4"
          />
        ) : (
          <ListFilterIcon className="size-4" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        anchor={props.anchor}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <ComboboxSearchInput
          aria-label="Search agents"
          placeholder="Search agents..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.shiftKey && event.key === "Enter" && highlighted.current) {
              event.preventDefault();
              toggle(highlighted.current);
            }
          }}
        />
        <ComboboxEmpty>No matching agents.</ComboboxEmpty>
        <ComboboxList aria-multiselectable>
          {(item: AgentFilterItem) => (
            <ComboboxItem
              key={item.value}
              hideIndicator
              value={item}
              aria-selected={isSelected(item)}
              // The icon badge marks selection; Base UI's single value would shade one row.
              data-selected={undefined}
            >
              <SidebarScopeRowIcon isSelected={isSelected(item)}>
                {item.kind === "agent" ? (
                  <AgentAvatar agent={item.agent} size="icon" />
                ) : item.kind === "environment" ? (
                  <EnvironmentMachineIcon kind={item.machine} className="size-4 shrink-0" />
                ) : (
                  <BotIcon className="size-4 shrink-0" />
                )}
              </SidebarScopeRowIcon>
              <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
              {item.kind === "environment" ? (
                <span className="shrink-0 text-xs text-muted-foreground">Environment</span>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function PickAgentNewChatButton(props: { readonly onNavigate: () => void }) {
  return (
    <SidebarHeaderIconButton
      label="New chat"
      onClick={() => {
        props.onNavigate();
        openCommandPalette({ open: "new-agent-chat" });
      }}
    >
      <SquarePenIcon />
    </SidebarHeaderIconButton>
  );
}
