import { useAtomValue } from "@effect/atom-react";
import {
  mcpApplicationSummary,
  mcpSessionToggleOperation,
  type McpCatalogRow,
} from "@t3tools/client-runtime/mcp-catalog-forms";
import {
  McpCatalogOverrideId,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";

import { randomUUID } from "~/lib/utils";
import { mcpCatalogEnvironment } from "~/state/resources";

import { useMcpCatalogView } from "../settings/McpCatalogSettings";
import { useResourceCommand } from "../settings/useResourceCommand";
import { Switch } from "../ui/switch";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const SCOPE_LABELS = { global: "Environment", project: "Project", session: "This thread" } as const;

/**
 * The thread's MCP servers. Toggles write the thread's session overlay, the same
 * writes Settings makes for "this thread", so they need a session to exist.
 */
export default function ThreadDetailsMcpSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | null;
}) {
  const { environmentId } = props;
  const { snapshot, view } = useMcpCatalogView({
    environmentId,
    projectId: props.projectId,
    threadId: props.threadId,
    providerInstanceId: props.providerInstanceId,
  });
  const canWrite = useAtomValue(mcpCatalogEnvironment.write.permissionAtom(environmentId));
  const runner = useResourceCommand();
  const rows = view?.rows ?? [];
  const baseline =
    view?.own?.data && view.scope ? { ...view.scope, revision: view.own.data.revision } : null;
  const writable = canWrite && baseline !== null && baseline.scope === "session";
  const enabledCount = rows.filter((row) => row.enabled).length;
  const delivery = snapshot === null ? null : mcpApplicationSummary(snapshot);
  const failure = rows
    .map((row) => runner.failureFor(row.definition.definitionId))
    .find((message) => message !== null);

  const toggle = (row: McpCatalogRow) => {
    if (!writable || baseline === null) return;
    const key = row.definition.definitionId;
    const operation = mcpSessionToggleOperation({
      sessionId: baseline.scopeId,
      row,
      newOverrideId: McpCatalogOverrideId.make(randomUUID()),
    });
    if (!operation.ok) return runner.reportFailure(key, operation.error);
    void runner
      .run(key, mcpCatalogEnvironment.write, {
        environmentId,
        input: { ...baseline, expectedRevision: baseline.revision, operation: operation.value },
      })
      .then(() => view?.own?.refresh());
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-mcp-heading"
      title="MCP servers"
      actions={
        <span className="text-2xs text-muted-foreground tabular-nums">
          {enabledCount + 1} of {rows.length + 1} on
        </span>
      }
    >
      <ul className="m-0 list-none p-0">
        {/* T3's own server is injected into every provider session; it is not in the catalog. */}
        <li
          className={`flex items-center rounded-lg py-1.5 ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS}`}
        >
          <PlugIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-foreground/80">T3 Code</span>
            <span className="truncate text-2xs text-muted-foreground">Built in</span>
          </span>
          <Switch checked disabled aria-label="T3 Code is always on" />
        </li>
        {rows.map((row) => (
          <li
            key={row.definition.definitionId}
            className={`flex items-center rounded-lg py-1.5 ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS}`}
          >
            <PlugIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-foreground/80">{row.name}</span>
              <span className="truncate text-2xs text-muted-foreground">
                {SCOPE_LABELS[row.definition.scope]}
                {row.override?.enabled !== undefined ? " · changed for this thread" : ""}
              </span>
            </span>
            <Switch
              checked={row.enabled}
              disabled={!writable || runner.busy}
              aria-label={row.enabled ? `Turn off ${row.name}` : `Turn on ${row.name}`}
              onCheckedChange={() => toggle(row)}
            />
          </li>
        ))}
      </ul>
      {view === null ? (
        <p className="px-2.5 py-1 text-2xs text-muted-foreground">Loading servers…</p>
      ) : null}
      {failure ? (
        <p className="px-2.5 pt-1 text-2xs text-destructive">{failure}</p>
      ) : rows.length > 0 && baseline?.scope !== "session" ? (
        <p className="px-2.5 pt-1 text-2xs text-muted-foreground">
          Servers can be switched for this thread once it has run.
        </p>
      ) : delivery && (delivery.tone === "warning" || delivery.tone === "error") ? (
        <p className="px-2.5 pt-1 text-2xs text-muted-foreground">{delivery.label}</p>
      ) : null}
    </ThreadDetailsSection>
  );
}
