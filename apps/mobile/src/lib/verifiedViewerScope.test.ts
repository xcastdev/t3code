import { expect, it } from "vite-plus/test";

import { viewerEndpoint } from "./verifiedViewerScope";

it("binds every viewer request to the issuer, media path and original ticket", () => {
  const access = {
    httpBase: "https://relay.test:8443/api/device-hub",
    wsBase: "wss://relay.test:8443/api/device-hub",
    query: { wsTicket: "signed+ticket" },
    credentials: false,
  };
  const endpoint = "wss://relay.test:8443/api/device-hub/vendor/ws?wsTicket=signed%2Bticket";
  expect(viewerEndpoint(access, endpoint, "ws")?.href).toBe(endpoint);
  for (const candidate of [
    endpoint.replace(":8443", ""),
    endpoint.replace("wss:", "https:"),
    endpoint.replace("relay.test", "unverified.test"),
    endpoint.replace("/api/device-hub/", "/api/device-hub-other/"),
    endpoint.replace("/vendor/ws", "/../vendor/ws"),
    endpoint + "&wsTicket=signed%2Bticket",
    endpoint.replace("signed%2Bticket", "replacement"),
  ])
    expect(viewerEndpoint(access, candidate, "ws")).toBeNull();
  expect(viewerEndpoint({ ...access, credentials: true }, endpoint, "ws")).toBeNull();
});
