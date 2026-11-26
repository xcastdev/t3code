import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
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
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { I18nProvider } from "../../i18n/I18nProvider";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { externalNotificationsEnvironment } from "../../state/externalNotifications";
import { serverEnvironment } from "../../state/server";
import { WorkBlock } from "../work/WorkParts";
import { createExclusiveOperation } from "./exclusiveOperation";

const EMPTY: ReadonlyArray<ExternalNotificationDestination> = [];
const PERMISSION_INPUT = { patch: { externalNotifications: { destinations: EMPTY } } };

export function ExternalNotificationsSection() {
  return (
    <I18nProvider>
      <EnvironmentPicker />
    </I18nProvider>
  );
}

function EnvironmentPicker() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId = chosen ?? environments[0]?.environmentId ?? null;
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const online = environment?.connection.phase === "connected";
  const supportsWebhookOptions =
    environment?.serverConfig?.environment.capabilities.genericWebhookDestinations === true;
  return (
    <>
      <ListSection
        title={
          environment !== null && !supportsWebhookOptions
            ? gt("Home Assistant")
            : gt("External notifications")
        }
        {...(supportsWebhookOptions
          ? {
              footer: gt(
                "Choose where this environment sends notifications and which events each destination receives.",
              ),
            }
          : {})}
      >
        {environments.length === 0 ? (
          <WorkBlock>
            <Text className="text-foreground-muted">
              {gt("Connect an environment to set where it sends notifications.")}
            </Text>
          </WorkBlock>
        ) : (
          environments.map((candidate) => (
            <ListChoiceRow
              key={candidate.environmentId}
              label={candidate.label}
              {...(candidate.connection.phase === "connected"
                ? {}
                : { description: gt("Offline") })}
              selected={candidate.environmentId === environmentId}
              onPress={() => setChosen(candidate.environmentId)}
            />
          ))
        )}
      </ListSection>
      {environment !== null && !online ? (
        <Notice
          icon="info.circle"
          message={gt("{environment} is offline. Your edits are kept until you reconnect.", {
            environment: environment.label,
          })}
        />
      ) : null}
      {environment !== null ? (
        <DestinationsEditor
          key={environment.environmentId}
          environmentId={environment.environmentId}
          online={online}
          supportsWebhookOptions={supportsWebhookOptions}
          onEngage={() => setChosen(environment.environmentId)}
        />
      ) : null}
    </>
  );
}

function DestinationsEditor({
  environmentId,
  online,
  supportsWebhookOptions,
  onEngage,
}: {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
  readonly supportsWebhookOptions: boolean;
  readonly onEngage: () => void;
}) {
  const gt = useGT();
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
  const [operation] = useState(() => createExclusiveOperation(setPending));
  const [message, setMessage] = useState<{
    readonly id: string;
    readonly text: keyof typeof messages;
    readonly ok: boolean;
  } | null>(null);
  const locked = pending !== null;
  const edit = (
    change: ((drafts: ReadonlyArray<DestinationDraft>) => ReadonlyArray<DestinationDraft>) | null,
  ) => {
    if (locked) return;
    onEngage();
    setDrafts((previous) => {
      const next =
        change?.(
          previous?.destinations ?? destinationDrafts(notifications?.destinations ?? EMPTY),
        ) ?? null;
      return updateDestinationEditorDraft(previous, notifications, next);
    });
    setMessage(null);
  };

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
    } else if (!isAtomCommandInterrupted(result)) {
      setMessage({
        id: destinationId,
        text: describeExternalNotificationCommandFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
    }
  };

  const save = async () => {
    if (!online || error !== null || !dirty || operation.active() !== null) return;
    setMessage(null);
    const run = await operation.run("save", () =>
      externalNotificationsEnvironment.updateSettings.run(appAtomRegistry, {
        environmentId,
        input: {
          patch: {
            externalNotifications: {
              destinations: destinationsPatch(current, saved, supportsWebhookOptions),
              ...(snapshot?.revision === undefined ? {} : { revision: snapshot.revision }),
            },
          },
        },
      }),
    );
    if (!run.started) return;
    const result = run.value;
    if (result._tag === "Success") {
      setDrafts(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setMessage({
        id: "save",
        text: describeExternalNotificationCommandFailure(squashAtomCommandFailure(result)),
        ok: false,
      });
    }
  };

  const saveFailure =
    message?.id === "save"
      ? messages[message.text]
      : error !== null
        ? messages[error]
        : canSave
          ? null
          : messages.unauthorized;

  return (
    <View className="mt-3 gap-3">
      {current.map((draft) => {
        const blocked = destinationTestBlocked({ draft, saved, dirty });
        const destinationMessage = message?.id === draft.id ? message : null;
        return (
          <DestinationFields
            key={draft.id}
            draft={draft}
            saved={saved.find((entry) => entry.id === draft.id)}
            locked={locked}
            testing={pending === draft.id}
            supportsWebhookOptions={supportsWebhookOptions}
            canTest={canTest && !locked && online}
            message={
              destinationMessage && {
                text: messages[destinationMessage.text],
                ok: destinationMessage.ok,
              }
            }
            onUpdate={(change) =>
              edit((destinations) =>
                destinations.map((entry) =>
                  entry.id === draft.id ? { ...entry, ...change(entry) } : entry,
                ),
              )
            }
            onTest={() => {
              if (blocked === null) {
                void test(draft.id);
              } else {
                setMessage({ id: draft.id, text: blocked, ok: false });
              }
            }}
            onRemove={() =>
              edit((destinations) => destinations.filter((entry) => entry.id !== draft.id))
            }
          />
        );
      })}
      <ListSection>
        <ListActionRow
          icon="plus"
          label={gt("Add destination")}
          disabled={settings === null || current.length >= MAX_DESTINATIONS || locked}
          onPress={() => {
            const destination = newDestinationDraft(uuidv4(), gt("New destination"));
            edit((destinations) => [...destinations, destination]);
          }}
        />
      </ListSection>
      {dirty ? (
        <View className="gap-2">
          {saveFailure ? <Notice tone="danger" message={saveFailure} /> : null}
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={gt("Save")}
              loading={pending === "save"}
              disabled={error !== null || !canSave || !online || locked}
              onPress={() => void save()}
            />
            <Button
              label={gt("Discard")}
              tone="text"
              disabled={locked}
              onPress={() => edit(null)}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function DestinationFields({
  draft,
  saved,
  locked,
  testing,
  supportsWebhookOptions,
  canTest,
  message,
  onUpdate,
  onTest,
  onRemove,
}: {
  readonly draft: DestinationDraft;
  readonly saved: ExternalNotificationDestination | undefined;
  readonly locked: boolean;
  readonly testing: boolean;
  readonly supportsWebhookOptions: boolean;
  readonly canTest: boolean;
  readonly message: { readonly text: string; readonly ok: boolean } | null;
  readonly onUpdate: (change: (draft: DestinationDraft) => Partial<DestinationDraft>) => void;
  readonly onTest: () => void;
  readonly onRemove: () => void;
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
  const selectedEvents = draft.events ?? DEFAULT_EXTERNAL_NOTIFICATION_EVENTS;
  const adapterActions = Object.entries(adapterLabels).map(([kind, title]): MenuAction => ({
    id: kind,
    title,
    state: draft.kind === kind ? "on" : "off",
  }));
  const eventActions = DEFAULT_EXTERNAL_NOTIFICATION_EVENTS.map((event): MenuAction => ({
    id: event,
    title: eventLabels[event],
    state: selectedEvents.includes(event) ? "on" : "off",
    attributes: { keepsMenuPresented: true },
  }));
  const actions: MenuAction[] = [
    {
      id: "test",
      title: gt("Send test"),
      image: "bell.badge",
      attributes: { disabled: !canTest },
    },
  ];
  if (draft.url.kind === "stored") {
    actions.push({
      id: "clear-url",
      title: gt("Clear webhook URL"),
      attributes: { destructive: true },
    });
  }
  if (
    supportsWebhookOptions &&
    draft.kind === "generic-webhook" &&
    draft.signingKey.kind === "stored"
  ) {
    actions.push({
      id: "clear-key",
      title: gt("Clear signing key"),
      attributes: { destructive: true },
    });
  }
  actions.push({
    id: "remove",
    title: gt("Remove destination"),
    image: "trash",
    attributes: { destructive: true },
  });
  const adapterLabel = adapterLabels[draft.kind];
  const nameLabel = gt("Destination name");
  const eventLabel = gt("Notification events");

  return (
    <ListSection>
      <View className="min-h-16 flex-row items-center gap-2 py-1 pl-4 pr-2">
        <AppTextInput
          accessibilityLabel={nameLabel}
          className="min-h-11 min-w-0 flex-1 border-0 bg-transparent px-0 py-2 text-lg font-t3-semibold text-foreground"
          editable={!locked}
          maxLength={128}
          placeholder={nameLabel}
          value={draft.name}
          onChangeText={(name) => onUpdate(() => ({ name }))}
        />
        <ThemedSwitch
          accessibilityLabel={gt("Enabled")}
          disabled={locked}
          value={draft.enabled}
          onValueChange={(enabled) => onUpdate(() => ({ enabled }))}
        />
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={gt("Destination actions")}
          accessibilityState={{ disabled: locked }}
          actions={locked ? [] : actions}
          onPressAction={({ nativeEvent }) => {
            if (locked) return;
            switch (nativeEvent.event) {
              case "test":
                if (canTest) onTest();
                break;
              case "clear-url":
                onUpdate(() => ({ url: { kind: "clear" } }));
                break;
              case "clear-key":
                onUpdate(() => ({ signingKey: { kind: "clear" } }));
                break;
              case "remove":
                onRemove();
                break;
            }
          }}
        >
          <View className="min-h-11 min-w-11 items-center justify-center">
            <SymbolView
              name="ellipsis"
              size={20}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </View>
        </Menu>
      </View>
      {supportsWebhookOptions ? (
        <>
          <DestinationDivider />
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={gt("Adapter")}
            accessibilityValue={{ text: adapterLabel }}
            accessibilityState={{ disabled: locked }}
            actions={locked ? [] : adapterActions}
            onPressAction={({ nativeEvent }) => {
              const kind = nativeEvent.event;
              if (!locked && (kind === "home-assistant" || kind === "generic-webhook")) {
                onUpdate(() => ({ kind }));
              }
            }}
          >
            <ListRowLayout
              label={gt("Adapter")}
              detail={adapterLabel}
              disabled={locked}
              accessory={<SelectChevron />}
            />
          </Menu>
          <DestinationDivider />
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={gt("Events ({count})", { count: selectedEvents.length })}
            accessibilityState={{ disabled: locked }}
            actions={locked ? [] : eventActions}
            onPressAction={({ nativeEvent }) => {
              const event = DEFAULT_EXTERNAL_NOTIFICATION_EVENTS.find(
                (candidate) => candidate === nativeEvent.event,
              );
              if (locked || event === undefined) return;
              onUpdate((current) => {
                const events = current.events ?? DEFAULT_EXTERNAL_NOTIFICATION_EVENTS;
                return {
                  events: events.includes(event)
                    ? events.filter((entry) => entry !== event)
                    : [...events, event],
                };
              });
            }}
          >
            <ListRowLayout
              label={eventLabel}
              detail={String(selectedEvents.length)}
              disabled={locked}
              accessory={<SelectChevron />}
            />
          </Menu>
        </>
      ) : null}
      <DestinationDivider />
      <CredentialField
        label={gt("Webhook URL")}
        credential={draft.url}
        saved={saved?.webhookUrl}
        disabled={locked}
        onChange={(url) => onUpdate(() => ({ url }))}
      />
      {supportsWebhookOptions && draft.kind === "generic-webhook" ? (
        <>
          <DestinationDivider />
          <CredentialField
            label={gt("Signing key (optional)")}
            credential={draft.signingKey}
            saved={saved?.signingKey}
            disabled={locked}
            onChange={(signingKey) => onUpdate(() => ({ signingKey }))}
          />
        </>
      ) : null}
      {testing || message !== null ? (
        <WorkBlock>
          {testing ? <Notice message={gt("Sending test notification…")} /> : null}
          {message !== null ? (
            <Notice tone={message.ok ? "default" : "danger"} message={message.text} />
          ) : null}
        </WorkBlock>
      ) : null}
    </ListSection>
  );
}

function DestinationDivider() {
  return <View className="mx-4 h-px bg-border-subtle" />;
}

function SelectChevron() {
  return (
    <SymbolView
      name="chevron.down"
      size={12}
      tintColorClassName="accent-icon-muted"
      type="monochrome"
    />
  );
}

function CredentialField({
  label,
  credential,
  saved,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly credential: CredentialDraft;
  readonly saved: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (credential: CredentialDraft) => void;
}) {
  const gt = useGT();
  return (
    <View className="px-4 pt-2.5">
      <Text textRole="footnote" className="text-foreground-muted">
        {label}
      </Text>
      <AppTextInput
        accessibilityLabel={label}
        className="min-h-11 border-0 bg-transparent px-0 pb-2.5 pt-0 text-base text-foreground"
        secureTextEntry
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={
          credential.kind === "stored"
            ? gt("Stored. Enter a new value to replace it.")
            : credential.kind === "clear"
              ? gt("Cleared on save")
              : gt("Enter a value")
        }
        value={credential.kind === "replace" ? credential.value : ""}
        onChangeText={(value) => onChange(credentialDraft(value, saved))}
      />
    </View>
  );
}
