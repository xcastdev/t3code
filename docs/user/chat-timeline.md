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

If a turn's retained activity is incomplete, T3 Code keeps any counts recorded when the turn
finished. Otherwise it shows the duration by itself rather than an undercount.

Expand a summary to see the work itself.

## What ran the turn

On web and desktop, a finished response shows the recorded model and reasoning effort when they
are available, along with the duration and time:

```
Claude Opus 4.5 · high · 1m 12s · 2:47 PM
```

Switching models later does not relabel an earlier response. Providers that do not report model or
effort leave those details out. In a narrow pane the row shortens to icons.

## Tool rows

Each piece of work has a name, a short description, and its duration when timing is available.
Commands are styled distinctly from other tool calls. When space is tight, the description
shortens first.

## While the agent is working

The working row names what is happening — running a command, reading a file — rather than a
generic label, and holds each description long enough to read instead of flickering between
states.
