# Assistants

Open **Agents** in the sidebar to see each assistant with its chats. Select an assistant's name to
open its **Home**, the long-lived conversation that always returns to the same one; use the arrow
beside it to show or hide its chats without leaving the current one. Start a
separate chat for a topic you want to keep apart, with **New chat** under the assistant, in the
sidebar header, or with **New chat with agent…** in the command palette; outside an assistant's
conversation, it asks which assistant. A chat starts with a clean conversation but works as the same assistant, with its
project, settings and memory. Use the filter in the sidebar header to show only some assistants, or
only one environment's. Use **Stop** in a conversation to stop its active work.
From the assistant's Home, open its agent page to change its setup.

Create one with **New agent** in the Agents sidebar header. It walks through three steps: a face or
initials and a name, then the model and how much it may do without asking, then optional
personality, rules and a standing prompt.

## Memory

With automatic memory enabled, an assistant can retain useful details from its Home and its chats,
and every chat can use what it learned.
Memory stays private unless you explicitly share it. Review an item in the assistant's memory, edit it
to correct it, or forget it to keep it out of future T3-managed recall and context. Forgetting does
not remove the source messages from chat history or retract context already sent to a provider.
Built-in memory processing keeps recall on the environment by default, and external extraction or
indexing remains off until enabled.

## Routines

Create a routine with a prompt and schedule, then enable it when you want it to run. Each new
routine runs in its own chat under the assistant, named after the routine, so its runs stay out of
Home. Routines created before this keep running in Home. You can change
its schedule, disable or delete it, or run it now. Check its time zone and next run, then use the
routine's activity for its actual status; a recorded attempt or dispatch does not mean the work
completed.

## Disable, archive and restore

Disable or archive an assistant to stop new work and suspend its queued routines. Active work does
not stop automatically; use **Stop** in the assistant's conversation if needed. Archiving keeps the
assistant's conversation and workspace so you can restore it later. Restoring reactivates the
assistant but leaves its routines disabled; enable only the routines you want to run.

Recovering saved history returns context to the assistant's main conversation. Assistant history
does not offer forks or file restoration.

For MCP servers, skills, commands and snippets, see [Skills, commands and MCP servers](./agent-resources.md).
