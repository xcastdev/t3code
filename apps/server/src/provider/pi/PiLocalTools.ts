import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { PI_WORKER_MAX_TOOL_BYTES, PiWorkerToolOutput } from "./PiWorkerProtocol.ts";

const MAX_PATH = 4096;
const MAX_TEXT = 60_000;
const MAX_COMMAND = 12_288;
const MAX_EDITS = 64;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;
const text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const path = text(MAX_PATH).check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const positiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const ReadInput = Schema.Struct({
  path,
  offset: Schema.optionalKey(positiveInteger),
  limit: Schema.optionalKey(positiveInteger),
});
const WriteInput = Schema.Struct({ path, content: text(MAX_TEXT) });
const EditInput = Schema.Struct({
  path,
  edits: Schema.Array(Schema.Struct({ oldText: text(MAX_TEXT), newText: text(MAX_TEXT) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_EDITS),
  ),
});
const BashInput = Schema.Struct({
  command: text(MAX_COMMAND).check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/)),
  timeout: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS)),
  ),
});
const Cwd = path.check(
  Schema.isPattern(/^\/(?:[^/]+(?:\/[^/]+)*)?$/),
  Schema.makeFilter((value) => !value.split("/").some((part) => part === "." || part === "..")),
);
const decodeCwd = Schema.decodeSync(Cwd);
const parseObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const parseOutput = Schema.decodeUnknownSync(Schema.fromJsonString(PiWorkerToolOutput));

function boundedJson(value: unknown, maximum: number) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maximum) throw Error("TOOL_FAILURE");
  return json;
}

function parameters(native: unknown, bounded: Schema.Top) {
  const sdk = parseObject(boundedJson(native, PI_WORKER_MAX_TOOL_BYTES));
  const document = Schema.toJsonSchemaDocument(Schema.toType(bounded));
  const local = parseObject(
    boundedJson(
      { ...document.schema, ...(document.definitions ? { $defs: document.definitions } : {}) },
      PI_WORKER_MAX_TOOL_BYTES,
    ),
  );
  const properties = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.JsonObject));
  const nativeProperties = properties(sdk.properties);
  const boundedProperties = properties(local.properties);
  return parseObject(
    boundedJson(
      {
        ...sdk,
        ...local,
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(boundedProperties).map(([key, value]) => [
            key,
            { ...nativeProperties[key], ...value },
          ]),
        ),
      },
      PI_WORKER_MAX_TOOL_BYTES,
    ),
  );
}

function output(result: AgentToolResult<unknown>) {
  // The frozen worker cannot preserve an SDK error flag or image attachment. Reject
  // either instead of silently converting it to a successful text-only result.
  if (result.isError || result.content.some((part) => part.type !== "text"))
    throw Error("TOOL_FAILURE");
  return parseOutput(
    boundedJson(
      {
        kind: "json",
        value: {
          content: result.content,
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
        },
      },
      PI_WORKER_MAX_TOOL_BYTES,
    ),
  );
}

function adapt<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  execute: (args: S["Type"], signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
) {
  const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
  return async (args: Schema.JsonObject, signal: AbortSignal) => {
    let input: S["Type"];
    try {
      boundedJson(args, PI_WORKER_MAX_TOOL_BYTES);
      input = decode(args);
    } catch {
      throw Error("INVALID_INPUT");
    }
    if (signal.aborted) throw Error("CANCELED");
    try {
      const result = await execute(input, signal);
      if (signal.aborted) throw Error("CANCELED");
      return output(result);
    } catch {
      throw Error(signal.aborted ? "CANCELED" : "TOOL_FAILURE");
    }
  };
}

/**
 * Child-only tools for an explicit canonical cwd. Root supplies /workspace after
 * isolation and owns tool selection, mounts, per-call authorization and deadlines.
 * The trusted entry must set PI_PACKAGE_DIR before calling this lazy constructor.
 * Native file reads and output accumulation are not hard allocation bounds; escaped
 * shell descendants require Root's process owner even when SDK abort succeeds.
 */
export async function makePiLocalTools(cwd: string) {
  try {
    decodeCwd(cwd);
  } catch {
    throw Error("INVALID_INPUT");
  }
  if (!process.env.PI_PACKAGE_DIR) throw Error("UNAVAILABLE");
  const sdk = await import("@earendil-works/pi-coding-agent");
  if (sdk.VERSION !== "0.99.1") throw Error("UNAVAILABLE");
  const read = sdk.createReadTool(cwd, { autoResizeImages: false });
  const write = sdk.createWriteTool(cwd);
  const edit = sdk.createEditTool(cwd);
  const bash = sdk.createBashTool(cwd, { exposeSessionEnvironment: false });
  return Object.freeze({
    tools: Object.freeze([
      Object.freeze({
        capabilityId: "pi.read",
        name: "read",
        description:
          "Read text files with native offset/limit paging and truncation. Image attachments are unavailable in this managed profile.",
        parameters: parameters(read.parameters, ReadInput),
      }),
      Object.freeze({
        capabilityId: "pi.write",
        name: "write",
        description: write.description,
        parameters: parameters(write.parameters, WriteInput),
      }),
      Object.freeze({
        capabilityId: "pi.edit",
        name: "edit",
        description: edit.description,
        parameters: parameters(edit.parameters, EditInput),
      }),
      Object.freeze({
        capabilityId: "pi.bash",
        name: "bash",
        description: bash.description,
        parameters: parameters(bash.parameters, BashInput),
      }),
    ]),
    localTools: Object.freeze({
      read: adapt(ReadInput, (args, signal) => read.execute("t3-local-read", args, signal)),
      write: adapt(WriteInput, (args, signal) => write.execute("t3-local-write", args, signal)),
      edit: adapt(EditInput, (args, signal) =>
        edit.execute("t3-local-edit", { ...args, edits: [...args.edits] }, signal),
      ),
      bash: adapt(BashInput, (args, signal) => bash.execute("t3-local-bash", args, signal)),
    }),
  });
}
