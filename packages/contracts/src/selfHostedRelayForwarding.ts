import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const SELF_HOSTED_RELAY_PUBLISHER_CONTROL_MAX_FRAME_BYTES = 128;
export const SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER = "x-t3-relay-publisher-fingerprint";

export const SelfHostedRelayPublisherControlFrame = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["accepted", "ready", "heartbeat"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type SelfHostedRelayPublisherControlFrame = typeof SelfHostedRelayPublisherControlFrame.Type;

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(SelfHostedRelayPublisherControlFrame),
);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeSelfHostedRelayPublisherControlFrame(
  frame: SelfHostedRelayPublisherControlFrame,
): string {
  return JSON.stringify({ version: frame.version, status: frame.status }) + "\n";
}

export function decodeSelfHostedRelayPublisherControlFrame(
  line: Uint8Array,
): SelfHostedRelayPublisherControlFrame | undefined {
  if (line.byteLength > SELF_HOSTED_RELAY_PUBLISHER_CONTROL_MAX_FRAME_BYTES || line.includes(10)) {
    return undefined;
  }
  let text: string;
  try {
    text = utf8.decode(line);
  } catch {
    return undefined;
  }
  // A valid frame is flat with two keys. JSON.parse would collapse duplicates before validation.
  const members = Array.from(text.matchAll(/"(?:[^"\\]|\\.)*"([ \t\r]*:)?/gu)).filter(
    (match) => match[1] !== undefined,
  );
  if (members.length !== 2) return undefined;
  return Option.getOrUndefined(decodeJson(text));
}
