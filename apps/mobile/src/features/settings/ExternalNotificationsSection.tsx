import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ExternalNotificationDestination } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { externalNotificationsEnvironment } from "../../state/externalNotifications";
import { serverEnvironment } from "../../state/server";
import { AgentInput } from "../assistants/AssistantParts";
import { WorkBlock, WorkFormActions } from "../work/WorkParts";
import { createExclusiveOperation } from "./exclusiveOperation";
import {
  MAX_DESTINATIONS,
  describeTestResult,
  destinationDrafts,
  destinationDraftsChanged,
  destinationDraftsError,
  destinationTestBlocked,
  destinationsPatch,
  newDestinationDraft,
  type DestinationDraft,
} from "@t3tools/client-runtime/external-notification-presentation";

const EMPTY: ReadonlyArray<ExternalNotificationDestination> = [];

function describeFailure(error: unknown): string {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "EnvironmentAuthorizationError")
      return "This connection isn't allowed to change settings on this environment.";
    if (error._tag === "EnvironmentRpcUnavailableError")
      return "The environment is offline. The change may not have been saved.";
  }
  return "That didn't complete. Check the destinations and try again.";
}

/** Home Assistant webhooks, stored per environment in that server's settings. */
export function ExternalNotificationsSection() {
  const { environments } = useEnvironments();
  // The default is the first environment in the stable list, connected or not, so a disconnect
  // never moves the form to another environment; only the person switching does.
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId = chosen ?? environments[0]?.environmentId ?? null;
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const online = environment?.connection.phase === "connected";
  return (
    <>
      <ListSection
        title="Home Assistant"
        footer="Each environment calls its own webhooks when a thread finishes, fails or needs input. Off until you add and turn one on; saving never sends anything."
      >
        {environments.length === 0 ? (
          <WorkBlock>
            <Text className="text-foreground-muted">Connect an environment to set this up.</Text>
          </WorkBlock>
        ) : (
          environments.map((candidate) => (
            <ListChoiceRow
              key={candidate.environmentId}
              label={candidate.label}
              {...(candidate.connection.phase === "connected" ? {} : { description: "Offline" })}
              selected={candidate.environmentId === environmentId}
              onPress={() => setChosen(candidate.environmentId)}
            />
          ))
        )}
      </ListSection>
      {environment !== null && !online ? (
        <Notice
          icon="info.circle"
          message={`${environment.label} is offline. Your edits are kept; reconnect it to save or test.`}
        />
      ) : null}
      {environment !== null ? (
        <DestinationsEditor
          key={environment.environmentId}
          environmentId={environment.environmentId}
          online={online}
          onEngage={() => setChosen(environment.environmentId)}
        />
      ) : null}
    </>
  );
}

function DestinationsEditor({
  environmentId,
  online,
  onEngage,
}: {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
  readonly onEngage: () => void;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const saved = settings?.externalNotifications.destinations ?? EMPTY;
  const [drafts, setDrafts] = useState<ReadonlyArray<DestinationDraft> | null>(null);
  const current = drafts ?? destinationDrafts(saved);
  const dirty = drafts !== null && destinationDraftsChanged(drafts, saved);
  const error = destinationDraftsError(current);
  const patch = {
    patch: { externalNotifications: { destinations: destinationsPatch(current, saved) } },
  };
  const canSave = useAtomValue(
    externalNotificationsEnvironment.updateSettings.permissionAtom(environmentId, patch),
  );
  const canTest = useAtomValue(externalNotificationsEnvironment.test.permissionAtom(environmentId));
  // "save" or the destination being tested. Save and Test never overlap, so a Test finishing can't
  // unlock fields while a Save is still in flight.
  const [pending, setPending] = useState<string | null>(null);
  const [operation] = useState(() => createExclusiveOperation(setPending));
  const [message, setMessage] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  // Locked while anything is pending, so a successful save never discards edits made after it was sent.
  const locked = pending !== null;
  const edit = (next: ReadonlyArray<DestinationDraft>) => {
    if (locked) return;
    onEngage();
    setDrafts(next);
  };
  const update = (id: string, change: Partial<DestinationDraft>) =>
    edit(current.map((draft) => (draft.id === id ? { ...draft, ...change } : draft)));

  const test = async (destinationId: string) => {
    if (!online || operation.active() !== null) return;
    setMessage(null);
    const run = await operation.run(destinationId, () =>
      externalNotificationsEnvironment.test.run(appAtomRegistry, {
        environmentId,
        input: { destinationId },
      }),
    );
    if (!run.started) return;
    const result = run.value;
    if (result._tag === "Success") {
      const outcome = describeTestResult(result.value);
      setMessage({ id: destinationId, text: outcome.message, ok: outcome.delivered });
    } else if (!isAtomCommandInterrupted(result))
      setMessage({
        id: destinationId,
        text: describeFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
  };

  return (
    <>
      {current.map((draft) => {
        const blocked = destinationTestBlocked({ draft, saved, dirty });
        return (
          <ListSection key={draft.id} title={draft.name || "Destination"}>
            <WorkBlock>
              <AgentInput
                label="Name"
                maxLength={128}
                value={draft.name}
                disabled={locked}
                onChange={(name) => update(draft.id, { name })}
              />
              <View className="gap-1.5">
                <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                  Webhook URL
                </Text>
                <AppTextInput
                  accessibilityLabel={`Webhook URL for ${draft.name}`}
                  className="min-h-11 rounded-xl border-continuous bg-card px-3 py-2.5 text-base text-foreground"
                  secureTextEntry
                  editable={!locked}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={
                    draft.url.kind === "stored"
                      ? "Stored. Enter a new URL to replace it"
                      : draft.url.kind === "clear"
                        ? "Cleared on save"
                        : "https://…/api/webhook/…"
                  }
                  value={draft.url.kind === "replace" ? draft.url.value : ""}
                  onChangeText={(value) =>
                    update(draft.id, {
                      url:
                        value.length > 0
                          ? { kind: "replace", value }
                          : saved.find((entry) => entry.id === draft.id)?.webhookUrl
                            ? { kind: "stored" }
                            : { kind: "none" },
                    })
                  }
                />
              </View>
              {message?.id === draft.id ? (
                <Notice tone={message.ok ? "default" : "danger"} message={message.text} />
              ) : blocked ? (
                <Text textRole="footnote" className="text-foreground-muted">
                  {blocked}
                </Text>
              ) : null}
            </WorkBlock>
            <ListToggleRow
              label="Send notifications here"
              value={draft.enabled}
              disabled={locked}
              onValueChange={(enabled) => update(draft.id, { enabled })}
            />
            {draft.url.kind === "stored" ? (
              <ListActionRow
                label="Clear webhook URL"
                tone="danger"
                disabled={locked}
                onPress={() => update(draft.id, { url: { kind: "clear" } })}
              />
            ) : null}
            <ListActionRow
              icon="bell.badge"
              label="Send test"
              loading={pending === draft.id}
              disabled={blocked !== null || !canTest || locked || !online}
              onPress={() => void test(draft.id)}
            />
            <ListActionRow
              icon="trash"
              label="Remove destination"
              tone="danger"
              disabled={locked}
              onPress={() => edit(current.filter((entry) => entry.id !== draft.id))}
            />
          </ListSection>
        );
      })}
      <ListSection>
        <ListActionRow
          icon="plus"
          label="Add destination"
          disabled={settings === null || current.length >= MAX_DESTINATIONS || locked}
          onPress={() => edit([...current, newDestinationDraft(uuidv4())])}
        />
      </ListSection>
      {dirty ? (
        <WorkFormActions
          submitLabel="Save"
          pending={pending === "save"}
          disabled={error !== null || !canSave || !online || locked}
          failure={
            (message?.id === "save" && !message.ok ? message.text : null) ??
            error ??
            (canSave ? null : "This connection can't change settings here.")
          }
          onCancel={() => setDrafts(null)}
          onSubmit={async () => {
            if (!online || operation.active() !== null) return;
            setMessage(null);
            const run = await operation.run("save", () =>
              externalNotificationsEnvironment.updateSettings.run(appAtomRegistry, {
                environmentId,
                input: patch,
              }),
            );
            if (!run.started) return;
            const result = run.value;
            // Fields were locked while saving, so the accepted version is exactly what is shown.
            if (result._tag === "Success") setDrafts(null);
            else if (!isAtomCommandInterrupted(result))
              setMessage({
                id: "save",
                text: describeFailure(squashAtomCommandFailure(result)),
                ok: false,
              });
          }}
        />
      ) : null}
    </>
  );
}
