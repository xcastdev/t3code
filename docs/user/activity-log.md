# Activity log

On web and desktop, consecutive tool calls appear as an expandable summary. Open it to inspect
commands, tool inputs, status, and exit codes. Expand a tool call to see its input and output as two
panes of one card, each scrolling on its own. Commands read like a terminal, a file read shows the
file's full path and its contents highlighted for the file type, and an edit shows the file and its
diff. A running command's output updates live, and long output shows only its most recent part. Use
**Open diff** on a file change to review its contents.

## While a turn runs

**Settings → Chat → Turn activity** controls how much of the agent's work you see as it happens:

- **Latest steps** (default) shows the last 7 tool calls and thoughts. Earlier ones fold into a row
  you can open.
- **Scrolling box** shows the current batch of tool calls in a short box that scrolls.
- **Every step** shows each tool call and thought as its own row.

With **Latest steps** and **Every step**, thoughts appear in full as they stream, in a shaded block
set apart from tool calls. Thoughts in a row share one block, with a line between each.

## When a turn ends

By default a finished turn folds its steps under one line that reports how long it worked, how many
steps it took, the files it changed, and anything that needs a look: failed steps, an unfinished
checklist, or background work still running. Select the file count to open the turn's diff. Replies,
pages the agent rendered, and plans stay in view. Choose **Keep every step** under **When a turn ends**
to leave finished turns unfolded.

T3 Orchestrator summaries describe the actions taken, such as **Ran 2 commands and sent messages
to 3 threads**. Repeated messages to the same destinations show both counts: **Sent 5 messages to
2 threads**. Thread creation counts the threads returned by the tool, including batches.

Groups with many kinds of activity show up to two specific action categories and a count of the
remaining actions. Commands, file changes, and orchestration changes take priority over reads and
status checks. Expand the group for the full list.

Failed calls do not count as successful messages or creations. Waiting on a thread does not mean
it finished, and an interrupt or cancellation request does not mean the thread stopped. When tool
details are unavailable, summaries use a broader description instead of guessing how many threads
were affected.
