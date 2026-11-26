import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  credentialDraft,
  describeExternalNotificationCommandFailure,
  describeTestResult,
  destinationDrafts,
  destinationDraftsError,
  destinationTestBlocked,
  destinationsPatch,
  MAX_DESTINATIONS,
  newDestinationDraft,
  type CredentialDraft,
  type DestinationDraft,
  type DestinationEditorDraft,
  updateDestinationEditorDraft,
} from "@t3tools/client-runtime/external-notification-presentation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_EXTERNAL_NOTIFICATION_EVENTS,
  type EnvironmentId,
  type ExternalNotificationDestination,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useContext, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { externalNotificationsEnvironment } from "../../state/externalNotifications";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const EMPTY: ReadonlyArray<ExternalNotificationDestination> = [];
const PERMISSION_INPUT = { patch: { externalNotifications: { destinations: EMPTY } } };

export function ExternalNotificationsSettings() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  return (
    <SettingsSection id="notifications" title={gt("Notifications")}>
      {environment === null || !connected ? (
        <SettingsRow
          {...searchableSetting("external-notifications")}
          title={gt("External notifications")}
          description={gt("Connect an environment to set where it sends notifications.")}
        />
      ) : (
        <DestinationsEditor
          key={environment.environmentId}
          environmentId={environment.environmentId}
          supportsWebhookOptions={
            environment.serverConfig.environment.capabilities.genericWebhookDestinations === true
          }
        />
      )}
    </SettingsSection>
  );
}

function DestinationsEditor({
  environmentId,
  supportsWebhookOptions,
}: {
  readonly environmentId: EnvironmentId;
  readonly supportsWebhookOptions: boolean;
}) {
  const gt = useGT();
  const adapterLabels = {
    "home-assistant": gt("Home Assistant"),
    "generic-webhook": gt("Generic webhook"),
  };
  const eventLabels = {
    completion: gt("Completed"),
    failure: gt("Failed"),
    cancelled: gt("Cancelled"),
    update: gt("Updated"),
    unknown: gt("Unknown outcome"),
    "needs-input": gt("Needs input"),
    "needs-approval": gt("Needs approval"),
    "work-attention": gt("Project work needs attention"),
  };
  const messages = {
    "too-many": gt("Keep at most 16 destinations."),
    "empty-name": gt("Give each destination a name."),
    "long-name": gt("Use at most 128 characters for each destination name."),
    "invalid-url": gt("Enter a full HTTP or HTTPS webhook URL."),
    new: gt("Save this destination before testing it."),
    dirty: gt("Save your changes before testing."),
    "missing-url": gt("Add a webhook URL and save before testing."),
    delivered: gt("Test notification delivered."),
    unconfigured: gt("No webhook URL is saved for this destination."),
    "malformed-url": gt("The saved webhook URL is invalid. Replace it and save."),
    transport: gt("The server could not confirm delivery to the webhook."),
    timeout: gt("The webhook timed out. Delivery is unknown."),
    "http-status": gt("The webhook returned an error status."),
    failed: gt("The test notification failed."),
    unauthorized: gt("This connection lacks permission for that action."),
    offline: gt("The environment is offline. Reconnect to save or test."),
    "command-failed": gt("The action could not be confirmed. Check the destination and try again."),
  };
  const registry = useContext(RegistryContext);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const notifications = settings?.externalNotifications;
  const [drafts, setDrafts] = useState<DestinationEditorDraft | null>(null);
  const snapshot = drafts === null ? notifications : drafts.original;
  const saved = snapshot?.destinations ?? EMPTY;
  const current = drafts?.destinations ?? destinationDrafts(saved);
  const dirty = drafts !== null;
  const error = destinationDraftsError(current);
  const canSave = useAtomValue(
    externalNotificationsEnvironment.updateSettings.permissionAtom(environmentId, PERMISSION_INPUT),
  );
  const canTest = useAtomValue(externalNotificationsEnvironment.test.permissionAtom(environmentId));
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    readonly id: string;
    readonly text: keyof typeof messages | "saved";
    readonly ok: boolean;
  } | null>(null);
  const locked = pending !== null;

  const edit = (next: ReadonlyArray<DestinationDraft> | null) => {
    setDrafts((previous) => updateDestinationEditorDraft(previous, notifications, next));
    setMessage(null);
  };
  const update = (id: string, change: Partial<DestinationDraft>) =>
    edit(current.map((draft) => (draft.id === id ? { ...draft, ...change } : draft)));

  const save = async () => {
    if (error !== null || !dirty || locked) return;
    setPending("save");
    setMessage(null);
    const result = await externalNotificationsEnvironment.updateSettings.run(registry, {
      environmentId,
      input: {
        patch: {
          externalNotifications: {
            destinations: destinationsPatch(current, saved, supportsWebhookOptions),
            ...(snapshot?.revision === undefined ? {} : { revision: snapshot.revision }),
          },
        },
      },
    });
    setPending(null);
    if (result._tag === "Success") {
      setDrafts(null);
      setMessage({ id: "save", text: "saved", ok: true });
    } else if (!isAtomCommandInterrupted(result)) {
      setMessage({
        id: "save",
        text: describeExternalNotificationCommandFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
    }
  };

  const test = async (destinationId: string) => {
    if (locked) return;
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
        text: describeExternalNotificationCommandFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("external-notifications")}
        title={gt("External notifications")}
        description={
          supportsWebhookOptions
            ? gt(
                "Choose where this environment sends notifications and which events each destination receives.",
              )
            : gt("Home Assistant")
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={settings === null || current.length >= MAX_DESTINATIONS || locked}
            onClick={() =>
              edit([...current, newDestinationDraft(randomUUID(), gt("New destination"))])
            }
          >
            <PlusIcon />
            {gt("Add destination")}
          </Button>
        }
      />
      {current.map((draft) => {
        const original = saved.find((entry) => entry.id === draft.id);
        const testBlocked = destinationTestBlocked({ draft, saved, dirty });
        const destinationMessage = message?.id === draft.id ? message : null;
        const selectedEvents = draft.events ?? DEFAULT_EXTERNAL_NOTIFICATION_EVENTS;

        return (
          <SettingsRow
            key={draft.id}
            title={
              <Input
                size="sm"
                aria-label={gt("Destination name")}
                placeholder={gt("Destination name")}
                maxLength={128}
                value={draft.name}
                disabled={locked}
                onChange={(event) => update(draft.id, { name: event.target.value })}
              />
            }
            description={
              destinationMessage && destinationMessage.text !== "saved" ? (
                <span
                  role={destinationMessage.ok ? "status" : "alert"}
                  className={destinationMessage.ok ? undefined : "text-destructive-foreground"}
                >
                  {messages[destinationMessage.text]}
                </span>
              ) : (
                testBlocked && messages[testBlocked]
              )
            }
            control={
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={draft.enabled}
                    disabled={locked}
                    onCheckedChange={(enabled) => update(draft.id, { enabled })}
                  />
                  {gt("Enabled")}
                </label>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={testBlocked !== null || !canTest || locked}
                  onClick={() => void test(draft.id)}
                >
                  {pending === draft.id ? gt("Sending…") : gt("Send test")}
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost-destructive"
                  aria-label={gt("Remove destination")}
                  disabled={locked}
                  onClick={() => edit(current.filter((entry) => entry.id !== draft.id))}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            }
          >
            <div className="grid gap-3 py-3 @min-[32rem]/settings-row:grid-cols-2">
              {supportsWebhookOptions ? (
                <>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">{gt("Adapter")}</div>
                    <Select
                      value={draft.kind}
                      disabled={locked}
                      onValueChange={(kind) => {
                        if (kind !== null) update(draft.id, { kind });
                      }}
                    >
                      <SelectTrigger size="sm" aria-label={gt("Adapter")}>
                        <SelectValue>{adapterLabels[draft.kind]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="home-assistant">
                          {adapterLabels["home-assistant"]}
                        </SelectItem>
                        <SelectItem value="generic-webhook">
                          {adapterLabels["generic-webhook"]}
                        </SelectItem>
                      </SelectPopup>
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Popover>
                      <PopoverTrigger
                        render={<Button size="sm" variant="outline" disabled={locked} />}
                      >
                        {gt("Events ({count})", { count: selectedEvents.length })}
                        <ChevronDownIcon />
                      </PopoverTrigger>
                      <PopoverPopup width="sm" align="start" padding="compact">
                        <PopoverTitle className="mb-1">{gt("Notification events")}</PopoverTitle>
                        {DEFAULT_EXTERNAL_NOTIFICATION_EVENTS.map((event) => (
                          <label key={event} className="flex min-h-8 items-center gap-2 text-sm">
                            <Checkbox
                              checked={selectedEvents.includes(event)}
                              disabled={locked}
                              onCheckedChange={(checked) =>
                                update(draft.id, {
                                  events: checked
                                    ? [...selectedEvents, event]
                                    : selectedEvents.filter((selected) => selected !== event),
                                })
                              }
                            />
                            {eventLabels[event]}
                          </label>
                        ))}
                      </PopoverPopup>
                    </Popover>
                  </div>
                </>
              ) : null}
              <CredentialField
                label={gt("Webhook URL")}
                clearLabel={gt("Clear webhook URL")}
                credential={draft.url}
                disabled={locked}
                onChange={(url) => update(draft.id, { url })}
                saved={original?.webhookUrl}
              />
              {supportsWebhookOptions && draft.kind === "generic-webhook" ? (
                <CredentialField
                  label={gt("Signing key (optional)")}
                  clearLabel={gt("Clear signing key")}
                  credential={draft.signingKey}
                  disabled={locked}
                  onChange={(signingKey) => update(draft.id, { signingKey })}
                  saved={original?.signingKey}
                />
              ) : null}
            </div>
          </SettingsRow>
        );
      })}
      {dirty || message?.id === "save" ? (
        <SettingsRow
          title={dirty ? gt("Unsaved changes") : gt("Notifications")}
          description={
            message?.id === "save" ? (
              <span role={message.ok ? "status" : "alert"}>
                {message.text === "saved" ? gt("Saved.") : messages[message.text]}
              </span>
            ) : error !== null ? (
              messages[error]
            ) : canSave ? (
              gt("Save your changes before testing.")
            ) : (
              messages.unauthorized
            )
          }
          control={
            dirty ? (
              <div className="flex gap-2">
                <Button size="xs" variant="ghost" disabled={locked} onClick={() => edit(null)}>
                  {gt("Discard")}
                </Button>
                <Button
                  size="xs"
                  disabled={error !== null || !canSave || locked}
                  onClick={() => void save()}
                >
                  {pending === "save" ? gt("Saving…") : gt("Save")}
                </Button>
              </div>
            ) : null
          }
        />
      ) : null}
    </>
  );
}

function CredentialField({
  label,
  clearLabel,
  credential,
  saved,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly clearLabel: string;
  readonly credential: CredentialDraft;
  readonly saved: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (credential: CredentialDraft) => void;
}) {
  const gt = useGT();
  return (
    <div className="flex min-w-0 items-end gap-1">
      <label className="min-w-0 flex-1 space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">{label}</span>
        <Input
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={credential.kind === "replace" ? credential.value : ""}
          placeholder={
            credential.kind === "stored"
              ? gt("Stored. Enter a new value to replace it.")
              : credential.kind === "clear"
                ? gt("Cleared on save")
                : undefined
          }
          disabled={disabled}
          onChange={(event) => onChange(credentialDraft(event.target.value, saved))}
        />
      </label>
      {credential.kind === "stored" ? (
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          aria-label={clearLabel}
          disabled={disabled}
          onClick={() => onChange({ kind: "clear" })}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
