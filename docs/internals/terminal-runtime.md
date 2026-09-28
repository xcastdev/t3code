# Terminal runtime

The environment server owns PTYs, session lifetime, and retained output. Every
client, including the desktop renderer, attaches through the environment connection.
This lets clients reconnect or share a running session. Renderer choices stay local
to each client and do not change terminal contracts.

Dock terminals belong to a thread; toolkit terminals belong to a project. Keep the
owner kind explicit in lookup, history, and cleanup because a project ID and thread
ID can have the same value. Thread archive or deletion closes only that thread's
dock terminals. Project deletion closes its toolkit terminals, while deleting any
thread leaves them available to the project.

## Output and retention

[Terminal history](../../apps/server/src/terminal/History.ts) is incremental.
PTY callbacks append new chunks; live events carry only those chunks. Materializing
or copying full scrollback on every callback makes output cost grow with retained
history, so snapshots and coalesced persistence are the materialization boundaries.
Persistence queues the mutable history buffer and reads its latest value when the
write runs. Clear, restart, and close must drain writes before completing their
lifecycle boundary.

Server history is capped at 5,000 lines and 8 MiB of UTF-8 text per terminal, so a
long unterminated line cannot bypass retention. Eviction removes the oldest output
without splitting Unicode code points; live output is not truncated. Release
discarded chunk references immediately, even if array compaction happens later.
Client buffers have a separate 512 KiB cap. Measure throughput with full scrollback
when changing this path.

Toolkit readers hold independent cursors; a read cannot advance another reader's
position. Read and search only bounded slices of retained chunks instead of
materializing full history for each request. If retention passes a reader's cursor,
resume from the oldest retained output and report that earlier output was lost.

Restoration must read only the bounded tail of current or legacy history files,
skip any incomplete UTF-8 prefix, and apply the line limit. Close the read handle
before rewriting the capped file. Reading whole old logs would defeat the memory
bound during startup.

## Renderer ownership

Android and web use the same `libghostty-vt` C ABI for terminal behavior. Platform
adapters own drawing and input integration, and React stays out of terminal frames.
The web adapter shares one WebAssembly instance per browser tab while each terminal
owns and frees its own handles. The canonical upstream pin is
[`native/libghostty-vt/VERSION`](../../native/libghostty-vt/VERSION); both native and
web artifacts must be rebuilt when it changes. Web embeds the revision in its build
info so the ABI check can detect drift without a second pin.

Restoring scrollback must not send terminal replies to the current shell. Historical
device queries can otherwise provoke fresh replies that appear as junk at the
prompt. The server strips query/response traffic from retained history, and the
[web renderer](../../apps/web/src/terminal/ghostty/core.ts) detaches its PTY writer
during replay. Preserve both protections when changing retention or renderer code.
