import {
  assistantSelectionIsCurrent,
  prepareAssistantMemoryMutation,
  type AssistantSelection,
} from "@t3tools/client-runtime/state/assistants";
import type { MemoryProcessingConfiguration } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { assistantsEnvironment } from "../../state/assistants";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  WorkEmpty,
  WorkField,
  WorkFormStatus,
  WorkMeta,
  WorkRevision,
  WorkRow,
  WorkSection,
} from "../work/WorkLayout";
import { agentBlockedReason, type AgentContext } from "./AgentDetailPage";
import { useAgentMemoryRead } from "./AgentMemory";
import {
  EMPTY_PROCESSING_ROUTE as EMPTY_ROUTE,
  PROCESSING_PROVIDERS as PROVIDERS,
  processingDraftConfiguration,
  processingDraftFrom,
  type ExtractionProvider,
  type ProcessingDraft,
  type ProcessingRouteDraft as RouteDraft,
} from "@t3tools/client-runtime/assistant-presentation";

interface Session {
  readonly selected: AssistantSelection;
  readonly revision: number;
  readonly draft: ProcessingDraft;
}

const KEY = "memory:configure";

export function AgentMemoryProcessing({ context }: { readonly context: AgentContext }) {
  const { writer, detail } = context;
  const read = useAgentMemoryRead(context, "configuration");
  const [session, setSession] = useState<Session | null>(null);
  const blocked = agentBlockedReason(context, writer.permissions.memory);
  const pending = writer.pendingKey === KEY;
  const saved = read.data;

  const configure = async (
    selected: AssistantSelection,
    expectedRevision: number,
    configuration: MemoryProcessingConfiguration,
  ) => {
    const current = context.latestSelection();
    return writer.run(
      KEY,
      assistantsEnvironment.memoryWrite,
      current === null || saved === null
        ? null
        : prepareAssistantMemoryMutation({
            selected,
            current,
            intent: {
              environmentId: detail.summary.environmentId,
              assistantId: detail.summary.assistantId,
              operation: "configure",
              expectedRevision,
              configuration,
            },
            configurationRevision: saved.revision,
          }),
    );
  };

  if (saved === null)
    return (
      <WorkSection title="Memory processing">
        <WorkEmpty
          title={
            read.error ? "Processing settings aren't available" : "Loading processing settings…"
          }
        />
      </WorkSection>
    );

  const external =
    saved.configuration.extractionRoute !== undefined ||
    saved.configuration.destination !== undefined;
  const live = context.selection;
  const stale =
    session !== null &&
    (live === null ||
      !assistantSelectionIsCurrent(session.selected, live) ||
      session.revision !== saved.revision);
  const built =
    session === null ? null : processingDraftConfiguration(session.draft, session.selected);
  const draft = session?.draft ?? processingDraftFrom(saved.configuration);
  const set = (next: ProcessingDraft) => {
    if (session !== null) setSession({ ...session, draft: next });
  };
  const disabled = session === null || pending;

  return (
    <WorkSection
      title="Memory processing"
      description={
        <>
          Built-in by default. External routes send this agent's memory to the services named here,
          using a key stored on this environment. Settings revision{" "}
          <WorkRevision>{saved.revision}</WorkRevision>.
        </>
      }
      actions={
        session === null ? (
          <>
            {external ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={blocked !== null || writer.pendingKey !== null}
                onClick={async () => {
                  const selected = context.selection;
                  if (selected === null) return;
                  const confirmed = await requestConfirmDialog(
                    "Stop sending this agent's memory to external services? Built-in processing continues.",
                  );
                  if (confirmed === true) await configure(selected, saved.revision, {});
                }}
              >
                Use built-in only
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={blocked !== null || writer.pendingKey !== null}
              onClick={() => {
                if (context.selection === null) return;
                setSession({
                  selected: context.selection,
                  revision: saved.revision,
                  draft: processingDraftFrom(saved.configuration),
                });
              }}
            >
              Edit
            </Button>
          </>
        ) : undefined
      }
    >
      <WorkRow className="gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {saved.configuration.extractionRoute
              ? `Extraction: ${PROVIDERS[saved.configuration.extractionRoute.provider]}`
              : "Extraction: built-in"}
          </Badge>
          <Badge variant="outline">
            {saved.configuration.destination ? "External index: on" : "External index: off"}
          </Badge>
        </div>
        {stale ? (
          <div className="flex flex-col gap-2">
            <WorkFormStatus message="These settings or the connection changed after you started editing. Your edits are kept; discard them to edit the current version." />
          </div>
        ) : null}
        <RouteToggle
          label="External extraction"
          hint="Off uses the agent's own model. On sends chat excerpts to this endpoint."
          checked={draft.extraction !== null}
          disabled={disabled}
          onChange={(on) =>
            set({ ...draft, extraction: on ? { ...EMPTY_ROUTE, provider: "command-code" } : null })
          }
        >
          {draft.extraction !== null ? (
            <>
              <WorkField label="Service">
                {(id) => (
                  <Select
                    value={draft.extraction?.provider ?? "command-code"}
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (draft.extraction && (value === "command-code" || value === "liquid"))
                        set({ ...draft, extraction: { ...draft.extraction, provider: value } });
                    }}
                  >
                    <SelectTrigger id={id} size="sm" className="w-48">
                      <SelectValue>
                        {PROVIDERS[draft.extraction?.provider ?? "command-code"]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {(Object.keys(PROVIDERS) as ExtractionProvider[]).map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {PROVIDERS[provider]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </WorkField>
              <RouteFields
                route={draft.extraction}
                disabled={disabled}
                onChange={(route) =>
                  draft.extraction &&
                  set({ ...draft, extraction: { ...draft.extraction, ...route } })
                }
              />
            </>
          ) : null}
        </RouteToggle>
        <RouteToggle
          label="External memory index"
          hint="Off keeps recall on this environment. On sends memory to this embedding endpoint for indexing."
          checked={draft.index !== null}
          disabled={disabled}
          onChange={(on) =>
            set({ ...draft, index: on ? { ...EMPTY_ROUTE, dimensions: "" } : null })
          }
        >
          {draft.index !== null ? (
            <>
              <RouteFields
                route={draft.index}
                disabled={disabled}
                onChange={(route) =>
                  draft.index && set({ ...draft, index: { ...draft.index, ...route } })
                }
              />
              <WorkField label="Dimensions">
                {(id) => (
                  <Input
                    id={id}
                    size="sm"
                    className="w-32"
                    inputMode="numeric"
                    disabled={disabled}
                    value={draft.index?.dimensions ?? ""}
                    onChange={(event) =>
                      draft.index &&
                      set({ ...draft, index: { ...draft.index, dimensions: event.target.value } })
                    }
                  />
                )}
              </WorkField>
            </>
          ) : null}
        </RouteToggle>
        {session !== null ? (
          <>
            <WorkFormStatus
              message={
                writer.failureFor(KEY) ?? (built !== null && "error" in built ? built.error : null)
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                disabled={
                  pending || stale || blocked !== null || built === null || "error" in built
                }
                onClick={async () => {
                  if (built === null || "error" in built) return;
                  const result = await configure(
                    session.selected,
                    session.revision,
                    built.configuration,
                  );
                  if (result !== null) setSession(null);
                }}
              >
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => setSession(null)}>
                {stale ? "Discard edits" : "Cancel"}
              </Button>
            </div>
          </>
        ) : (
          <WorkFormStatus message={writer.failureFor(KEY)} />
        )}
      </WorkRow>
    </WorkSection>
  );
}

function RouteToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">{label}</p>
          <WorkMeta>{hint}</WorkMeta>
        </div>
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onChange(Boolean(next))}
        />
      </div>
      {children}
    </div>
  );
}

function RouteFields({
  route,
  disabled,
  onChange,
}: {
  readonly route: RouteDraft;
  readonly disabled: boolean;
  readonly onChange: (route: Partial<RouteDraft>) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <WorkField label="Endpoint">
        {(id) => (
          <Input
            id={id}
            size="sm"
            placeholder="https://…"
            disabled={disabled}
            value={route.endpoint}
            onChange={(event) => onChange({ endpoint: event.target.value })}
          />
        )}
      </WorkField>
      <WorkField label="Model">
        {(id) => (
          <Input
            id={id}
            size="sm"
            disabled={disabled}
            value={route.model}
            onChange={(event) => onChange({ model: event.target.value })}
          />
        )}
      </WorkField>
      <WorkField label="Stored secret name">
        {(id) => (
          <Input
            id={id}
            size="sm"
            disabled={disabled}
            value={route.secretName}
            onChange={(event) => onChange({ secretName: event.target.value })}
          />
        )}
      </WorkField>
    </div>
  );
}
