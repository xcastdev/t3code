import { describe, expect, it } from "vite-plus/test";

import {
  createExternalNotificationDestination,
  externalNotificationDestinationWith,
} from "./IntegrationsSettings";

const destination = {
  _tag: "home-assistant-webhook",
  id: "home-assistant-primary",
  label: "Home Assistant",
  enabled: true,
  configured: false,
} as const;

describe("external notification destination updates", () => {
  it("updates one descriptor field without inventing a webhook secret", () => {
    expect(
      externalNotificationDestinationWith({
        destination,
        enabled: false,
      }),
    ).toEqual({
      ...destination,
      enabled: false,
    });
  });

  it("rejects a blank destination label at the settings boundary", () => {
    expect(
      externalNotificationDestinationWith({
        destination,
        label: "   ",
      }),
    ).toBeNull();
  });

  it("creates a descriptor from the selected integration type", () => {
    expect(
      createExternalNotificationDestination({
        type: "home-assistant-webhook",
        id: "external-notification-new",
        label: "Home Assistant",
        enabled: true,
      }),
    ).toEqual({
      _tag: "home-assistant-webhook",
      id: "external-notification-new",
      label: "Home Assistant",
      enabled: true,
      configured: false,
    });
  });
});
