# Project Work

Work keeps durable tasks, scope, plans, approvals, assignments, evidence, knowledge and decisions
for one project checkout. Approving a scope or plan records your decision; it never starts a
worker.

On web and desktop, choose **Open Work** in the command palette or use the configured Work shortcut
when the terminal is not focused. **Settings → General → Projects & threads** also opens Work when
its scope selects one project checkout. On mobile, open the **Work** tab, **Settings → Work**, or
**Open Work** from a project's overview. Work shows the environment and checkout path it acts on, so
two checkouts of the same project stay distinct.

Long lists show one page at a time; use **Next** and **Previous** to reach older entries.

## Tasks and approvals

Create a **Guided** task to record a scope and a plan, each approved separately, or a **Simple**
task with a scope, acceptance criteria and one approval. Each approval names the exact revision
and content it covers. If the scope or plan changes while you are confirming, Work asks you to
review the current revision instead of approving the old one. Changing the scope or plan voids the
earlier approval, and the task shows that it needs approval again. You can revoke a recorded
decision, waive a criterion with a reason, and revoke a waiver.

**Protect** a scope to stop ordinary edits. A protected scope changes only through **Revise
protected scope**, where you review the complete new revision and approve it as a whole.
Protection can't be removed.

Link tasks under **Related tasks** (depends on, blocks, duplicates and so on), and list a plan's
dependencies. Linked tasks open from the task. Record evidence as your own observation, optionally
about one criterion; evidence doesn't mark a criterion met by itself.

Pause, defer, cancel, resume, reopen and reassign are recorded on the task with your reason.
Reassigning names the team member who should take over and pauses the task.

In **Workers**, propose a worker assignment. When the assignment and required scope and plan are
approved, choose **Start worker** and confirm the team member. Approval never starts the worker by
itself. Workers can ask questions, send messages or block on a task; answer questions and resolve
messages from the task or the overview.

The overview's **Team activity** summarizes open, running, in-review and blocked work. **Inbox**
shows messages from workers, and **Needs attention** links to tasks waiting on you.

If a task changes while you are editing it, your text is kept and Work asks you to review the
current revision before sending.

## Team

**Overview → Team** sets up the project's team: a provider, a model, memory access and
instructions for each of the six roles, and the limits each model runs under. You can edit it, or
disable and enable it again. Saving only records the configuration; no worker starts.

## Review and delivery

**Review and checks** on a task records verification results and review findings against the scope,
plan and code revision they cover. A later change can make an earlier result stale. Add your own
observations under **Evidence**. When work is ready to integrate, **Integration and delivery** lets
you choose reviewed task changes, prepare a pull request, and publish it after approval. Merging is
a separate prepared and approved step.

## Knowledge and decisions

Add knowledge people should keep in mind for the project, and revise it later. A revision
replaces the entry it came from; the earlier version stays as history, marked replaced, and only
the current version can be revised again. Proposed decisions stay proposed until someone accepts
or rejects them; an accepted decision can be superseded by a new proposal.

## All projects

Choose **All projects** to see team work across connected environments. Open a project to return
to its Work overview.

## GitHub issue intake

In **Intake**, choose **Bind repository**. Work asks the server which GitHub repository the
checkout's remote points to and which account is signed in there, and binds only after you
confirm. Then choose **Sync one page** to copy in issues. Nothing syncs in the background. Issue
text is shown as a proposal; refine an issue into a new task, a mission, or an existing task after
reviewing it. Detaching stops syncing and keeps issues already copied; **Bind again** resumes it.
