import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PiDriverConfiguration } from "./PiManagedRuntime.ts";

const decodeConfiguration = Schema.decodeUnknownSync(PiDriverConfiguration);

it("does not invent a model, credential or configuration directory", () => {
  expect(decodeConfiguration({})).toEqual({});
});

it("rejects credential and authority fields through the driver's actual codec", () => {
  for (const field of ["apiKey", "model", "role", "approved", "tools", "endpoint"])
    expect(() =>
      decodeConfiguration({ agentDirectory: "/trusted/pi", [field]: "forged" }),
    ).toThrow();
});

it("rejects ambiguous and unbounded native configuration locations", () => {
  for (const agentDirectory of [
    "",
    " ",
    " /trusted/pi",
    "/trusted/pi ",
    "/pi\0other",
    "x".repeat(4097),
  ])
    expect(() => decodeConfiguration({ agentDirectory })).toThrow();
});

it("retains explicit native directory selection without reading or executing it", () => {
  expect(decodeConfiguration({ agentDirectory: "/trusted/pi" })).toEqual({
    agentDirectory: "/trusted/pi",
  });
});
