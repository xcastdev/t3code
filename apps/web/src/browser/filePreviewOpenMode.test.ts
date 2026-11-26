import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const relayOrigin = "https://relay.example.test";
const appOrigin = "https://app.example.test";

it.each(["hosted", "electron"] as const)(
  "selects guarded documents for an explicitly paired %s relay with filesystem read access",
  async (client) => {
    vi.resetModules();
    vi.stubEnv(
      "VITE_VERIFIED_BROWSER_ROUTE",
      JSON.stringify({
        environmentId: EnvironmentId.make("paired-environment"),
        httpsOrigin: relayOrigin,
        transportRole: "relay",
      }),
    );
    vi.stubGlobal("window", {
      location: { origin: appOrigin, href: appOrigin },
      ...(client === "electron"
        ? { desktopBridge: { relayTransport: { origins: [relayOrigin] } } }
        : {}),
    });
    try {
      const { filePreviewOpenMode } = await import("./filePreviewOpenMode");
      const readOnly = {
        httpBaseUrl: relayOrigin,
        canReadFiles: true,
        canOperatePreview: false,
        previewAvailable: false,
      };
      expect(filePreviewOpenMode({ ...readOnly, path: "index.html" })).toBe("admitted-document");
      expect(filePreviewOpenMode({ ...readOnly, path: "diagram.svg" })).toBe("admitted-document");
      expect(
        filePreviewOpenMode({ ...readOnly, path: "index.html", canReadFiles: false }),
      ).toBeNull();
      expect(filePreviewOpenMode({ ...readOnly, path: "report.pdf" })).toBeNull();
      const direct = {
        ...readOnly,
        httpBaseUrl: "https://direct.example.test",
        previewAvailable: true,
      };
      expect(filePreviewOpenMode({ ...direct, path: "index.html" })).toBeNull();
      expect(filePreviewOpenMode({ ...direct, path: "report.pdf", canOperatePreview: true })).toBe(
        "browser",
      );
      expect(
        filePreviewOpenMode({ ...direct, path: "diagram.svg", canOperatePreview: true }),
      ).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
