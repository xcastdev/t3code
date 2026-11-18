import type { MenuAction } from "@react-native-menu/menu";

export const COMPOSE_NEW_CHAT = "new-chat";
export const COMPOSE_NEW_AGENT = "new-agent";
const AGENT_PREFIX = "agent:";

interface ComposeMenuAgent {
  readonly environmentId: string;
  readonly assistantId: string;
  readonly name: string;
}

const agentActionId = (agent: ComposeMenuAgent) =>
  `${AGENT_PREFIX}${agent.environmentId}:${agent.assistantId}`;

/**
 * The compose button's long-press menu. `agents` arrive pinned first: one agent is offered
 * directly, several as a submenu, and none as a way to create one.
 */
export function composeMenuActions(agents: ReadonlyArray<ComposeMenuAgent>): MenuAction[] {
  const newChat = { id: COMPOSE_NEW_CHAT, title: "New chat", image: "square.and.pencil" };
  const [only] = agents;
  if (only === undefined)
    return [newChat, { id: COMPOSE_NEW_AGENT, title: "New agent", image: "plus" }];
  if (agents.length === 1)
    return [
      newChat,
      { id: agentActionId(only), title: "New agent chat", subtitle: only.name, image: "robot" },
    ];
  return [
    newChat,
    {
      title: "New agent chat",
      image: "robot",
      subactions: agents.map((agent) => ({ id: agentActionId(agent), title: agent.name })),
    },
  ];
}

/** The agent a compose menu selection names, if it names one. */
export function composeMenuAgent<Agent extends ComposeMenuAgent>(
  agents: ReadonlyArray<Agent>,
  id: string,
): Agent | undefined {
  return id.startsWith(AGENT_PREFIX)
    ? agents.find((agent) => agentActionId(agent) === id)
    : undefined;
}
