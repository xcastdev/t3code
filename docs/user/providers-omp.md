# OMP

T3 Code's native OMP provider uses oh-my-pi on the machine running the T3 Code server. Enable it
separately from Pi or an existing oh-my-pi ACP provider. Switching between them does not resume
the same native session.

## Set up OMP

1. Install Bun **1.4.4** and the source-bearing npm package
   **@oh-my-pi/pi-coding-agent 18.16.0** on the server machine. This integration requires that exact
   package and runtime combination; standalone compiled executables and other versions are
   unsupported.
2. Run `omp` on that machine and authenticate your model provider through OMP, or configure its
   API key in OMP's configuration.
3. In T3 Code Settings, enable **OMP**, then refresh the provider. OMP starts disabled.

Set the binary path if `omp` is not on the server's `PATH`. The `bun` command must also resolve to
Bun 1.4.4 in that environment. Use launch arguments for your OMP profile, agent directory and model
configuration. T3 Code owns session selection and execution mode, so arguments that override them
are rejected.

For a remote server, install and authenticate OMP there; the browser or phone does not run OMP.
API keys can also be supplied through that provider instance's environment variables. Mark keys
as sensitive. During an agent turn, answer OMP’s single-line secret prompts in the private-input card.
The answer goes directly to OMP and stays out of chat history. Stopping the agent closes the
prompt; repeat the action if it needs to ask again.

T3 Code refuses an installation whose required native source files differ from the supported
recipe, even if its version number matches. It does not patch installed OMP files or change the
settings used when you launch OMP directly.

## Models and permissions

The model picker shows OMP's available credentialed models and supported thinking choices.
Workspace commands and skills come from that OMP instance. If no models appear, open OMP directly
with the same profile and environment, confirm authentication, then refresh in T3 Code.

The composer permission mode applies to OMP tools:

- **Supervised** asks before commands, file changes and other execution tools.
- **Auto-accept edits** allows native edits and writes, and asks before commands and other
  execution tools.
- **Full access** allows tools without T3 Code approval prompts.

OMP has no T3 Code AI approval reviewer, so **Auto** is unavailable. These permissions govern
native tool execution; they do not create an operating-system sandbox.

## Agents, terminals and eval

T3 Code manages delegated agents and persistent terminals. Ask the agent to use T3 Code delegation
for child work and T3 Code terminals for persistent commands or services. OMP's native background
jobs, managed services and native subagents are unavailable in T3-launched sessions.

Foreground Python and JavaScript eval remain available. Their work-log entries show input code,
the latest phase, execution logs and program output separately. Output previews can be truncated;
opening an entry fetches retained tool detail when available. Images use the server's authenticated
attachment path. When OMP retains full output with a supported native artifact reference, open
that output from the entry to preview or save it. Mobile uses the device's document viewer and
sharing flow. Missing, unsupported or unauthorized artifact references remain unavailable.

Eval's model-call helpers, including `completion`, `judge`, `judge_batch` and `judgeBatch`, are
unavailable. Use T3 Code delegation when work needs another agent.

Native sessions created by this OMP instance retain their conversation for resume, rollback and
forks. Existing Pi and ACP providers keep their own sessions and configuration.
