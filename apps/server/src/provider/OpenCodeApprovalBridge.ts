import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  ProviderUserInputResolution,
  type ProviderUserInputResolution as ProviderUserInputResolutionType,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export interface OpenCodeApprovalDecision {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly requestId: string;
  readonly requestType: string;
  readonly decision: "approvedOnce" | "approvedForSession" | "denied";
}

export interface OpenCodeQuestionResolution {
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly requestId: string;
  readonly nativeRequestId: string;
  readonly resolution: Extract<ProviderUserInputResolutionType, { readonly type: "answered" }>;
}

type OpenCodeBridgeEntry =
  | Omit<OpenCodeApprovalDecision, "parentSessionId">
  | Omit<OpenCodeQuestionResolution, "parentSessionId">;

const encodeUserInputResolution = Schema.encodeSync(
  Schema.fromJsonString(ProviderUserInputResolution),
);

const MAX_PARENT_SESSIONS = 64;
const MAX_DECISIONS_PER_PARENT = 32;

function safeIdentifier(value: string): string | undefined {
  const hasControlOrSpace = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
  return value.length > 0 && value.length <= 512 && !hasControlOrSpace ? value : undefined;
}

function safeRequestType(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === "<" || character === ">"
      ? " "
      : character;
  })
    .join("")
    .slice(0, 96)
    .trim();
}

const decodeConfig = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class OpenCodeApprovalBridgeError extends Data.TaggedError("OpenCodeApprovalBridgeError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const pluginSource = (statusPath: string) => `import { readFile } from "node:fs/promises";

const statusPath = ${encodeUnknownJsonString(statusPath)};

export const T3CodeApprovalBridge = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    if (typeof input.sessionID !== "string" || !Array.isArray(output.system)) return;
    let history;
    try {
      history = JSON.parse(await readFile(statusPath, "utf8"));
    } catch {
      return;
    }
    const decisions = history[input.sessionID];
    if (!decisions || typeof decisions !== "object") return;
    const lines = Object.values(decisions).slice(-${MAX_DECISIONS_PER_PARENT}).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      if (
        typeof entry.childSessionId !== "string" ||
        typeof entry.requestId !== "string"
      ) return [];
      if (entry.resolution && typeof entry.resolution === "object") {
        return ["The user answered the child question (request ID " + entry.requestId + "; native request ID " + String(entry.nativeRequestId ?? "unknown") + "; child session " + entry.childSessionId + "): " + JSON.stringify(entry.resolution) + ". This records the submitted answer only; it does not claim a requested operation succeeded."];
      }
      if (typeof entry.requestType !== "string") return [];
      const action = entry.decision === "denied"
        ? "deny"
        : entry.decision === "approvedOnce"
          ? "allow once"
          : entry.decision === "approvedForSession"
            ? "allow for this workspace"
            : undefined;
      if (!action) return [];
      return ["The user chose to " + action + " the child permission " + entry.requestType + " (request ID " + entry.requestId + "; child session " + entry.childSessionId + "). This records the user's choice only; it does not establish that the operation ran or succeeded."];
    });
    if (lines.length === 0) return;
    if (output.system.some((entry) => typeof entry === "string" && entry.includes("<t3_code_permission_history>"))) return;
    output.system.push("<t3_code_permission_history>\\n" + lines.join("\\n") + "\\n</t3_code_permission_history>");
  },
});
`;

/** Adds child approval choices to later prompts for their owning OpenCode parent sessions. */
export const makeOpenCodeApprovalBridge = Effect.fn("makeOpenCodeApprovalBridge")(function* (
  configContent: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  const config = yield* decodeConfig(configContent).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeApprovalBridgeError({
          detail: "OpenCode config could not be decoded for approval history.",
          cause,
        }),
    ),
  );
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    return yield* new OpenCodeApprovalBridgeError({
      detail: "OpenCode config plugin must be an array.",
    });
  }

  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-approval-" });
  const pluginPath = path.join(directory, "plugin.mjs");
  const statusPath = path.join(directory, "decisions.json");
  yield* fs.writeFileString(pluginPath, pluginSource(statusPath));
  yield* fs.writeFileString(statusPath, "{}");

  const decisions = new Map<string, Map<string, OpenCodeBridgeEntry>>();
  const writePermit = Semaphore.makeUnsafe(1);
  const record = Effect.fn("recordOpenCodeApprovalDecision")(function* (
    input: OpenCodeApprovalDecision,
  ) {
    const parentSessionId = safeIdentifier(input.parentSessionId);
    const childSessionId = safeIdentifier(input.childSessionId);
    const requestId = safeIdentifier(input.requestId);
    const requestType = safeRequestType(input.requestType);
    if (!parentSessionId || !childSessionId || !requestId || requestType.length === 0) {
      return yield* new OpenCodeApprovalBridgeError({
        detail: "OpenCode approval history contains an invalid identity.",
      });
    }
    yield* writePermit.withPermit(
      Effect.gen(function* () {
        let parent = decisions.get(parentSessionId);
        if (!parent) {
          if (decisions.size >= MAX_PARENT_SESSIONS) {
            const oldestParentSessionId = decisions.keys().next().value;
            if (oldestParentSessionId !== undefined) decisions.delete(oldestParentSessionId);
          }
          parent = new Map();
          decisions.set(parentSessionId, parent);
        }
        const key = `approval\u0000${childSessionId}\u0000${requestId}`;
        parent.delete(key);
        parent.set(key, {
          childSessionId,
          requestId,
          requestType,
          decision: input.decision,
        });
        while (parent.size > MAX_DECISIONS_PER_PARENT) {
          const oldestKey = parent.keys().next().value;
          if (oldestKey === undefined) break;
          parent.delete(oldestKey);
        }
        const content = encodeUnknownJsonString(
          Object.fromEntries(
            [...decisions].map(([sessionId, requests]) => [
              sessionId,
              Object.fromEntries(requests),
            ]),
          ),
        );
        const nextPath = path.join(directory, "decisions.next.json");
        yield* fs.writeFileString(nextPath, content);
        yield* fs.rename(nextPath, statusPath);
      }),
    );
  });

  const recordQuestionResolution = Effect.fn("recordOpenCodeQuestionResolution")(function* (
    input: OpenCodeQuestionResolution,
  ) {
    const parentSessionId = safeIdentifier(input.parentSessionId);
    const childSessionId = safeIdentifier(input.childSessionId);
    const requestId = safeIdentifier(input.requestId);
    const nativeRequestId = safeIdentifier(input.nativeRequestId);
    const resolutionJson = encodeUserInputResolution(input.resolution);
    if (
      !parentSessionId ||
      !childSessionId ||
      !requestId ||
      !nativeRequestId ||
      resolutionJson.length > 65_536
    ) {
      return yield* new OpenCodeApprovalBridgeError({
        detail: "OpenCode question history contains an invalid identity or oversized answer.",
      });
    }
    yield* writePermit.withPermit(
      Effect.gen(function* () {
        let parent = decisions.get(parentSessionId);
        if (!parent) {
          if (decisions.size >= MAX_PARENT_SESSIONS) {
            const oldestParentSessionId = decisions.keys().next().value;
            if (oldestParentSessionId !== undefined) decisions.delete(oldestParentSessionId);
          }
          parent = new Map();
          decisions.set(parentSessionId, parent);
        }
        const key = `question\u0000${childSessionId}\u0000${requestId}`;
        parent.delete(key);
        parent.set(key, {
          childSessionId,
          requestId,
          nativeRequestId,
          resolution: input.resolution,
        });
        while (parent.size > MAX_DECISIONS_PER_PARENT) {
          const oldestKey = parent.keys().next().value;
          if (oldestKey === undefined) break;
          parent.delete(oldestKey);
        }
        const content = encodeUnknownJsonString(
          Object.fromEntries(
            [...decisions].map(([sessionId, requests]) => [
              sessionId,
              Object.fromEntries(requests),
            ]),
          ),
        );
        const nextPath = path.join(directory, "decisions.next.json");
        yield* fs.writeFileString(nextPath, content);
        yield* fs.rename(nextPath, statusPath);
      }),
    );
  });

  return {
    pluginPath,
    configContent: encodeUnknownJsonString({
      ...config,
      plugin: [...(Array.isArray(config.plugin) ? config.plugin : []), pluginPath],
    }),
    record,
    recordQuestionResolution,
  };
});

export type OpenCodeApprovalBridge = Effect.Success<ReturnType<typeof makeOpenCodeApprovalBridge>>;
