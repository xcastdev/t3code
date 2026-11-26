import { expect, it } from "vite-plus/test";

import {
  SELF_HOSTED_RELAY_PUBLISHER_CONTROL_MAX_FRAME_BYTES,
  decodeSelfHostedRelayPublisherControlFrame,
  encodeSelfHostedRelayPublisherControlFrame,
} from "./selfHostedRelayForwarding.ts";

const bytes = new TextEncoder();

it.each(["accepted", "ready", "heartbeat"] as const)(
  "round trips the %s control frame",
  (status) => {
    const frame = { version: 1, status } as const;
    const encoded = encodeSelfHostedRelayPublisherControlFrame(frame);
    expect(encoded).toBe(`{"version":1,"status":"${status}"}\n`);
    expect(decodeSelfHostedRelayPublisherControlFrame(bytes.encode(encoded.slice(0, -1)))).toEqual(
      frame,
    );
  },
);

it.each([
  '{"status":"ready", "version":2}',
  '{"version":1, "status":"other"}',
  '{"version":1, "status":"ready", "address":"private.example"}',
  '{"version":1, "status":"accepted", "statu\\u0073":"ready"}',
  '{"version":1, "status":"ready"}\n',
  '{"version":1, "status":"ready"}'.padEnd(SELF_HOSTED_RELAY_PUBLISHER_CONTROL_MAX_FRAME_BYTES + 1),
])("rejects an invalid control line %j", (value) => {
  expect(decodeSelfHostedRelayPublisherControlFrame(bytes.encode(value))).toBeUndefined();
});

it("rejects invalid UTF-8 and accepts JSON whitespace within the frame bound", () => {
  expect(decodeSelfHostedRelayPublisherControlFrame(Uint8Array.of(0xc0, 0xaf))).toBeUndefined();
  expect(
    decodeSelfHostedRelayPublisherControlFrame(
      bytes.encode(' { "status": "ready", "version": 1 }\r'),
    ),
  ).toEqual({
    version: 1,
    status: "ready",
  });
});
