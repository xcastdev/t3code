import type { ReactNode } from "react";
import { Modal, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";

const SUPPORTED_ORIENTATIONS = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
] as const;

export interface ThreadComposerFullScreenEditorProps {
  readonly visible: boolean;
  readonly title: string;
  readonly onCollapse: () => void;
  readonly onShow: () => void;
  /** iOS: the modal has finished dismissing. */
  readonly onDismiss: () => void;
  readonly sendAction: ReactNode;
  readonly popover: ReactNode;
  /** The composer's editor, bound to the same draft. */
  readonly children: ReactNode;
}

/** The thread composer's draft, edited in a full-screen modal. */
export function ThreadComposerFullScreenEditor(props: ThreadComposerFullScreenEditorProps) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={SUPPORTED_ORIENTATIONS}
      onShow={props.onShow}
      onRequestClose={props.onCollapse}
      onDismiss={props.onDismiss}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A Modal is its own native hierarchy, so measure its own safe area. */}
        <SafeAreaProvider style={{ flex: 1 }}>
          <FullScreenEditorBody {...props} />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

function FullScreenEditorBody(props: ThreadComposerFullScreenEditorProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityViewIsModal
      onAccessibilityEscape={props.onCollapse}
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="flex-row items-center gap-2 px-2">
        <IconButton
          icon="arrow.down.right.and.arrow.up.left"
          accessibilityLabel="Collapse editor"
          onPress={props.onCollapse}
        />
        <AppText
          accessibilityRole="header"
          textRole="headline"
          numberOfLines={1}
          className="min-w-0 flex-1 font-t3-bold text-foreground"
        >
          {props.title}
        </AppText>
        {props.sendAction}
      </View>
      {/* The avoiding view measures its own frame, so the safe area below it is not added twice. */}
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        <View className="flex-1 px-4 pb-2">{props.children}</View>
        {props.popover ? <View className="px-3 pb-2">{props.popover}</View> : null}
      </KeyboardAvoidingView>
      <View style={{ height: insets.bottom }} />
    </View>
  );
}
