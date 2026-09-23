# Skills

Open **Settings > Skills** to create or import a T3-managed skill. A skill saved for an environment is available to its projects; a project override applies only to that project. In a thread, **Session skills** lets you use or disable a managed skill for that thread's provider. Changes to session delivery take effect when the provider starts a new session.

To keep a skill available outside T3, select it in **Settings > Skills**, choose a provider instance, and install it to a project or user directory. You can update or uninstall a T3-owned copy there. **Installed copies** also lets you remove a copy after its T3 source has been renamed or deleted. T3 will not replace a provider-owned skill or overwrite an installed copy changed outside T3. Installed skills are visible to other clients using the same provider directory.

The install choices show their exact directory and which providers read it. A provider-specific install uses that provider's native directory. Shared `.agents` installs use these readers:

| Install location         | Providers that read it               |
| ------------------------ | ------------------------------------ |
| Project `.agents/skills` | Codex, OpenCode, Cursor, Antigravity |
| User `~/.agents/skills`  | Codex, OpenCode, Cursor, Grok        |

Claude reads neither shared `.agents` location. Use its `.claude/skills` install choice for Claude. Grok reads its own `.grok/skills` directories and user `~/.agents/skills`, but not project `.agents/skills`. Antigravity reads project `.agents/skills` and its own Gemini skill directories, but not user `~/.agents/skills`.

Session use is supported for Claude, Codex, and OpenCode started by T3. Cursor, Grok, Antigravity, and external OpenCode support persistent installs without T3 session delivery. External OpenCode installs require a loopback Server URL and a checkout accessible at the same path to both processes. T3 checks file visibility through the server API before offering an install. Restart the external server to load a newly installed skill.
