/**
 * Integrations settings - preferences for surfaces T3 Code embeds rather than
 * owns. Browser is the first section: the defaults a preview tab opens at,
 * applied to both hand-opened tabs and agent `preview_open` calls that don't
 * state their own size.
 *
 * @module IntegrationsSettings
 */
import {
  BROWSER_RECORDING_FRAME_RATES,
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
  ExternalNotificationDestination,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { InfoIcon, MonitorIcon, PlugIcon, SendIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSessionState } from "../../state/session";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

/**
 * The size a "Responsive" default falls back to when the user switches away
 * from Fill and hasn't typed dimensions yet. Fill has no dimensions to carry
 * over, so the picker needs something concrete to seed the inputs with.
 */
const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`;

const viewportSelectValue = (viewport: PreviewViewportSetting): string => {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  ) {
    return viewport.presetId;
  }
  return RESPONSIVE_VALUE;
};

/**
 * The trigger renders this rather than a bare `SelectValue`, which would fall
 * back to printing the raw stored value ("fill") because the options are built
 * inline instead of from an `items` map.
 */
const viewportSelectLabel = (viewport: PreviewViewportSetting): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return "Fill panel";
  if (value === RESPONSIVE_VALUE) return "Responsive";
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? "Responsive";
};

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

/**
 * A sized viewport with width and height swapped. Presets keep their identity
 * through a rotation — `resolvePreviewViewport` already stores rotated presets
 * as the preset id plus swapped dimensions — so a rotated iPad is still an
 * iPad, not an anonymous custom size.
 */
const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});

function BrowserViewportSetting({ disabled }: { readonly disabled: boolean }) {
  const viewport = useClientSettings((settings) => settings.browserDefaultViewport);
  const updateSettings = useUpdatePrimarySettings();

  const sized = viewport._tag === "fill" ? null : viewport;
  const presentedSize = {
    width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
    height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
  };

  const selectViewport = (value: string | null) => {
    if (value === FILL_VALUE) {
      updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT });
      return;
    }
    if (value === RESPONSIVE_VALUE) {
      updateSettings({
        browserDefaultViewport: {
          _tag: "freeform",
          width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
          height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
        },
      });
      return;
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateSettings({
      browserDefaultViewport: {
        _tag: "preset",
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      },
    });
  };

  // Committed on blur rather than per keystroke: typing "2560" passes through
  // "256", which is a legal dimension, so an onValueChange handler would
  // persist that intermediate size and churn the settings file on every key.
  const commitDimension = (axis: "width" | "height", value: number | null) => {
    if (value === null || !isValidDimension(value)) return;
    const next = { ...presentedSize, [axis]: value };
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return;
    if (sized && next.width === sized.width && next.height === sized.height) return;
    // Typing a size means the preset no longer describes it.
    updateSettings({ browserDefaultViewport: { _tag: "freeform", ...next } });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-default-viewport")}
      description="The viewport a browser tab opens at, for both you and agents. Fill sizes the page to the panel; any other choice opens the device toolbar at that size."
      resetAction={
        !disabled && viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label="default browser viewport"
            onClick={() => updateSettings({ browserDefaultViewport: DEFAULT_BROWSER_VIEWPORT })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Select
            value={viewportSelectValue(viewport)}
            onValueChange={selectViewport}
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-44"
              aria-label="Default browser viewport"
            >
              <SelectValue>{viewportSelectLabel(viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-64">
              <SelectItem value={FILL_VALUE}>Fill panel</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>Responsive</SelectItem>
              <SelectGroup>
                <SelectGroupLabel>Standard</SelectGroupLabel>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{preset.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {preset.detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>

          {sized ? (
            <div className="flex min-w-0 items-center gap-1">
              <NumberField
                value={presentedSize.width}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                // Pixel counts read as raw numbers; grouping would show "1,024".
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("width", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport width" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
              <NumberField
                value={presentedSize.height}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("height", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport height" />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      aria-label={`Rotate to ${
                        presentedSize.height >= presentedSize.width ? "landscape" : "portrait"
                      }`}
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Rotate</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function BrowserZoomSetting({ disabled }: { readonly disabled: boolean }) {
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-zoom")}
      description="Page zoom applied to new browser tabs."
      resetAction={
        !disabled && zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label="default browser zoom"
            onClick={() =>
              updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(zoomFactor)}
          onValueChange={(value) => {
            const next = PREVIEW_ZOOM_LEVELS.find((level) => String(level) === value);
            if (next !== undefined) updateSettings({ browserDefaultZoomFactor: next });
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser zoom">
            <SelectValue>{zoomLabel(zoomFactor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PREVIEW_ZOOM_LEVELS.map((level) => (
              <SelectItem hideIndicator key={level} value={String(level)}>
                {zoomLabel(level)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserAppearanceSetting({ disabled }: { readonly disabled: boolean }) {
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-appearance")}
      description="The color scheme pages are told to prefer. System follows your OS setting."
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label="default browser appearance"
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={appearance}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") {
              updateSettings({ browserDefaultAppearance: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser appearance">
            <SelectValue>{APPEARANCE_LABELS[appearance]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserRecordingFrameRateSetting({ disabled }: { readonly disabled: boolean }) {
  const frameRate = useClientSettings((settings) => settings.browserRecordingFrameRate);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-recording-frame-rate")}
      description="Maximum frame rate for browser recordings. 30 fps is the default and uses less CPU and storage; 60 fps captures smoother motion."
      resetAction={
        !disabled && frameRate !== DEFAULT_BROWSER_RECORDING_FRAME_RATE ? (
          <SettingResetButton
            label="browser recording frame rate"
            onClick={() =>
              updateSettings({ browserRecordingFrameRate: DEFAULT_BROWSER_RECORDING_FRAME_RATE })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(frameRate)}
          onValueChange={(value) => {
            const next = BROWSER_RECORDING_FRAME_RATES.find((rate) => String(rate) === value);
            if (next !== undefined) {
              updateSettings({ browserRecordingFrameRate: next });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Browser recording frame rate">
            <SelectValue>{frameRate} fps</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {BROWSER_RECORDING_FRAME_RATES.map((rate) => (
              <SelectItem hideIndicator key={rate} value={String(rate)}>
                {rate} fps
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function AgentBrowserAccessSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("agent-browser-access")}
      description="Let agents open and drive the preview browser. When off, the browser tools and the instructions describing them are withheld from agent sessions. Your own browser panel is unaffected."
      status={
        settings.enableAgentBrowserAccess
          ? undefined
          : "Applies to sessions started from now on; a running agent keeps the tools it was given."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="agent browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
          }
          aria-label="Allow agent browser access"
        />
      }
    />
  );
}

function BrowserAutoShowFloatingPreviewSetting({ disabled }: { readonly disabled: boolean }) {
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-auto-show-floating-preview")}
      description="Pop the floating preview into view when an agent opens a browser. An agent that explicitly asks to show or hide its preview still gets what it asked for."
      resetAction={
        !disabled && autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label="auto-show floating preview"
            onClick={() =>
              updateSettings({
                browserAutoShowFloatingPreview: DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={autoShow}
          onCheckedChange={(checked) =>
            updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
          }
          aria-label="Auto-show floating preview"
        />
      }
    />
  );
}

/**
 * Frames the client-local preview defaults as one unavailable block.
 *
 * Disabling each control on its own left the labels and descriptions at full
 * strength, so the group still read as editable. Boxing it puts the reason at
 * the top and dims everything it covers, which is also why the explanation
 * sits outside the dimmed area — the one part that must stay readable is the
 * part saying why the rest isn't.
 *
 * Disabled rather than hidden because these are *client* settings: editing
 * them from a browser tab would write preferences belonging to a different
 * client, reading as though the desktop app had been configured when it
 * hadn't.
 */
function DesktopOnlyBrowserDefaults({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>Only available in the desktop app.</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  );
}

export function IntegrationsSettingsPanel() {
  // Client-local preview defaults are editable only where the preview exists.
  const previewDefaultsDisabled = !isElectron;
  const previewDefaults = (
    <>
      <BrowserViewportSetting disabled={previewDefaultsDisabled} />
      <BrowserZoomSetting disabled={previewDefaultsDisabled} />
      <BrowserAppearanceSetting disabled={previewDefaultsDisabled} />
      <BrowserRecordingFrameRateSetting disabled={previewDefaultsDisabled} />
      <BrowserAutoShowFloatingPreviewSetting disabled={previewDefaultsDisabled} />
    </>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="browser" title="Browser">
        {/* Server-authoritative, so it stays editable on every client and sits
            outside the block covering the desktop-only defaults. */}
        <AgentBrowserAccessSetting />
        {previewDefaultsDisabled ? (
          <DesktopOnlyBrowserDefaults>{previewDefaults}</DesktopOnlyBrowserDefaults>
        ) : (
          previewDefaults
        )}
      </SettingsSection>
      <ExternalNotificationsSettings />
    </SettingsPageContainer>
  );
}

const decodeExternalNotificationDestination = Schema.decodeUnknownOption(
  ExternalNotificationDestination,
);

type ExternalNotificationDestinationTag = ExternalNotificationDestination["_tag"];

const EXTERNAL_NOTIFICATION_DESTINATION_OPTIONS = [
  {
    value: "home-assistant-webhook",
    label: "Home Assistant",
    description: "Send agent activity to a Home Assistant webhook.",
  },
] as const satisfies ReadonlyArray<{
  readonly value: ExternalNotificationDestinationTag;
  readonly label: string;
  readonly description: string;
}>;

const LEGACY_GENERIC_DESTINATION_LABEL = "External notification";

const externalNotificationDestinationTagLabel = (tag: ExternalNotificationDestinationTag): string =>
  EXTERNAL_NOTIFICATION_DESTINATION_OPTIONS.find((option) => option.value === tag)?.label ?? tag;

function isExternalNotificationDestinationTag(
  value: string | null,
): value is ExternalNotificationDestinationTag {
  return (
    value !== null &&
    EXTERNAL_NOTIFICATION_DESTINATION_OPTIONS.some((option) => option.value === value)
  );
}

export function createExternalNotificationDestination(input: {
  readonly type: ExternalNotificationDestinationTag;
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}): ExternalNotificationDestination | null {
  switch (input.type) {
    case "home-assistant-webhook": {
      const decoded = decodeExternalNotificationDestination({
        _tag: input.type,
        id: input.id,
        label: input.label,
        enabled: input.enabled,
        configured: false,
      });
      return Option.isSome(decoded) ? decoded.value : null;
    }
  }
  const _exhaustive: never = input.type;
  return _exhaustive;
}

export function externalNotificationDestinationWith(input: {
  readonly destination: ExternalNotificationDestination;
  readonly label?: string;
  readonly enabled?: boolean;
  readonly webhookUrl?: string;
}): ExternalNotificationDestination | null {
  const destination = input.destination;
  const decoded = decodeExternalNotificationDestination({
    ...destination,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.webhookUrl === undefined ? {} : { webhookUrl: input.webhookUrl }),
  });
  return Option.isSome(decoded) ? decoded.value : null;
}

function ExternalNotificationsUnavailableRow({
  environment,
  access,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly deviceTabs: ReactNode;
}) {
  const title =
    access.kind === "loading"
      ? "Loading external notifications"
      : access.kind === "error"
        ? "Could not connect to this device"
        : "External notifications are unavailable";
  const description =
    access.kind === "loading"
      ? "Checking what this session is allowed to change."
      : connectionStatusText(environment.connection);
  return (
    <SettingsSection title="External notifications">
      {deviceTabs}
      <SettingsRow title={title} description={description} />
    </SettingsSection>
  );
}

export function ExternalNotificationDestinationCard({
  destination,
  readOnly,
  onChange,
  onChangeType,
  onRemove,
  onTest,
}: {
  readonly destination: ExternalNotificationDestination;
  readonly readOnly: boolean;
  readonly onChange: (destination: ExternalNotificationDestination) => void;
  readonly onChangeType: (type: ExternalNotificationDestinationTag, label: string) => void;
  readonly onRemove: () => void | Promise<void>;
  readonly onTest: () => Promise<void>;
}) {
  const [label, setLabel] = useState(destination.label);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const commitLabel = () => {
    if (label.trim() === "" || label === destination.label) {
      setLabel(destination.label);
      return;
    }
    const next = externalNotificationDestinationWith({ destination, label });
    if (next === null) {
      setLabel(destination.label);
      return;
    }
    onChange(next);
  };

  const saveWebhookUrl = () => {
    const next = externalNotificationDestinationWith({ destination, webhookUrl });
    if (next === null || webhookUrl.trim() === "") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Webhook URL is required",
          description: "Paste a valid Home Assistant webhook URL before saving.",
        }),
      );
      return;
    }
    onChange(next);
    setWebhookUrl("");
  };

  const testDestination = async () => {
    setTesting(true);
    try {
      await onTest();
    } finally {
      setTesting(false);
    }
  };

  const changeDestinationType = (value: string | null) => {
    if (!isExternalNotificationDestinationTag(value) || value === destination._tag) return;
    setWebhookUrl("");
    onChangeType(value, label.trim());
  };

  const destinationEditor = renderExternalNotificationDestinationEditor({
    destination,
    readOnly,
    webhookUrl,
    onWebhookUrlChange: setWebhookUrl,
    onSaveWebhookUrl: saveWebhookUrl,
  });
  const integrationId = `${destination.id}-integration`;
  const nameId = `${destination.id}-name`;

  return (
    <>
      <div className="rounded-xl border border-border/70 bg-muted/10 p-3 sm:p-4">
        <div className="flex items-start gap-3">
          <PlugIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <label
                className="block text-xs font-medium text-muted-foreground"
                htmlFor={integrationId}
              >
                Integration
              </label>
              <Select
                value={destination._tag}
                disabled={readOnly}
                onValueChange={changeDestinationType}
              >
                <SelectTrigger
                  id={integrationId}
                  size="sm"
                  className="w-full sm:w-52"
                  aria-label={`${destination.label} notification integration`}
                >
                  <SelectValue>
                    {externalNotificationDestinationTagLabel(destination._tag)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" className="min-w-64">
                  {EXTERNAL_NOTIFICATION_DESTINATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <label className="block text-xs font-medium text-muted-foreground" htmlFor={nameId}>
                  Name
                </label>
                <Input
                  id={nameId}
                  aria-label={`${destination.label} destination name`}
                  className="w-full max-w-64"
                  size="sm"
                  value={label}
                  disabled={readOnly}
                  onChange={(event) => setLabel(event.target.value)}
                  onBlur={commitLabel}
                />
              </div>
              <Switch
                checked={destination.enabled}
                disabled={readOnly}
                aria-label={`${destination.label} enabled`}
                onCheckedChange={(checked) => {
                  const next = externalNotificationDestinationWith({
                    destination,
                    enabled: Boolean(checked),
                  });
                  if (next !== null) onChange(next);
                }}
              />
            </div>
            {destinationEditor.fields}
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">Actions</span>
              <div className="flex flex-wrap items-center gap-2">
                {destinationEditor.saveAction}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={readOnly || !destination.configured || testing}
                  onClick={() => void testDestination()}
                >
                  <SendIcon className="size-3.5" aria-hidden />
                  {testing ? "Testing…" : "Test"}
                </Button>
                <Button
                  size="icon-sm"
                  variant="destructive-outline"
                  disabled={readOnly}
                  onClick={() => setDeleteConfirmOpen(true)}
                  aria-label={`Remove ${destination.label}`}
                >
                  <Trash2Icon className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{destination.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the destination and its stored secret. Future notifications will no
              longer be sent to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteConfirmOpen(false);
                void onRemove();
              }}
            >
              Delete destination
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function renderExternalNotificationDestinationEditor({
  destination,
  readOnly,
  webhookUrl,
  onWebhookUrlChange,
  onSaveWebhookUrl,
}: {
  readonly destination: ExternalNotificationDestination;
  readonly readOnly: boolean;
  readonly webhookUrl: string;
  readonly onWebhookUrlChange: (value: string) => void;
  readonly onSaveWebhookUrl: () => void;
}) {
  const destinationTag = destination._tag;
  switch (destinationTag) {
    case "home-assistant-webhook":
      return {
        fields: (
          <>
            <p className="text-xs text-muted-foreground">
              Home Assistant webhook ·{" "}
              {destination.configured
                ? "Webhook URL saved securely."
                : "No webhook URL configured."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Replace ${destination.label} webhook URL`}
                className="min-w-64 flex-1 sm:max-w-md"
                size="sm"
                type="url"
                value={webhookUrl}
                disabled={readOnly}
                placeholder="Paste a new webhook URL to replace the saved one"
                autoComplete="off"
                onChange={(event) => onWebhookUrlChange(event.target.value)}
              />
            </div>
          </>
        ),
        saveAction: (
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || webhookUrl.trim() === ""}
            onClick={onSaveWebhookUrl}
          >
            Save
          </Button>
        ),
      };
  }
  const _exhaustive: never = destinationTag;
  return _exhaustive;
}

export function EnvironmentExternalNotificationsSettings({
  environmentId,
  environmentLabel,
  readOnly,
  deviceTabs,
}: {
  readonly environmentId: EnvironmentPresentation["environmentId"];
  readonly environmentLabel: string;
  readonly readOnly: boolean;
  readonly deviceTabs: ReactNode;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const testExternalNotification = useAtomCommand(serverEnvironment.testExternalNotification, {
    reportFailure: false,
  });
  const destinations = settings.externalNotifications.destinations;

  const saveSettings = async (patch: ServerSettingsPatch): Promise<boolean> => {
    const result = await updateServerSettings({
      environmentId,
      input: { patch },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save external notification settings",
          description:
            error instanceof Error ? error.message : "The server rejected the settings update.",
        }),
      );
      return false;
    }
    return result._tag === "Success";
  };

  const updateDestination = (nextDestination: ExternalNotificationDestination) => {
    void saveSettings({
      externalNotifications: {
        destinations: destinations.map((destination) =>
          destination.id === nextDestination.id ? nextDestination : destination,
        ),
      },
    });
  };

  const updateDestinationType = (
    destinationId: string,
    type: ExternalNotificationDestinationTag,
    label: string,
  ) => {
    const current = destinations.find((destination) => destination.id === destinationId);
    if (!current || current._tag === type) return;
    const currentDefaultLabel = externalNotificationDestinationTagLabel(current._tag);
    const nextLabel =
      label === currentDefaultLabel || label === LEGACY_GENERIC_DESTINATION_LABEL
        ? externalNotificationDestinationTagLabel(type)
        : label || current.label;
    const nextDestination = createExternalNotificationDestination({
      type,
      id: `external-notification-${Date.now()}`,
      label: nextLabel,
      enabled: current.enabled,
    });
    if (nextDestination === null) return;
    void saveSettings({
      externalNotifications: {
        destinations: destinations.map((destination) =>
          destination.id === destinationId ? nextDestination : destination,
        ),
      },
    });
  };

  const removeDestination = async (destinationId: string) => {
    const removedDestination = destinations.find((destination) => destination.id === destinationId);
    if (removedDestination === undefined) return;
    const saved = await saveSettings({
      externalNotifications: {
        destinations: destinations.filter((destination) => destination.id !== destinationId),
      },
    });
    if (!saved) return;
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "External notification deleted",
        description: "Its stored secret was removed.",
        timeout: 5_000,
      }),
    );
  };

  const addDestination = () => {
    const destination = createExternalNotificationDestination({
      type: "home-assistant-webhook",
      id: `external-notification-${Date.now()}`,
      label: externalNotificationDestinationTagLabel("home-assistant-webhook"),
      enabled: true,
    });
    if (destination === null) return;
    void saveSettings({
      externalNotifications: {
        destinations: [...destinations, destination],
      },
    });
  };

  const testDestination = async (destinationId: string) => {
    const result = await testExternalNotification({
      environmentId,
      input: { destinationId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "External notification test failed",
          description:
            error instanceof Error ? error.message : "The destination could not be reached.",
        }),
      );
      return;
    }
    if (result._tag === "Success") {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Test notification sent",
          description: `${environmentLabel} delivered a test event to Home Assistant.`,
        }),
      );
    }
  };

  return (
    <SettingsSection title="External notifications">
      {deviceTabs}
      <SettingsRow
        title="App link scheme"
        description="The app scheme used in notification links. Use the preview scheme when testing a preview build."
        control={
          <Select
            value={settings.externalNotifications.appScheme}
            disabled={readOnly}
            onValueChange={(value) => {
              if (value === "t3code-dev" || value === "t3code-preview" || value === "t3code") {
                void saveSettings({ externalNotifications: { appScheme: value } });
              }
            }}
          >
            <SelectTrigger
              className="w-full sm:w-44"
              aria-label="External notification app link scheme"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end">
              <SelectItem value="t3code-dev">Development</SelectItem>
              <SelectItem value="t3code-preview">Preview</SelectItem>
              <SelectItem value="t3code">Production</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <div className="space-y-3 px-3 pb-3 sm:px-4 sm:pb-4">
        {destinations.map((destination) => (
          <ExternalNotificationDestinationCard
            key={destination.id}
            destination={destination}
            readOnly={readOnly}
            onChange={updateDestination}
            onChangeType={(type, label) => updateDestinationType(destination.id, type, label)}
            onRemove={() => removeDestination(destination.id)}
            onTest={() => testDestination(destination.id)}
          />
        ))}
        <Button size="sm" variant="outline" disabled={readOnly} onClick={addDestination}>
          Add external notification
        </Button>
      </div>
    </SettingsSection>
  );
}

export function AccessGatedExternalNotificationsSettings({
  environment,
  operateAccess,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs: ReactNode;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <ExternalNotificationsUnavailableRow
        environment={environment}
        access={access}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <EnvironmentExternalNotificationsSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      deviceTabs={deviceTabs}
    />
  );
}

function PrimarySessionExternalNotificationsSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs: ReactNode;
}) {
  const session = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return (
    <AccessGatedExternalNotificationsSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
    />
  );
}

function RemoteSessionExternalNotificationsSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs: ReactNode;
}) {
  const session = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return (
    <AccessGatedExternalNotificationsSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
    />
  );
}

function SelectedExternalNotificationsSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs: ReactNode;
}) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") {
    return isElectron ? (
      <AccessGatedExternalNotificationsSettings
        environment={environment}
        operateAccess="granted"
        deviceTabs={deviceTabs}
      />
    ) : (
      <PrimarySessionExternalNotificationsSettings
        environment={environment}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <RemoteSessionExternalNotificationsSettings environment={environment} deviceTabs={deviceTabs} />
  );
}

export function ExternalNotificationsSettings() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<
    EnvironmentPresentation["environmentId"] | null
  >(primaryEnvironmentId);
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const deviceTabs =
    options.length > 1 ? (
      <div
        role="tablist"
        aria-label="Notification settings devices"
        className="flex gap-1 overflow-x-auto border-b border-border/70 px-3 py-2 sm:px-4"
      >
        {options.map((environment) => (
          <button
            key={environment.environmentId}
            type="button"
            role="tab"
            aria-selected={environment.environmentId === effectiveEnvironmentId}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground aria-selected:bg-muted aria-selected:text-foreground"
            onClick={() => setSelectedEnvironmentId(environment.environmentId)}
          >
            {environment.entry.target._tag === "PrimaryConnectionTarget" ? (
              <MonitorIcon className="size-3.5" aria-hidden />
            ) : null}
            {environment.label}
          </button>
        ))}
      </div>
    ) : null;

  if (selectedEnvironment === null) {
    return (
      <SettingsSection title="External notifications">
        <SettingsRow
          title={isReady ? "No connected devices" : "Loading devices"}
          description={
            isReady
              ? "Connect an execution environment before configuring notifications."
              : "Reading connected execution environments."
          }
        />
      </SettingsSection>
    );
  }
  return (
    <SelectedExternalNotificationsSettings
      environment={selectedEnvironment}
      deviceTabs={deviceTabs}
    />
  );
}
