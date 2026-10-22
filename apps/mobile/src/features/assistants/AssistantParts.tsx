import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { useNavigation } from "@react-navigation/native";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { buildModelOptions } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import type { AssistantTone } from "@t3tools/client-runtime/assistant-presentation";

export const TONE_PREFIX: Record<AssistantTone, string> = {
  neutral: "",
  info: "",
  success: "",
  warning: "⚠︎ ",
  danger: "⚠︎ ",
};

/**
 * The environment's actual models, the same options the composer offers.
 * Collapsed to the current choice until opened, so long catalogs stay off screen.
 */
export function AssistantModelChoice(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection | null;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const options = useMemo(
    () =>
      buildModelOptions(config, props.selection, undefined, null).filter(
        (option) => !option.isHidden && !option.isUnavailable,
      ),
    [config, props.selection],
  );
  const [open, setOpen] = useState(false);
  const selected = options.find(
    (option) =>
      option.selection.instanceId === props.selection?.instanceId &&
      option.selection.model === props.selection.model,
  );
  return (
    <>
      <ListRow
        icon="sparkles"
        label="Model"
        detail={selected ? `${selected.providerLabel} · ${selected.label}` : "Choose a model"}
        disabled={props.disabled}
        onPress={() => setOpen((value) => !value)}
      />
      {open
        ? options.map((option) => (
            <ListChoiceRow
              key={option.key}
              label={option.label}
              description={option.providerLabel}
              selected={option === selected}
              disabled={props.disabled}
              onPress={() => {
                // Provider options belong to the previous instance; a new one starts clean.
                props.onChange(
                  props.selection?.instanceId === option.selection.instanceId
                    ? { ...props.selection, model: option.selection.model }
                    : option.selection,
                );
                setOpen(false);
              }}
            />
          ))
        : null}
    </>
  );
}

/** A labelled field that locks while its form is saving, so later typing is never discarded. */
export function AgentInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly numeric?: boolean;
  readonly placeholder?: string;
}) {
  return (
    <View className="gap-1.5">
      <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
        {props.label}
      </Text>
      <AppTextInput
        accessibilityLabel={props.label}
        className="min-h-11 rounded-xl border-continuous bg-card px-3 py-2.5 text-base text-foreground"
        value={props.value}
        onChangeText={props.onChange}
        editable={props.disabled !== true}
        multiline={props.multiline}
        maxLength={props.maxLength ?? 4000}
        autoCapitalize={props.numeric ? "none" : "sentences"}
        textAlignVertical={props.multiline ? "top" : "center"}
        {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
        {...(props.numeric ? { keyboardType: "number-pad" as const } : {})}
      />
    </View>
  );
}

export function useOpenAgentChat() {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  return (destination: { readonly environmentId: string; readonly threadId: string }) => {
    if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params: destination });
    else navigation.navigate("Thread", destination);
  };
}
