# Skills, commands and MCP servers

**Settings → Resources** manages what agents can use on one environment: MCP servers, skills,
and your own commands and snippets. Choose the environment and, optionally, a project checkout
with the scope above the page. Environment-wide entries apply to every project; a project can
override or turn off an entry for itself without changing it elsewhere. When a project has
several checkouts on one environment, choose the checkout first; each keeps its own resources.
To change a single thread, choose **Skills, commands and MCP** from the thread's menu in the
sidebar or the command palette. On mobile, open **Settings → Skills and commands**, the
project's overview, or **Skills and commands** in a thread's menu.

**Overview** lists everything that applies to the selected scope from all three catalogs. Each
entry is still edited in its own section.

## MCP servers

Add a server with its URL or local command and assign it to the providers that should receive
it. A server assigned to no provider reaches no session. Type a secret header or environment
variable into its masked field; it is sent privately once when you save and is never shown
again. A stored secret stays as it is until you replace it. A project or thread can override any
field of an inherited server, including its name and connection. Fields you leave alone keep
following the server, and **Follow definition** puts a changed one back. A replaced connection
needs its secrets entered again. OAuth servers sign in per project with **Sign in**, then **Continue** after
you finish in the browser. The status shows whether a sign-in is saved, not whether the server is
reachable right now.

A thread's MCP servers belong to its agent session. Until the agent has run, the thread has no
session and shows its project's servers. Once it has one, the thread view shows what the session
wants, what its provider confirmed, and whether it needs a restart, and **Use project servers
again** drops the thread's own changes. Saving changes what sessions should receive; each session
applies it on its next delivery, and some providers need a restart. MCP servers are edited on web
and desktop.

## Skills

Managed skills are instructions T3 Code delivers to providers that support them. **History**
restores an earlier revision as a new one. **Install to provider** copies a revision into a
provider's own skills folder and never overwrites a copy someone edited there. **Installed
copies** lists those folders, so you can remove a copy whose skill was renamed or deleted. In a
thread, turning a skill off or on changes only that thread; **Follow project and environment**
undoes it. Choosing a managed skill after `$` in the composer adds its instructions to your
message, labeled with where they came from. Skills a provider finds on its own are listed with
their provider; you can view them and import one as a managed skill. When a managed skill and a provider skill share a name, both stay listed with their source.

## Commands and snippets

In the composer, type `/` to find them. Choosing a command replaces it with its text, and
`$ARGUMENTS` becomes whatever follows the command on that line; choosing a snippet inserts its
text. The result is ordinary draft text you can edit before sending. If the command changed
while it loaded, or you moved on by typing, moving the cursor, selecting text, switching provider
or pressing Escape, nothing is inserted. A managed command with the same name as a provider command is labeled, so you pick
which one you mean. A thread's setting for a command or snippet that was later removed stays
listed for that thread, so you can reset it before the name is reused.

If something changes elsewhere while you edit a skill, command or snippet, your text stays in
the editor and saving is paused until you reload the current version.
