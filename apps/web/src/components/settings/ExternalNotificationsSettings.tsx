import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ExternalNotificationDestination } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useContext, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { externalNotificationsEnvironment } from "../../state/externalNotifications";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
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
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const EMPTY: ReadonlyArray<ExternalNotificationDestination> = [];

/** Fixed sentences: a failed save must never echo the URL it carried. */
function describeSaveFailure(error: unknown): string {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    if (error._tag === "EnvironmentAuthorizationError")
      return "This connection isn't allowed to change settings on this environment.";
    if (error._tag === "EnvironmentRpcUnavailableError")
      return "The environment is offline. The change may not have been saved.";
  }
  return "The settings weren't saved. Check the destinations and try again.";
}

/**
 * Home Assistant webhooks for one environment. They live in that server's
 * settings, never sync elsewhere, and send only new attention events.
 */
export function ExternalNotificationsSettings() {
  const { environment } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <SettingsSection id="notifications" title="Notifications">
      {environment === null || !connected ? (
        <SettingsRow
          {...searchableSetting("external-notifications")}
          description="Connect an environment to set where it sends notifications."
        />
      ) : (
        <DestinationsEditor
          // A different environment never inherits another one's unsaved destinations.
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
        />
      )}
    </SettingsSection>
  );
}

function DestinationsEditor({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const registry = useContext(RegistryContext);
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
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    readonly id: string;
    readonly text: string;
    readonly ok: boolean;
  } | null>(null);

  const update = (id: string, change: Partial<DestinationDraft>) =>
    setDrafts(current.map((draft) => (draft.id === id ? { ...draft, ...change } : draft)));

  const save = async () => {
    if (error !== null || !dirty || pending !== null) return;
    setPending("save");
    setMessage(null);
    const result = await externalNotificationsEnvironment.updateSettings.run(registry, {
      environmentId,
      input: patch,
    });
    setPending(null);
    if (result._tag === "Success") {
      setDrafts(null);
      setMessage({ id: "save", text: "Saved.", ok: true });
    } else if (!isAtomCommandInterrupted(result)) {
      setMessage({
        id: "save",
        text: describeSaveFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
    }
  };

  const test = async (destinationId: string) => {
    if (pending !== null) return;
    setPending(destinationId);
    setMessage(null);
    const result = await externalNotificationsEnvironment.test.run(registry, {
      environmentId,
      input: { destinationId },
    });
    setPending(null);
    if (result._tag === "Success") {
      const outcome = describeTestResult(result.value);
      setMessage({ id: destinationId, text: outcome.message, ok: outcome.delivered });
    } else if (!isAtomCommandInterrupted(result)) {
      setMessage({
        id: destinationId,
        text: describeSaveFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("external-notifications")}
        description={`Home Assistant webhooks that ${environmentLabel} calls when a thread finishes, fails or needs input. Off until you add and turn one on; saving never sends anything.`}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={settings === null || current.length >= MAX_DESTINATIONS || pending !== null}
            onClick={() => setDrafts([...current, newDestinationDraft(randomUUID())])}
          >
            <PlusIcon />
            Add destination
          </Button>
        }
      />
      {current.map((draft) => {
        const testBlocked = destinationTestBlocked({ draft, saved, dirty });
        const configured = draft.url.kind === "stored";
        return (
          <SettingsRow
            key={draft.id}
            title={
              <Input
                size="sm"
                aria-label="Destination name"
                className="max-w-56"
                maxLength={128}
                value={draft.name}
                disabled={pending !== null}
                onChange={(event) => update(draft.id, { name: event.target.value })}
              />
            }
            description={
              message?.id === draft.id ? (
                <span
                  role={message.ok ? "status" : "alert"}
                  className={message.ok ? undefined : "text-destructive-foreground"}
                >
                  {message.text}
                </span>
              ) : (
                (testBlocked ?? "Ready to test.")
              )
            }
            control={
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex w-full min-w-0 items-center gap-1 sm:w-64">
                  <SecretInput
                    size="sm"
                    aria-label={`Webhook URL for ${draft.name}`}
                    className="min-w-0 flex-1"
                    configured={configured}
                    placeholder={draft.url.kind === "clear" ? "Cleared on save" : "Webhook URL"}
                    disabled={pending !== null}
                    value={draft.url.kind === "replace" ? draft.url.value : ""}
                    onChange={(event) =>
                      update(draft.id, {
                        url:
                          event.target.value.length > 0
                            ? { kind: "replace", value: event.target.value }
                            : saved.find((entry) => entry.id === draft.id)?.webhookUrl
                              ? { kind: "stored" }
                              : { kind: "none" },
                      })
                    }
                  />
                  {configured ? (
                    <Button
                      size="icon-sm"
                      variant="ghost-destructive"
                      aria-label={`Clear webhook URL for ${draft.name}`}
                      disabled={pending !== null}
                      onClick={() => update(draft.id, { url: { kind: "clear" } })}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <Switch
                  aria-label={`Send to ${draft.name}`}
                  checked={draft.enabled}
                  disabled={pending !== null}
                  onCheckedChange={(checked) => update(draft.id, { enabled: Boolean(checked) })}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={testBlocked !== null || !canTest || pending !== null}
                  onClick={() => void test(draft.id)}
                >
                  {pending === draft.id ? "Sending…" : "Send test"}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost-destructive"
                  aria-label={`Remove ${draft.name}`}
                  disabled={pending !== null}
                  onClick={() => setDrafts(current.filter((entry) => entry.id !== draft.id))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            }
          />
        );
      })}
      {dirty || message?.id === "save" ? (
        <SettingsRow
          title={dirty ? "Unsaved changes" : "Notifications"}
          description={
            dirty
              ? (error ??
                (canSave
                  ? "Save to apply, then send a test."
                  : "This connection can't change settings here."))
              : message?.text
          }
          control={
            dirty ? (
              <div className="flex gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending !== null}
                  onClick={() => setDrafts(null)}
                >
                  Discard
                </Button>
                <Button
                  size="xs"
                  disabled={error !== null || !canSave || pending !== null}
                  onClick={() => void save()}
                >
                  {pending === "save" ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null
          }
        />
      ) : null}
    </>
  );
}
