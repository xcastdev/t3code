# Chat timeline

The chat timeline shows what the agent did, what ran it, and what it is doing right now.

## Following the response

When you send a message, the timeline stays with the newest line and follows the response as it
arrives. Scroll up at any point — with the wheel, a touch gesture, the scrollbar, or Page Up, Home,
or the arrow keys — and the timeline stops following so you can read. Scroll back to the end, or
use the scroll-to-bottom control, and it follows again.

## What a finished turn reports

Once a turn finishes, its intermediate work collapses behind a single summary row:

```
Worked for 1m 12s · 5 Commands · 7 Tool Calls · 2 Subagents · 3 Changed Files +42/−11
```

A turn you stopped reports the same breakdown after `You stopped after`. Segments only appear when
there is something to report, so a turn that just answered a question shows the duration alone.

Line counts (`+42/−11`) appear when the turn's changes were captured successfully. If they were
not, the file count still appears without the line counts, rather than showing numbers that might
be wrong.

Turns from before this feature shipped show the duration by itself. Their work was never recorded,
and T3 Code shows nothing rather than an undercount.

Expand a summary to see the work itself.

## What ran the turn

A finished response shows the model that produced it, along with the reasoning effort,
duration, and time:

```
Claude Opus 4.5 · high · 1m 12s · 2:47 PM
```

The model is recorded per turn, so switching models partway through a conversation does not
relabel earlier responses. Reasoning effort appears only for models that have the concept, and
always as the level actually used. In a narrow pane the row shortens to icons.

## Tool rows

Each piece of work is a row with its name, what it acted on, and how long it took:

```
Shell Command   git status --short && git log --oneline -5        0.1s
Read File       /tmp/opencode/xcastdev-opencode/package.json
```

Commands are styled distinctly from other tool calls. When space is tight the description shortens
first, so the name and duration stay readable.

## While the agent is working

The working row names what is happening — running a command, reading a file — rather than a
generic label, and holds each description long enough to read instead of flickering between
states.
