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
set apart from tool calls. Thoughts in a row share one block, with a line between each. Set
**Thoughts** to **Collapsed** to show each run of thoughts as one line with its first sentence, such as
**Thought (×3)**; select the line to read them in full.

Turn on **Pin your last message** to keep the last message you sent at the top of the conversation
once it scrolls out of view. Select it to jump back to it.

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

## Hide tool calls

**Tool calls in chat** in **Settings → Chat** (web and desktop) or **Settings → Appearance**
(mobile) hides commands, file edits, searches, and MCP tool calls
from the conversation. **Hide successful** shows a call while it runs and keeps
it only if it fails. **Hide all** hides every call and shows **Thinking** while the agent works.
**Zen** also hides the agent's in-between messages, so each turn shows your message
and the agent's last reply, which appears when the turn ends. If you steer while the agent is
answering, the answer it finished before reading your steer stays too. On web and desktop, Find
shows the in-between messages while it is open. Approvals, questions, and errors always show. The
setting applies to this browser or device only.

## Screen reader announcements

On web and desktop, a screen reader hears the open thread's turn as it runs. **Screen reader
announcements** in **Settings → Chat** sets how much. **Status only** says when a turn starts,
needs your approval or input, and ends. **Status and messages** also reads each message the agent
writes and then keeps working after, once that message is complete. A very long message is cut
short. The reply that closes the turn is not read, so you can read it yourself when you hear
**Done**. **Everything** adds the step the agent is on, such as the command it is running. Steps
are spaced out, so a quick step can be skipped for a newer one.
The agent's reasoning text is never read. The setting follows the agent's real activity, whatever
**Tool calls in chat** hides, and applies to this browser or device only.

To hear the open thread and what it's doing when you switch to T3 Code, turn on **Screen reader
window title** in the same section. The window title then starts with the thread's status
(**Working**, **Needs approval**, or **Needs your input**) and its name, then the project, so a
screen reader says them first. When the turn ends, only the status goes away.
Anyone who can see your taskbar, window switcher, or shared screen sees it too, and time trackers
that group by window title count each status separately.
