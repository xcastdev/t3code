# Project Work

Use Work to keep tasks, approved scope, worker history, questions, and evidence together for a
project. Select the environment and checkout you intend to supervise; another checkout keeps its
own team and limits.

## Open Work and configure a team

1. In **Settings → General**, enable **Project Work** for the selected environment.
2. Open **Work** from the sidebar or choose **Open Work** in the command palette. Settings also
   offers **Open Work** when a project is selected.
3. To configure a team, select the project in Settings and open **Project → Project team**. If
   several checkouts are listed, choose **Team checkout** explicitly.
4. Choose **Set up team** or **Edit configuration**. Select an available Pi provider and models,
   review the role instructions and work limits, then save. Use **Enable team** to control whether
   that team is enabled.

If the provider or model catalogue is unavailable, configure the provider before saving. Existing
team work must stop and drain before its configuration can change. Enabling Project Work or a
team does not itself start a worker. See [project settings](project-settings.md) for environment
selection and project overrides.

## Turn an issue into an approved task

Open **Tasks**. For a recorded GitHub issue, choose **Refine issue** to create a task or mission,
or link an existing task. Review the title and description before saving. A linked task offers
**Start investigation**. You can also choose **New task** without an issue.

Open the task to inspect its internal findings. Use **Propose a revised specification** to set
the objective, included and excluded scope, and acceptance criteria. Then use **Propose a plan**
to describe the implementation and validation work.

For integration work, use the web or desktop plan editor to load reviewed sources. Select the
exact task branches and commits, then arrange them in the order to combine. Propose the plan and
review its retained source list before approving it. Changed sources require a replacement list
and approval. Mobile can inspect and approve an existing list.

In **Approvals and execution**, review and approve the current specification and plan, or reject
them. Approval applies to the displayed revision. Proposing a revised specification resets
criterion satisfaction and invalidates the previous scope's approvals and execution permission.

For an explicit human exception, open the task's specification, select a criterion, and give a
waiver reason. You can reference retained evidence from its current scope. A waiver changes the
approved specification: current work stops and approvals must be renewed. Use **Revoke selected
waiver** to return that criterion to unsatisfied; other waivers remain recorded. Canceling the
draft sends nothing. Protected specifications require the approved revision process, and terminal
tasks must be reopened first. These controls are available on web, desktop and mobile.

Choose **Start execution** only after reviewing those approvals. The server can still reject the
request because ownership, prior workers, dependencies, or execution availability prevent it.
An accepted request records permission; check recorded worker activity to see what actually ran.

## Follow work and handle questions

Use **Team** or **Supervision** to inspect activity. A task's **Recorded workers** lists role,
model, status, worktree, branch, and the specification and plan revisions used. Open a recorded
worker's thread to inspect its conversation. Settled workers remain in the history.

On mobile, open the project's Work screen and select a task to inspect its workers and controls.
Use **Show evidence** or **Show supervision** to inspect the corresponding project records.

Open **Inbox** for questions and task attention. Answer a question after reviewing its linked
task and current request. **Mark task attention seen** records acknowledgment; it does not resolve
the task or answer a question. Seen notices remain visible until resolved.

Use **Task controls** with a reason to pause, defer, cancel, or resume eligible work. For
reassignment, select a current active recipient and review the choice. Reassignment requests a
successor and pauses owned work. **Resume** is separate and rechecks ownership, stopped workers,
and approvals; a requested successor is not a launched worker.

## Review verification and findings

For an eligible completed assignment, the task's **Verification** section lets you select the
assignment, enter an absolute executable and literal argument array, and choose criterion
coverage and limits. Propose verification, then **Load verification preview**. Review its target,
revisions, command, limits, and verification type before approving or rejecting it. Approval
alone does not confirm execution or passing tests.

Open **Evidence** to inspect recorded verification applicability and review findings. Findings
show severity, open or resolved status, affected parent criteria, original reviewer, latest
reporter, frozen target, and resolution artifact references. A recorded resolution does not by
itself establish current approval. **Combined source integration verification** identifies the
approved source selection and its recorded combination. Its tested commit must contain every
selected commit. **Integration verification** without that coverage describes only the
integrator's tested assignment.

To publish reviewed team work, open Source Control for its recorded branch. On mobile, open
the thread’s Git overview.
Push the exact reviewed commit, then choose **Create PR**. The branch must be clean,
with current verification and an accepted independent review. Changed scope, revoked approvals,
or a different remote commit require attention before publication can proceed.

PR creation retains your decision before contacting GitHub. If the result is uncertain, inspect
the task's delivery status before retrying. A confirmed PR is linked to its thread. If the branch
or selected work changes while confirming, reopen the action and review its current source.

To merge a published team PR, choose **Merge** and review its method. This approves the original
reviewed commit and target branch. Current verification, review and work approvals are required;
a changed remote head or base must be reviewed before merging. Automatic and stacked merges
are unavailable for managed work. A confirmed immediate merge retains delivery evidence. An
uncertain write is checked without sending another merge; an external merge does not establish
that T3 completed it. Inspect an uncertain outcome before taking further action.

A confirmed managed merge completes its matching code task only when its required criteria already
have current supporting evidence or an explicit human waiver, and no worker still owns the work.
Delivery does not satisfy criteria or complete a parent task. If acceptance is pending, resolve the
remaining task requirements; the original delivery stays recorded. Downstream work can use an
accepted delivery while its approvals, scope, and supporting evidence remain current.

## When an action is unavailable

Reconnect and refresh before changing cached work. Disconnected views can retain history, but
their freshness labels matter. If a draft's revisions changed, compare the current content and
deliberately review the draft again. If an outcome is uncertain, use the offered exact retry
before submitting a replacement. Older environments may support inspection without the action
you need; follow the displayed explanation.
