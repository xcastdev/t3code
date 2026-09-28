# Agent terminals

Agents can use the terminal toolkit to start and share processes in a project.
`terminal_spawn` starts a command with its arguments, or an interactive shell when
no command is given. The project workspace is the default working directory; an
agent can choose a worktree by passing its path. Removing that worktree outside
T3 Code does not preserve its files for the running terminal.

Use `terminal_list` to find project terminals, `terminal_read` to inspect output,
`terminal_write` to send input, and `terminal_resize` to change dimensions.
Writes send exactly the supplied text, so include a newline when the shell should
run a command. All agents in the project share control of a terminal and can send
conflicting input.

Terminals belong to the project, not the thread that created them. They remain
available when an agent exits or a thread is archived or deleted, and another
agent in the project can continue using them. Project deletion and environment
server shutdown end the processes; terminals are not restored after a server
restart. Agent tools can access toolkit terminals only. Human-created terminals
in the dock are not shared with agents yet.

`terminal_read` can return recent output, continue from an output cursor, or search
for literal text. Reads and searches are bounded, and a search does not support
regular expressions. A cursor lets one reader continue independently of another;
if older output has been discarded, the read reports that some output was lost.
A read can wait briefly for output or process exit, but it does not send a later
completion notification. Output is terminal text, not a rendered screen.

`terminal_kill` asks a process to stop and keeps its final output and exit details
so another agent can inspect them. Pass `cleanup: true` to remove the stopped
terminal and its saved history. Ended terminal history can also be evicted when
T3 reaches its retention limit.

# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.
