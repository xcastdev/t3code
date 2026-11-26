import * as Schema from "effect/Schema";

import { SelfHostedRelayEnrolledEnvironment } from "./selfHostedRelay.ts";

export const SELF_HOSTED_RELAY_DIRECTORY_MAX_HINTS = 16;
export const SELF_HOSTED_RELAY_DIRECTORY_MAX_URL_LENGTH = 512;

const strictStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const keys = new Set(Object.keys(fields));
  return Schema.Record(Schema.String, Schema.Unknown)
    .check(
      Schema.makeFilter((value) => Object.keys(value).every((key) => keys.has(key)), {
        expected: "an object containing only the declared fields",
      }),
    )
    .pipe(Schema.decodeTo(Schema.Struct(fields)));
};

const originUrl = Schema.String.check(
  Schema.isMaxLength(SELF_HOSTED_RELAY_DIRECTORY_MAX_URL_LENGTH),
  Schema.isPattern(/^https?:\/\/[A-Za-z0-9.:[\]-]+\/?$/u),
  Schema.makeFilter((value) => URL.canParse(value), { expected: "an HTTP or HTTPS origin URL" }),
);
const httpsOriginUrl = originUrl.check(Schema.isPattern(/^https:\/\//u));

const addressHints = Schema.Array(
  Schema.Union([
    strictStruct({
      kind: Schema.Literals(["lan", "tailnet", "vpn"]),
      httpBaseUrl: originUrl,
    }),
    strictStruct({
      kind: Schema.Literals(["public", "relay"]),
      httpBaseUrl: httpsOriginUrl,
    }),
  ]),
).check(Schema.isMaxLength(SELF_HOSTED_RELAY_DIRECTORY_MAX_HINTS));

export const SelfHostedRelayDirectoryPublication = strictStruct({
  version: Schema.Literal(1),
  environmentId: SelfHostedRelayEnrolledEnvironment.fields.environmentId,
  addressHints,
});
export type SelfHostedRelayDirectoryPublication = typeof SelfHostedRelayDirectoryPublication.Type;

export const SelfHostedRelayDirectoryDiscovery = strictStruct({
  version: Schema.Literal(1),
  environments: Schema.Array(
    strictStruct({ ...SelfHostedRelayEnrolledEnvironment.fields, addressHints }),
  ),
});
export type SelfHostedRelayDirectoryDiscovery = typeof SelfHostedRelayDirectoryDiscovery.Type;
