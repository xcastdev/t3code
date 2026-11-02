import { assistantStatus } from "@t3tools/client-runtime/assistant-presentation";
import { assistantHomeTarget } from "@t3tools/client-runtime/state/assistants";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { AssistantSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
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
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { useAssistantConnection, useAssistantRoster } from "../assistants/useAssistants";
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

const VISIBLE_CHATS = 5;
const COLLAPSED_AGENTS_KEY = "t3code:sidebar:collapsed-agents";
const CollapsedAgents = Schema.Array(Schema.String);

/** The sidebar's Agents view: each agent's home and its chats, across environments. */
export function SidebarAgentsList(props: {
  readonly query: string;
  readonly filter: AgentSidebarFilter;
  readonly onNavigate: () => void;
}) {
  const { environments, isReady } = useEnvironments();
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
  return (
    <SidebarGroup className="flex-1" role="presentation">
      {environments.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs text-muted-foreground">
          {isReady ? "Connect an environment to use agents." : "Loading agents…"}
        </p>
      ) : (
        shown.map((environment) => (
          <EnvironmentAgents
            key={environment.environmentId}
            environment={environment}
            showEnvironment={environments.length > 1}
            threads={threads}
            query={props.query}
            filter={props.filter}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onNavigate={props.onNavigate}
          />
        ))
      )}
    </SidebarGroup>
  );
}

function EnvironmentAgents(props: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironment: boolean;
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
  return (
    <div className="flex flex-col gap-px pb-2">
      {props.showEnvironment ? (
        <p className="px-2 pt-1 pb-0.5 text-2xs font-medium text-muted-foreground">
          {props.environment.label}
        </p>
      ) : null}
      {roster.data === null ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {roster.error ? "Couldn't load agents." : "Loading agents…"}
        </p>
      ) : agents.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {query.length > 0 || agentFilterIsActive(props.filter)
            ? "No matching agents."
            : "No agents yet."}
        </p>
      ) : (
        agents.map(({ agent, chats }) => (
          <SidebarAgent
            key={agent.assistantId}
            agent={agent}
            chats={chats}
            connected={connection.connected}
            expanded={query.length > 0 || !props.collapsed.includes(agentKey(agent))}
            onToggle={() => props.onToggleCollapsed(agentKey(agent))}
            onNavigate={props.onNavigate}
          />
        ))
      )}
    </div>
  );
}

function SidebarAgent(props: {
  readonly agent: AssistantSummary;
  readonly chats: ReadonlyArray<EnvironmentThreadShell>;
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
    <div className="relative">
      <SidebarMenuButton
        isActive={pathname === `/${home.environmentId}/${home.threadId}`}
        onClick={() => {
          // An agent still being set up has no chat yet; its page shows the progress.
          if (!ready) {
            props.onNavigate();
            void navigate({
              to: "/agents/$environmentId/$assistantId",
              params: { environmentId: agent.environmentId, assistantId: agent.assistantId },
              search: { section: "overview" },
            });
            return;
          }
          if (!props.expanded) props.onToggle();
          openThread(home.threadId);
        }}
      >
        <AgentAvatar agent={agent} size="icon" />
        <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
        {status.tone === "neutral" || status.tone === "success" ? (
          <span className="sr-only">{status.label}</span>
        ) : (
          <span
            className={cn(
              "shrink-0 text-2xs",
              status.tone === "info"
                ? "text-info"
                : status.tone === "warning"
                  ? "text-warning"
                  : "text-destructive",
            )}
          >
            {status.label}
          </span>
        )}
        {ready ? <span aria-hidden className="size-5 shrink-0" /> : null}
      </SidebarMenuButton>
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
