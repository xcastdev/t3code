import { SecureWebView } from "../../native/secureWebView";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import previewStreamScript from "@t3tools/mobile-preview-stream";
import {
  previewStreamControlLabel,
  previewStreamHostSetupMessage,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  type PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId, PreviewStreamHostSetup } from "@t3tools/contracts";
import {
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import type { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

import { AppText } from "../../components/ui/AppText";
import { PdfPreview } from "../../components/PdfPreview";
import {
  createVerifiedViewerBridge,
  verifiedViewerEndpoint,
  viewerUsesVerifiedRoute,
} from "../../lib/verifiedViewerBridge";
import { sendVerifiedChooserFiles } from "./verifiedFileChooser";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { usePreviewStreamAccess } from "../../state/preview";
import { previewPromptText } from "./previewPromptText";

import {
  previewStreamDocument,
  previewStreamMessage,
  type PreviewStreamConfiguration,
} from "./preview-stream-document";

export interface PreviewStreamRef {
  readonly command: (input: PreviewStreamInput) => void;
  readonly paste: () => void;
  readonly togglePictureInPicture: () => void;
}

export interface PreviewPictureInPictureState {
  readonly supported: boolean;
  readonly active: boolean;
}

type NativeStreamBridge = {
  readonly ref?: Ref<PreviewStreamRef>;
  readonly onUnauthorized: () => void;
  /** Asks for fresh access after a refusal, once `delayMs` has passed. */
  readonly onRefused: (delayMs: number) => void;
  readonly onGone?: () => void;
  readonly onViewport?: (viewport: { readonly width: number; readonly height: number }) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  readonly onPictureInPicture?: (state: PreviewPictureInPictureState, detail?: string) => void;
  /** True while frames show, so commands reach the page. */
  readonly onStreamingChange?: (streaming: boolean) => void;
  readonly compact?: boolean;
  readonly pdfUri?: string | null;
};

type AnswerFileChooser = (chooser: PreviewStreamFileChooser, pick: boolean) => void;
type FileChooserListener = (chooser: PreviewStreamFileChooser | null) => void;
type FileChooserOffer = {
  readonly chooser: PreviewStreamFileChooser;
  readonly access: PreviewStreamConfiguration["access"];
};

function resolveChooserEndpoint({ chooser, access }: FileChooserOffer) {
  const verified = viewerUsesVerifiedRoute(access);
  const endpoint = verified ? verifiedViewerEndpoint(access, chooser.uploadUrl, "http") : null;
  if (verified && !endpoint) {
    throw new Error("The browser's file picker URL was refused.");
  }
  return endpoint;
}

async function pickChooserFiles(chooser: PreviewStreamFileChooser, signal: AbortSignal) {
  const { getDocumentAsync } = await import("expo-document-picker");
  signal.throwIfAborted();
  const endHandoff = beginForegroundHandoff();
  try {
    const result = await getDocumentAsync({
      multiple: chooser.multiple,
      copyToCacheDirectory: true,
    });
    return result.canceled ? [] : result.assets;
  } finally {
    endHandoff();
  }
}

async function sendFilesToPage(
  offer: FileChooserOffer,
  files: readonly import("expo-document-picker").DocumentPickerAsset[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const endpoint = resolveChooserEndpoint(offer);
  if (endpoint) return sendVerifiedChooserFiles(endpoint.href, files, signal);
  const { chooser } = offer;
  const body = new FormData();
  for (const asset of files) {
    body.append("file", {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? "application/octet-stream",
    } as unknown as Blob);
  }
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    signal,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

function offerDownload(download: PreviewStreamDownload) {
  Dialog.alert(`Downloaded ${download.fileName}`, undefined, [
    { text: "Not now", style: "cancel" },
    {
      text: "Save or share",
      onPress: () =>
        void downloadAndShareAttachment({
          url: download.url,
          attachment: { name: download.fileName, mimeType: "application/octet-stream" },
          signal: new AbortController().signal,
        }).catch((cause: unknown) =>
          Dialog.alert(
            "Could not save the download",
            cause instanceof Error ? cause.message : undefined,
          ),
        ),
    },
  ]);
}

const MAX_REFUSALS = 3;

export function PreviewStreamWebView({
  beginFileChooserHandoff,
  fileChooserEnabled = true,
  ...props
}: Omit<PreviewStreamConfiguration, "access"> &
  Omit<NativeStreamBridge, "onUnauthorized" | "onRefused"> & {
    readonly environmentId: EnvironmentId;
    readonly paused?: boolean;
    readonly fileChooserEnabled?: boolean;
    readonly beginFileChooserHandoff?: (signal: AbortSignal) => () => void;
  }) {
  const streamAccess = usePreviewStreamAccess(props.environmentId);
  const chooserRequest = useRef<AbortController | null>(null);
  const latestOffer = useRef<FileChooserOffer | null>(null);
  const receiveOffer = useRef<((offer: FileChooserOffer) => void) | null>(null);
  const [chooserAttempt, setChooserAttempt] = useState<{
    readonly access: PreviewStreamConfiguration["access"] | null;
  } | null>(null);
  const canAnswerFileChooser = fileChooserEnabled && !props.compact && !props.paused;
  const access = (canAnswerFileChooser ? chooserAttempt?.access : null) ?? streamAccess.access;
  const { error, refresh, retryAfter } = streamAccess;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the upload on unmount or blur, including while picture-in-picture keeps the preview mounted
  useLayoutEffect(() => {
    if (canAnswerFileChooser) return () => chooserRequest.current?.abort();
  }, [canAnswerFileChooser]);

  const waitForOffer = (signal: AbortSignal) => {
    const { promise, resolve, reject } = Promise.withResolvers<FileChooserOffer>();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => reject(new Error("The page's file picker is no longer open.")),
      20_000,
    );
    receiveOffer.current = resolve;
    // Android can close the issuing socket while DocumentsUI is foregrounded.
    setChooserAttempt({ access: null });
    refresh();
    return promise.finally(() => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (receiveOffer.current === resolve) receiveOffer.current = null;
    });
  };

  if (access && !props.paused) {
    const answerFileChooser: AnswerFileChooser = (chooser, pick) => {
      if (chooserRequest.current) return;
      const request = new AbortController();
      chooserRequest.current = request;
      setChooserAttempt({ access });
      const endHandoff =
        pick && Platform.OS === "android" ? beginFileChooserHandoff?.(request.signal) : undefined;
      const finish = () => {
        if (chooserRequest.current !== request) return;
        request.signal.removeEventListener("abort", finish);
        chooserRequest.current = null;
        setChooserAttempt(null);
        endHandoff?.();
      };
      request.signal.addEventListener("abort", finish, { once: true });
      const answer = async () => {
        const { signal } = request;
        let offer = { chooser, access };
        resolveChooserEndpoint(offer);
        const files = pick ? await pickChooserFiles(chooser, signal) : [];
        signal.throwIfAborted();
        if (pick && Platform.OS === "android") {
          const current = latestOffer.current;
          if (current?.chooser !== chooser) {
            if (chooser.requestId === undefined)
              throw new Error("The page's file picker is no longer open.");
            offer = current ?? (await waitForOffer(signal));
            if (latestOffer.current !== offer || offer.chooser.requestId !== chooser.requestId)
              throw new Error("The page's file picker is no longer open.");
            setChooserAttempt({ access: offer.access });
          }
        }
        await sendFilesToPage(offer, files, signal);
      };
      void answer()
        .catch((cause: unknown) => {
          if (!request.signal.aborted)
            Dialog.alert(
              "Could not send the files to the page",
              cause instanceof Error ? cause.message : undefined,
            );
        })
        .finally(finish);
    };
    return (
      <AuthorizedPreviewStream
        {...props}
        access={access}
        onAnswerFileChooser={
          canAnswerFileChooser && chooserAttempt === null ? answerFileChooser : undefined
        }
        onFileChooser={(chooser) => {
          const offer = chooser === null ? null : { chooser, access };
          latestOffer.current = offer;
          if (offer) receiveOffer.current?.(offer);
        }}
        onGone={() => {
          chooserRequest.current?.abort();
          props.onGone?.();
        }}
        onUnauthorized={refresh}
        onRefused={retryAfter}
      />
    );
  }
  return (
    <View
      className={
        props.compact
          ? "flex-1 items-center justify-center"
          : "flex-1 items-center justify-center gap-4 px-6"
      }
    >
      {props.compact || !error ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
      {!props.compact && (
        <>
          <AppText
            selectable={!!error}
            className={
              error ? "text-center text-sm text-foreground-muted" : "text-sm text-foreground-muted"
            }
          >
            {error || "Connecting to browser..."}
          </AppText>
          {error && (
            <View className="items-center">
              <Button label="Retry" tone="secondary" onPress={refresh} />
            </View>
          )}
        </>
      )}
    </View>
  );
}

function AuthorizedPreviewStream({
  ref,
  ...props
}: PreviewStreamConfiguration &
  NativeStreamBridge & {
    readonly onAnswerFileChooser: AnswerFileChooser | undefined;
    readonly onFileChooser: FileChooserListener;
  }) {
  const [attempt, setAttempt] = useState(0);
  const [previousAccess, setPreviousAccess] = useState(props.access);
  // Wait for refreshed access, including cookie credentials with unchanged JSON.
  if (props.access !== previousAccess) {
    setPreviousAccess(props.access);
    setAttempt((current) => current + 1);
  }
  const processRetried = useRef(false);
  const unauthorized = useRef(0);
  const verified = viewerUsesVerifiedRoute(props.access);
  const configuration = JSON.stringify({
    access: props.access,
    verified,
    threadId: props.threadId,
    tabId: props.tabId,
    interactive: props.interactive,
    background: props.background,
  } satisfies PreviewStreamConfiguration);
  return (
    <PreviewStreamDocumentView
      key={`${attempt}:${configuration}`}
      {...props}
      ref={ref}
      configuration={configuration}
      verified={verified}
      onUnauthorized={() => {
        const refusals = ++unauthorized.current;
        if (refusals >= MAX_REFUSALS) return false;
        props.onRefused(refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1));
        return true;
      }}
      onRetry={() => {
        processRetried.current = false;
        unauthorized.current = 0;
        props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
        unauthorized.current = 0;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((current) => current + 1);
        return true;
      }}
    />
  );
}

function PreviewStreamDocumentView({
  ref,
  configuration,
  access,
  verified,
  background,
  compact,
  pdfUri,
  onUnauthorized,
  onGone,
  onViewport,
  onControl,
  onPictureInPicture,
  onAnswerFileChooser,
  onFileChooser,
  onStreamingChange,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: Omit<NativeStreamBridge, "onUnauthorized" | "onRefused"> & {
  readonly onAnswerFileChooser: AnswerFileChooser | undefined;
  readonly onFileChooser: FileChooserListener;
  readonly configuration: string;
  readonly access: PreviewStreamConfiguration["access"];
  readonly verified: boolean;
  readonly background: string;
  readonly onUnauthorized: () => boolean;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const bridge = useRef<ReturnType<typeof createVerifiedViewerBridge> | null>(null);
  const active = useRef(false);
  const failed = useRef(false);
  const bootstrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const dialogRef = useRef<PreviewStreamControl["dialog"]>(null);
  const [promptText, setPromptText] = useState("");
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const answerFileChooser = (pick: boolean) => {
    const chooser = fileChooser;
    if (!chooser || !onAnswerFileChooser) return;
    setFileChooser(null);
    onAnswerFileChooser(chooser, pick);
  };
  const command = (input: PreviewStreamInput) =>
    webView.current?.injectJavaScript(
      `window.T3PreviewStream?.command(${JSON.stringify(input)}); true;`,
    );
  // Reads here rather than in the screen: a tab switch during the iOS paste prompt unmounts
  // this view and nulls its WebView ref, so the text can never type into another tab.
  const paste = () =>
    void Clipboard.getStringAsync().then(
      (text) => {
        if (text) command({ type: "text", text });
      },
      () => Dialog.alert("Could not read the clipboard"),
    );
  const clearBootstrapTimer = () => {
    if (bootstrapTimer.current === null) return;
    clearTimeout(bootstrapTimer.current);
    bootstrapTimer.current = null;
  };
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    bridge.current?.stop();
    clearBootstrapTimer();
    webView.current?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    onStreamingChange?.(false);
    setControl(null);
    setFileChooser(null);
    onFileChooser(null);
    onControl?.(null);
    setError(message);
    setStatus("error");
  };
  const bootstrapTimedOut = useEffectEvent(() =>
    fail("Browser viewer could not start. Reconnect to try again."),
  );
  const streamEnded = useEffectEvent(() => {
    onStreamingChange?.(false);
    onFileChooser(null);
    onControl?.(null);
  });
  // The stream lives exactly as long as this view.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the bootstrap timeout and stops the WebView stream when this view unmounts
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    if (verified)
      bridge.current = createVerifiedViewerBridge(access, (script) =>
        view?.injectJavaScript(script),
      );
    bootstrapTimer.current = setTimeout(bootstrapTimedOut, 15_000);
    return () => {
      if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
      bootstrapTimer.current = null;
      active.current = false;
      bridge.current?.stop();
      bridge.current = null;
      view?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
      streamEnded();
    };
  }, [access, verified]);
  const source = {
    html: previewStreamDocument(configuration, previewStreamScript, verified),
    baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
  };
  useImperativeHandle(ref, () => ({
    command,
    paste,
    togglePictureInPicture: () =>
      webView.current?.injectJavaScript("window.T3PreviewStream?.pictureInPicture(); true;"),
  }));
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    if (!onRecoverProcess()) fail("Browser viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      {!compact ? (
        <View className="flex-row items-center justify-between gap-2 border-b border-secondary-border px-3 py-2">
          <AppText className="text-xs text-foreground-muted">
            {previewStreamControlLabel(control)}
          </AppText>
          {control?.canOperate ? (
            <Button
              label={control.controller === "you" ? "Release control" : "Take control"}
              tone="secondary"
              disabled={control.controller === "another-viewer"}
              onPress={() =>
                command({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
              }
            />
          ) : null}
        </View>
      ) : null}
      <View className="relative flex-1">
        <SecureWebView
          verified={verified}
          onFenceError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          ref={webView}
          source={source}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          mixedContentMode={verified ? "never" : "always"}
          allowUniversalAccessFromFileURLs={!verified}
          contentInsetAdjustmentBehavior="never"
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          allowsPictureInPictureMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          style={{ flex: 1, backgroundColor: background }}
          onError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onHttpError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onContentProcessDidTerminate={processTerminated}
          onRenderProcessGone={processTerminated}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === source.baseUrl
          }
          onMessage={(event) => {
            if (!active.current || failed.current) return;
            if (bridge.current?.onMessage(event.nativeEvent.data)) return;
            const message = previewStreamMessage(event.nativeEvent.data);
            if (message === null) return;
            switch (message.type) {
              case "control": {
                if (message.controller !== "you") onFileChooser(null);
                setControl(message);
                const previousDialog = dialogRef.current;
                dialogRef.current = message.dialog;
                setPromptText((draft) => previewPromptText(previousDialog, message.dialog, draft));
                onControl?.(message);
                return;
              }
              case "unauthorized":
                if (!onUnauthorized()) {
                  fail("This session can't open the browser stream. Reconnect to try again.");
                }
                return;
              case "gone":
                setGone(true);
                fail("This tab was closed.");
                onGone?.();
                return;
              case "hostSetup":
                setHostSetup({ need: message.need, command: message.command });
                fail(previewStreamHostSetupMessage(message));
                return;
              case "viewport":
                onViewport?.(message);
                return;
              case "clipboard":
                void Clipboard.setStringAsync(message.text).catch(() => undefined);
                return;
              case "download":
                if (!verified || verifiedViewerEndpoint(access, message.url, "http"))
                  offerDownload(message);
                return;
              case "fileChooser":
                onFileChooser(message.chooser);
                setFileChooser(message.chooser);
                return;
              case "pictureInPicture":
                onPictureInPicture?.(message, message.detail);
                return;
              case "status":
                if (message.status !== "connecting") clearBootstrapTimer();
                if (message.status === "error") {
                  fail(message.detail ?? "Browser stream failed.");
                  return;
                }
                setStatus(message.status);
                if (message.status === "connecting") {
                  // Dialogs may have closed and reopened while this viewer was disconnected.
                  dialogRef.current = null;
                  setControl(null);
                  onControl?.(null);
                }
                onStreamingChange?.(message.status === "streaming");
                if (message.status === "streaming") onStreaming();
            }
          }}
        />
        {pdfUri ? (
          <View className="absolute inset-0">
            <PdfPreview key={pdfUri} uri={pdfUri} />
          </View>
        ) : null}
      </View>
      {onAnswerFileChooser && fileChooser && control?.controller === "you" ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">
            The page asks for {fileChooser.multiple ? "files" : "a file"}.
          </AppText>
          <View className="flex-row justify-end gap-3">
            <Button label="Cancel" tone="text" onPress={() => answerFileChooser(false)} />
            <Button
              label={`Choose ${fileChooser.multiple ? "files" : "file"}`}
              tone="secondary"
              onPress={() => answerFileChooser(true)}
            />
          </View>
        </View>
      ) : null}
      {!compact && control?.dialog ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">{control.dialog.message}</AppText>
          {control.controller === "you" ? (
            <>
              {control.dialog.type === "prompt" ? (
                <TextInput
                  accessibilityLabel="Dialog response"
                  className="rounded-lg border border-input-border bg-input px-3 py-2 text-foreground"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  value={promptText}
                  onChangeText={setPromptText}
                />
              ) : null}
              <View className="flex-row justify-end gap-3">
                <Button
                  label="Dismiss"
                  tone="text"
                  onPress={() => command({ type: "dialog", accept: false })}
                />
                <Button
                  label="Accept"
                  tone="secondary"
                  onPress={() =>
                    command({
                      type: "dialog",
                      accept: true,
                      ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                    })
                  }
                />
              </View>
            </>
          ) : (
            <AppText className="text-xs text-foreground-muted">Take control to respond.</AppText>
          )}
        </View>
      ) : null}
      {status !== "streaming" ? (
        <View
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {status === "connecting" ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
          {compact ? null : (
            <AppText
              accessibilityLiveRegion="polite"
              className="text-center text-sm text-foreground-muted"
            >
              {status === "error" ? error : "Connecting to browser..."}
            </AppText>
          )}
          {status === "error" && hostSetup && !compact ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Copy ${hostSetup.command}`}
              className="w-full flex-row items-center gap-2 rounded-xl border border-secondary-border bg-secondary px-4 py-3"
              onPress={() => {
                void Clipboard.setStringAsync(hostSetup.command).catch(() => undefined);
              }}
            >
              <AppText selectable className="flex-1 font-mono text-sm text-secondary-foreground">
                {hostSetup.command}
              </AppText>
              <AppText className="text-xs text-foreground-muted">Copy</AppText>
            </Pressable>
          ) : null}
          {status === "error" && !gone && !compact ? (
            <View className="items-center">
              <Button
                label={hostSetup ? "Try again" : "Reconnect"}
                tone="secondary"
                onPress={onRetry}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
