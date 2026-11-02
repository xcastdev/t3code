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
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { AgentAvatar } from "../assistants/AgentAvatar";
import * as Schema from "effect/Schema";
import {
  BotMessageSquareIcon,
  ChevronRightIcon,
  ListFilterIcon,
  MessageSquareIcon,
  PlusIcon,
  SquarePenIcon,
} from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn, newThreadId } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import {
  useEnvironmentMachines,
  useEnvironments,
  type EnvironmentPresentation,
} from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { useAssistantConnection, useAssistantRoster } from "../assistants/useAssistants";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
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
  agentOwningThread,
  agentPassesFilter,
  environmentsWithAgents,
  toggleAgentFilterValue,
} from "./SidebarAgentsList.logic";
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

/** Starts a chat under an agent's home, with the agent's model and modes, and opens it. */
function useCreateAgentChat(onNavigate: () => void) {
  const navigate = useNavigate();
  const threads = useQuietThreadShells();
  const createThread = useOrchestrationCommand(threadEnvironment.create, {
    label: "start a chat",
  });
  return async (agent: AssistantSummary) => {
    const { environmentId } = agent;
    const home = threads.find(
      (thread) =>
        thread.environmentId === environmentId && thread.id === agent.binding.canonicalThreadId,
    );
    if (home === undefined) return;
    const threadId = newThreadId();
    const result = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: agent.binding.backingProjectId,
        title: "New thread",
        modelSelection: home.modelSelection,
        runtimeMode: home.runtimeMode,
        interactionMode: home.interactionMode,
        branch: home.branch,
        worktreePath: home.worktreePath,
        parentThreadId: home.id,
        createdAt: new Date().toISOString(),
      },
    });
    if (result._tag === "Failure") return;
    onNavigate();
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
}

/** Filter, New chat and New agent, shown in the sidebar header while the Agents view is open. */
export function SidebarAgentsHeaderActions(props: {
  readonly filter: AgentSidebarFilter;
  readonly onFilterChange: (filter: AgentSidebarFilter) => void;
  readonly onNewAgent: () => void;
  readonly onNavigate: () => void;
}) {
  const { environments } = useEnvironments();
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton
              size="icon"
              type="button"
              aria-label="Filter agents"
              className="relative size-7 shrink-0"
            />
          }
        >
          <ListFilterIcon />
          {agentFilterIsActive(props.filter) ? (
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          ) : null}
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-48">
          <MenuGroup>
            <MenuGroupLabel>Agents</MenuGroupLabel>
            {environments.map((environment) => (
              <AgentFilterItems
                key={environment.environmentId}
                environment={environment}
                showEnvironment={environments.length > 1}
                filter={props.filter}
                onFilterChange={props.onFilterChange}
              />
            ))}
          </MenuGroup>
          {environments.length > 1 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Environments</MenuGroupLabel>
                {environments.map((environment) => (
                  <MenuCheckboxItem
                    key={environment.environmentId}
                    checked={props.filter.environments.includes(environment.environmentId)}
                    onCheckedChange={() =>
                      props.onFilterChange(
                        toggleAgentFilterValue(
                          props.filter,
                          "environments",
                          environment.environmentId,
                        ),
                      )
                    }
                  >
                    {environment.label}
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            </>
          ) : null}
          {agentFilterIsActive(props.filter) ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => props.onFilterChange({ agents: [], environments: [] })}>
                Show all agents
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <NewChatButton onNavigate={props.onNavigate} />
      <SidebarHeaderIconButton label="New agent" onClick={props.onNewAgent}>
        <BotMessageSquareIcon />
      </SidebarHeaderIconButton>
    </>
  );
}

function AgentFilterItems(props: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironment: boolean;
  readonly filter: AgentSidebarFilter;
  readonly onFilterChange: (filter: AgentSidebarFilter) => void;
}) {
  const roster = useAssistantRoster(props.environment.environmentId, false);
  return (roster.data?.assistants ?? []).map((agent) => (
    <MenuCheckboxItem
      key={agent.assistantId}
      checked={props.filter.agents.includes(agentKey(agent))}
      onCheckedChange={() =>
        props.onFilterChange(toggleAgentFilterValue(props.filter, "agents", agentKey(agent)))
      }
    >
      <AgentAvatar agent={agent} size="icon" />
      <span className="min-w-0 truncate">{agent.name}</span>
      {props.showEnvironment ? (
        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
          {props.environment.label}
        </span>
      ) : null}
    </MenuCheckboxItem>
  ));
}

/**
 * Starts a chat with the agent you're in. Anywhere else it asks which agent, since every
 * chat belongs to one.
 */
function NewChatButton(props: { readonly onNavigate: () => void }) {
  const params = useParams({ strict: false }) as {
    readonly environmentId?: EnvironmentId;
    readonly threadId?: ThreadId;
  };
  return params.environmentId !== undefined && params.threadId !== undefined ? (
    <RouteNewChatButton
      environmentId={params.environmentId}
      threadId={params.threadId}
      onNavigate={props.onNavigate}
    />
  ) : (
    <PickAgentNewChatButton onNavigate={props.onNavigate} />
  );
}

function RouteNewChatButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onNavigate: () => void;
}) {
  const roster = useAssistantRoster(props.environmentId, false);
  const thread =
    useQuietThreadShells().find(
      (shell) => shell.environmentId === props.environmentId && shell.id === props.threadId,
    ) ?? null;
  const agent = agentOwningThread(roster.data?.assistants ?? [], thread);
  const createChat = useCreateAgentChat(props.onNavigate);
  if (agent === null) return <PickAgentNewChatButton onNavigate={props.onNavigate} />;
  return (
    <SidebarHeaderIconButton
      label={`New chat with ${agent.name}`}
      onClick={() => void createChat(agent)}
    >
      <SquarePenIcon />
    </SidebarHeaderIconButton>
  );
}

function PickAgentNewChatButton(props: { readonly onNavigate: () => void }) {
  const { environments } = useEnvironments();
  const createChat = useCreateAgentChat(props.onNavigate);
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label="New chat"
            className="relative size-7 shrink-0"
          />
        }
      >
        <SquarePenIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-48">
        <MenuGroup>
          <MenuGroupLabel>New chat with</MenuGroupLabel>
          {environments.map((environment) => (
            <AgentChatItems
              key={environment.environmentId}
              environmentId={environment.environmentId}
              onPick={(agent) => void createChat(agent)}
            />
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function AgentChatItems(props: {
  readonly environmentId: EnvironmentId;
  readonly onPick: (agent: AssistantSummary) => void;
}) {
  const roster = useAssistantRoster(props.environmentId, false);
  return (roster.data?.assistants ?? [])
    .filter((agent) => agent.provisioningState === "ready")
    .map((agent) => (
      <MenuItem key={agent.assistantId} onClick={() => props.onPick(agent)}>
        <AgentAvatar agent={agent} size="icon" />
        {agent.name}
      </MenuItem>
    ));
}
