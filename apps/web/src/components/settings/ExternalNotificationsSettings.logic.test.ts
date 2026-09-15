import { describe, expect, it } from "vite-plus/test";

import { homeAssistantNotificationDestination } from "./IntegrationsSettings.tsx";

describe("homeAssistantNotificationDestination", () => {
  it("keeps a webhook write-only until the user supplies a replacement", () => {
    expect(homeAssistantNotificationDestination({ enabled: true })).toEqual({
      _tag: "home-assistant-webhook",
      id: "home-assistant",
      label: "Home Assistant",
      enabled: true,
      configured: false,
    });
    expect(
      homeAssistantNotificationDestination({
        enabled: true,
        webhookUrl: "https://home.example.test/api/webhook/token",
      }),
    ).toMatchObject({
      configured: true,
      webhookUrl: "https://home.example.test/api/webhook/token",
    });
  });
});
