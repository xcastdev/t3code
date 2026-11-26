import { verificationRequiredFor } from "../connection/verified-route";
import { SecureWebView } from "../native/secureWebView";
import { useState } from "react";
import { View } from "react-native";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";
import { useVerifiedLocalAsset } from "../lib/useVerifiedLocalAsset";
import { webViewDecelerationRate } from "../lib/webViewDecelerationRate";

export function PdfPreview(props: { readonly uri: string; readonly verifiedLocal?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const downloaded = useVerifiedLocalAsset(props.verifiedLocal ? null : props.uri);
  const local = props.verifiedLocal ? { status: "ready" as const, uri: props.uri } : downloaded;
  const verified = props.verifiedLocal || verificationRequiredFor(props.uri);
  if (local.status === "failed")
    return (
      <FilePreviewNotice title="Could not load PDF">
        The PDF could not be downloaded.
      </FilePreviewNotice>
    );
  if (local.status !== "ready")
    return <FilePreviewLoading message="Loading PDF..." background="card" />;
  return (
    <View className="flex-1 bg-card">
      {error ? <FilePreviewNotice title="Could not load PDF">{error}</FilePreviewNotice> : null}
      <SecureWebView
        verified={verified}
        onFenceError={() => setError("The PDF could not be loaded.")}
        source={{ uri: local.uri }}
        javaScriptEnabled={!verified}
        originWhitelist={["*"]}
        automaticallyAdjustContentInsets={false}
        decelerationRate={webViewDecelerationRate}
        contentInsetAdjustmentBehavior="never"
        startInLoadingState
        onError={(event) =>
          setError(event.nativeEvent.description || "The PDF could not be loaded.")
        }
        onHttpError={(event) =>
          setError(`The server returned HTTP ${event.nativeEvent.statusCode}.`)
        }
        renderLoading={() => <FilePreviewLoading message="Loading PDF..." background="card" />}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
