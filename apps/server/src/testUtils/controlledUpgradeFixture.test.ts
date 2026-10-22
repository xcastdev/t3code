// @effect-diagnostics nodeBuiltinImport:off -- Tests own disposable synthetic databases and launch manifests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
  AuthStandardClientScopes,
  AssistantDetail,
  AssistantMemoryReadResult,
  AssistantMemoryWriteResult,
  ProjectTeamSupervisionSummary,
  ORCHESTRATION_V2_WS_METHODS,
  CommandId,
  ExecutionEnvironmentDescriptor,
  ServerLifecycleStreamEvent,
  ServerConfigStreamEvent,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ShellSnapshotJson,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectMemoryProcessing } from "../projectWork/memory/ProjectMemoryProcessing.ts";
import { SkillCatalogService } from "../skills/SkillCatalogService.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { configuration } from "../assistants/AssistantTestHelpers.ts";
import { controlledProviderId, controlledProviderModel } from "./upgradeControlledProviders.ts";
import { controlledUpgradeApplicationLayer } from "./controlledUpgradeApp.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as AuthPairingLinks from "../persistence/AuthPairingLinks.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it, vi } from "@effect/vitest";
import { runMigrations } from "../persistence/Migrations.ts";
import { prepareUpgradeSnapshot, type UpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { launchControlledUpgradeFixture } from "./controlledUpgradeFixture.ts";
import { controlledNotificationDestinationId } from "./controlledNotifications.ts";
import { mapUpgradeFixturePath } from "./upgradeFixtureFilesystem.ts";

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pairingUrl: Schema.String })),
);
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeShellSnapshot = Schema.decodeUnknownSync(OrchestrationV2ShellSnapshotJson);
const decodeDetail = Schema.decodeUnknownSync(AssistantDetail);
const decodeMemoryRead = Schema.decodeUnknownSync(AssistantMemoryReadResult);
const decodeMemoryWrite = Schema.decodeUnknownSync(AssistantMemoryWriteResult);
const decodeSupervision = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);
const decodeRpcExit = Schema.decodeUnknownSync(
  Schema.Struct({
    requestId: Schema.String,
    exit: Schema.Union([
      Schema.Struct({ _tag: Schema.Literal("Success"), value: Schema.Unknown }),
      Schema.Struct({ _tag: Schema.Literal("Failure") }),
    ]),
  }),
);
const decodeRpcJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeConfigExit = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("Exit"),
    requestId: Schema.String,
    exit: Schema.Struct({
      _tag: Schema.Literal("Success"),
      value: Schema.Struct({
        environment: Schema.Struct({ label: Schema.String, environmentId: Schema.String }),
        providers: Schema.Array(Schema.Unknown),
      }),
    }),
  }),
);

const decodeRequestId = Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.String }));
const decodeNotificationExit = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("Exit"),
    requestId: Schema.Literal("fixture-notification"),
    exit: Schema.Struct({
      _tag: Schema.Literal("Success"),
      value: Schema.Struct({ status: Schema.Literal("delivered") }),
    }),
  }),
);
const decodeLifecycleChunk = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("Chunk"),
    requestId: Schema.Literal("fixture-lifecycle"),
    values: Schema.Array(ServerLifecycleStreamEvent),
  }),
);
const decodeConfigChunk = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("Chunk"),
    requestId: Schema.Literal("fixture-config-stream"),
    values: Schema.Array(ServerConfigStreamEvent),
  }),
);
const decodeShellChunk = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("Chunk"),
    requestId: Schema.Literal("fixture-shell"),
    values: Schema.Array(OrchestrationV2ShellStreamItem),
  }),
);

function requestFixture(
  origin: string,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
) {
  const url = new URL(path, origin);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
    throw new Error("Expected fixture loopback HTTP");
  return new Promise<{
    readonly status: number;
    readonly cookies: ReadonlyArray<string>;
    readonly contentType: string | undefined;
    readonly json: () => unknown;
    readonly body: string;
  }>((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            cookies: response.headers["set-cookie"] ?? [],
            contentType: response.headers["content-type"],
            body,
            json: (): unknown => JSON.parse(body),
          }),
        );
        response.on("error", () => reject(new Error("Fixture response failed")));
      },
    );
    request.on("error", () => reject(new Error("Fixture request failed")));
    request.end(options.body);
  });
}

function withSnapshotEffect<A, E, R>(run: (snapshot: UpgradeSnapshot) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fixture-launch-"));
    try {
      const source = NodePath.join(root, "source");
      const disposableRoot = NodePath.join(root, "disposable");
      NodeFS.mkdirSync(source);
      NodeFS.mkdirSync(disposableRoot);
      const dbPath = NodePath.join(source, "statev2.sqlite");
      yield* Effect.gen(function* () {
        yield* runMigrations();
        // Copied projects can contain the entire fixture path; owned assistant paths must win.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('copied-ancestor','Copied ancestor',${root},'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
        const grants = yield* AuthPairingLinks.AuthPairingLinkRepository;
        yield* grants.create({
          id: "copied-grant",
          credential: "copied-fixture-credential",
          method: "one-time-token",
          scopes: AuthStandardClientScopes,
          subject: "copied-client",
          label: null,
          proofKeyThumbprint: null,
          createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"),
        });
      }).pipe(
        Effect.provide(
          AuthPairingLinks.layer.pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
          ),
        ),
      );
      const snapshot = yield* Effect.promise(() =>
        prepareUpgradeSnapshot({
          configured: { dbPath },
          disposableRoot,
          activeDatabasePaths: [dbPath],
        }),
      );
      return yield* run(snapshot);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
}

function withSnapshot(run: (snapshot: UpgradeSnapshot) => Promise<void>) {
  return withSnapshotEffect((snapshot) => Effect.promise(() => run(snapshot)));
}

async function pairProtocolClient(origin: string, credential: string, label: string) {
  const paired = await requestFixture(origin, "/api/auth/browser-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  expect(paired.status).toBe(200);
  const cookie = paired.cookies
    .filter((value) => !value.includes("Max-Age=0"))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const ticket = await requestFixture(origin, "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { cookie },
  });
  expect(ticket.status).toBe(200);
  const socket = new WebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(decodeTicket(ticket.json()).ticket)}`,
  );
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  socket.addEventListener("message", (event) => {
    try {
      const decoded = decodeRpcJson(event.data);
      for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
        const response = decodeRpcExit(frame);
        const callback = pending.get(response.requestId);
        if (!callback) throw new Error("Unexpected fixture RPC response");
        pending.delete(response.requestId);
        if (response.exit._tag === "Failure") callback.reject(new Error("Fixture RPC failed"));
        else callback.resolve(response.exit.value);
      }
    } catch {
      for (const callback of pending.values())
        callback.reject(new Error("Invalid fixture RPC response"));
      pending.clear();
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Fixture WebSocket connection failed")),
      { once: true },
    );
  });
  return {
    cookie,
    call: (tag: string, payload: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = `${label}-${++sequence}`;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      }),
  };
}

it.live(
  "shares automatic assistant memory edits and forgetting across two authenticated WS clients",
  () => {
    const processed = Deferred.makeUnsafe<void>();
    const secondProcessed = Deferred.makeUnsafe<void>();
    const processedKeys = new Set<string>();
    return withSnapshotEffect((snapshot) =>
      Effect.gen(function* () {
        expect(() =>
          mapUpgradeFixturePath(
            snapshot,
            NodePath.join(snapshot.fixtureRoot, "unclaimed"),
            "controlled-fixture",
          ),
        ).toThrow("Filesystem action has no fixture root claim");
        const server = yield* HttpServer.HttpServer;
        if (!NetAddress.isInetAddressV4(server.address))
          throw new Error("Expected owned IPv4 fixture listener");
        const origin = `http://127.0.0.1:${server.address.port}`;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const grantA = yield* auth.issuePairingCredential({ scopes: AuthStandardClientScopes });
        const grantB = yield* auth.issuePairingCredential({ scopes: AuthStandardClientScopes });
        expect(grantA.credential !== grantB.credential).toBe(true);
        const a = yield* Effect.acquireRelease(
          Effect.promise(() => pairProtocolClient(origin, grantA.credential, "a")),
          (client) => Effect.promise(() => client.close()),
        );
        const b = yield* Effect.acquireRelease(
          Effect.promise(() => pairProtocolClient(origin, grantB.credential, "b")),
          (client) => Effect.promise(() => client.close()),
        );
        expect(a.cookie !== b.cookie).toBe(true);
        const sessions = yield* (yield* AuthSessions.AuthSessionRepository).listActive({
          now: yield* DateTime.now,
        });
        expect(sessions).toHaveLength(2);
        expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(2);
        const environmentId = yield* (yield* Environment.ServerEnvironment).getEnvironmentId;
        const detail = decodeDetail(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsCreate, {
              environmentId,
              commandId: "two-client-create",
              configuration: {
                ...configuration,
                rules: "",
                prompt: "",
                personality: "",
                modelSelection: {
                  instanceId: controlledProviderId,
                  model: controlledProviderModel,
                },
              },
            }),
          ),
        );
        expect(detail.summary.provisioningState).toBe("ready");
        const shellResponse = yield* Effect.promise(() =>
          requestFixture(origin, "/api/orchestration/shell", {
            headers: {
              cookie: a.cookie,
              [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
            },
          }),
        );
        expect(shellResponse.status).toBe(200);
        const createdShell = decodeShellSnapshot(shellResponse.json());
        expect(
          createdShell.projects.find(
            (project) => project.id === detail.summary.binding.backingProjectId,
          )?.assistantId,
        ).toBe(detail.summary.assistantId);
        expect(
          createdShell.projects.find((project) => project.id === "copied-ancestor")?.assistantId,
        ).toBeUndefined();
        expect(
          NodeFS.existsSync(
            NodePath.join(
              snapshot.fixtureRoot,
              "runtime",
              "assistants",
              detail.summary.assistantId,
              ".git",
            ),
          ),
        ).toBe(true);
        const supervision = decodeSupervision(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.projectWorkRead, {
              projectId: "copied-ancestor",
              operation: "supervision",
            }),
          ),
        );
        expect(supervision.availability).toBe("available");
        if (supervision.availability !== "available") throw new Error("Expected project summary");
        expect(supervision.taskCounts.total).toBe(0);
        yield* (yield* SkillCatalogService).notifyApplicationChanged({
          threadId: detail.summary.binding.canonicalThreadId,
          providerInstanceId: controlledProviderId,
        });
        const scope = { environmentId, assistantId: detail.summary.assistantId };
        yield* Effect.promise(() =>
          a.call(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
            type: "message.dispatch",
            commandId: CommandId.make("two-client-chat"),
            threadId: detail.summary.binding.canonicalThreadId,
            messageId: "two-client-message",
            createdBy: "user",
            creationSource: "web",
            text: "Remember the project uses a blue release label",
            attachments: [],
            modelSelection: { instanceId: controlledProviderId, model: controlledProviderModel },
            dispatchMode: { type: "start_immediately" },
          }),
        );
        yield* Deferred.await(processed);
        const second = decodeDetail(
          yield* Effect.promise(() =>
            b.call(WS_METHODS.assistantsCreate, {
              environmentId,
              commandId: "second-assistant-create",
              configuration: {
                ...configuration,
                rules: "Distinct second assistant instructions.",
                modelSelection: {
                  instanceId: controlledProviderId,
                  model: controlledProviderModel,
                },
              },
            }),
          ),
        );
        expect(second.summary.provisioningState).toBe("ready");
        yield* Effect.promise(() =>
          b.call(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
            type: "message.dispatch",
            commandId: CommandId.make("second-assistant-chat"),
            threadId: second.summary.binding.canonicalThreadId,
            messageId: "second-assistant-message",
            createdBy: "user",
            creationSource: "web",
            text: "Remember the project uses a blue release label",
            attachments: [],
            modelSelection: { instanceId: controlledProviderId, model: controlledProviderModel },
            dispatchMode: { type: "start_immediately" },
          }),
        );
        yield* Deferred.await(secondProcessed);
        const original = decodeMemoryRead(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsMemoryRead, { ...scope, operation: "list" }),
          ),
        );
        if (original.operation !== "list" || original.items.length !== 1)
          throw new Error("Expected one automatically captured source");
        const source = original.items[0]!;
        const selector = {
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          generation: source.generation,
          contentHash: source.contentHash,
        };
        const recalled = decodeMemoryRead(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsMemoryRead, { ...scope, operation: "context" }),
          ),
        );
        if (recalled.operation !== "context") throw new Error("Expected memory context");
        expect(recalled.text).toContain("blue release label");
        const correction = "The project uses an amber release label.";
        const edited = decodeMemoryWrite(
          yield* Effect.promise(() =>
            b.call(WS_METHODS.assistantsMemoryWrite, {
              ...scope,
              operation: "edit",
              source: selector,
              content: correction,
            }),
          ),
        );
        if (!edited.source) throw new Error("Expected retained corrected source");
        const corrected = edited.source;
        // Edit queues actual extraction; reconcile drains that admitted job without a polling wait.
        yield* (yield* ProjectMemoryProcessing).reconcile();
        const observed = decodeMemoryRead(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsMemoryRead, { ...scope, operation: "list" }),
          ),
        );
        if (observed.operation !== "list") throw new Error("Expected current source list");
        expect(observed.items.map((item) => item.content)).toEqual([correction]);
        const afterEdit = decodeMemoryRead(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsMemoryRead, { ...scope, operation: "context" }),
          ),
        );
        if (afterEdit.operation !== "context") throw new Error("Expected corrected memory context");
        expect(afterEdit.text).not.toContain("blue release label");
        expect(afterEdit.text).toContain("amber release label");
        expect(afterEdit.memoryEpoch).toBeGreaterThan(recalled.memoryEpoch);
        yield* Effect.promise(() =>
          b.call(WS_METHODS.assistantsMemoryWrite, {
            ...scope,
            operation: "forget",
            source: {
              sourceId: corrected.sourceId,
              sourceRevision: corrected.sourceRevision,
              generation: corrected.generation,
              contentHash: corrected.contentHash,
            },
          }),
        );
        const forgotten = decodeMemoryRead(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsMemoryRead, { ...scope, operation: "list" }),
          ),
        );
        if (forgotten.operation !== "list")
          throw new Error("Expected source list after forgetting");
        expect(forgotten.items).toEqual([]);
        const afterForget = decodeMemoryRead(
          yield* Effect.promise(() =>
            a.call(WS_METHODS.assistantsMemoryRead, { ...scope, operation: "context" }),
          ),
        );
        if (afterForget.operation !== "context")
          throw new Error("Expected memory context after forgetting");
        expect(afterForget.text).not.toContain("blue release label");
        expect(afterForget.text).not.toContain("amber release label");
        expect(afterForget.memoryEpoch).toBeGreaterThan(afterEdit.memoryEpoch);
        const sql = yield* SqlClient.SqlClient;
        const delivery = yield* sql<{
          readonly state: string;
          readonly applied_snapshot_json: string | null;
        }>`SELECT state,applied_snapshot_json FROM t3_workflow_v2_instruction_deliveries WHERE thread_id=${detail.summary.binding.canonicalThreadId}`;
        expect(delivery).toHaveLength(1);
        expect(delivery[0]?.state).toBe("applied");
        expect(delivery[0]?.applied_snapshot_json).not.toBeNull();
        const otherDelivery = yield* sql<{
          readonly state: string;
          readonly applied_snapshot_json: string | null;
        }>`SELECT state,applied_snapshot_json FROM t3_workflow_v2_instruction_deliveries WHERE thread_id=${second.summary.binding.canonicalThreadId}`;
        expect(otherDelivery).toHaveLength(1);
        expect(otherDelivery[0]?.state).toBe("applied");
        expect(otherDelivery[0]?.applied_snapshot_json).not.toBe(
          delivery[0]?.applied_snapshot_json,
        );
        const completedRuns = yield* sql<{
          readonly status: string;
        }>`SELECT status FROM orchestration_v2_projection_runs WHERE thread_id IN (${detail.summary.binding.canonicalThreadId},${second.summary.binding.canonicalThreadId})`;
        expect(completedRuns.map((run) => run.status)).toEqual(["completed", "completed"]);
        const retained = yield* sql<{
          status: string;
          forgotten: number;
          tombstoned: string | null;
        }>`SELECT status,json_extract(payload_json,'$.tombstonedAt') AS tombstoned,(SELECT COUNT(*) FROM t3_workflow_v2_memory_forgotten WHERE environment_id=${environmentId} AND owner_id=${scope.assistantId} AND source_id=${corrected.sourceId}) AS forgotten FROM t3_workflow_v2_memory_sources WHERE environment_id=${environmentId} AND owner_id=${scope.assistantId} AND source_id=${corrected.sourceId} ORDER BY source_revision DESC LIMIT 1`;
        expect(retained[0]?.status).toBe("retracted");
        expect(typeof retained[0]?.tombstoned).toBe("string");
        expect(retained[0]?.forgotten).toBeGreaterThan(0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          controlledUpgradeApplicationLayer(snapshot, {
            onMemoryProcessed: (key) =>
              Effect.suspend(() => {
                processedKeys.add(key);
                return Deferred.succeed(
                  processedKeys.size === 1 ? processed : secondProcessed,
                  undefined,
                );
              }).pipe(Effect.asVoid),
          }),
        ),
      ),
    );
  },
);

it.effect("keeps pairing material private and closes only its owned application once", () =>
  withSnapshot(async (snapshot) => {
    const close = vi.fn(async () => {});
    const launch = await launchControlledUpgradeFixture({
      snapshot,
      buildApplication: async () => ({
        origin: "http://127.0.0.1:43210",
        pairingUrl: "http://127.0.0.1:43210/?bootstrapToken=fixture-only",
        close,
      }),
    });
    expect(NodeFS.statSync(launch.manifestPath).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(launch.manifestPath, "utf8")).toContain("fixture-only");
    expect(JSON.stringify(launch)).not.toContain("fixture-only");
    await expect(
      launchControlledUpgradeFixture({
        snapshot,
        buildApplication: async () => {
          throw new Error("Must not build a second application");
        },
      }),
    ).rejects.toThrow("launch manifest");
    await launch.close();
    await launch.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(NodeFS.existsSync(launch.manifestPath)).toBe(false);
  }),
);

it.effect("rejects a nonloopback application and closes it without writing credentials", () =>
  withSnapshot(async (snapshot) => {
    const close = vi.fn(async () => {});
    await expect(
      launchControlledUpgradeFixture({
        snapshot,
        buildApplication: async () => ({
          origin: "http://example.com:43210",
          pairingUrl: "http://example.com:43210/?bootstrapToken=must-not-be-written",
          close,
        }),
      }),
    ).rejects.toThrow("loopback");
    expect(close).toHaveBeenCalledTimes(1);
    expect(NodeFS.existsSync(NodePath.join(snapshot.fixtureRoot, "controlled-launch.json"))).toBe(
      false,
    );
  }),
);

it.live(
  "serves production static/auth/WS routes and returns a config RPC through fresh authentication",
  () =>
    withSnapshot(async (snapshot) => {
      const staticDir = NodePath.join(snapshot.fixtureRoot, "client-assets");
      NodeFS.mkdirSync(staticDir);
      NodeFS.writeFileSync(
        NodePath.join(staticDir, "index.html"),
        "<!doctype html><title>Controlled fixture</title>",
      );
      const launch = await launchControlledUpgradeFixture({ snapshot, staticDir });
      try {
        const metadata = await requestFixture(launch.origin, "/.well-known/t3/environment");
        expect(metadata.status).toBe(200);
        expect(metadata.contentType).toContain("application/json");
        const descriptor = decodeDescriptor(metadata.json());
        expect(descriptor.label).toBe("Controlled upgrade fixture");
        expect(descriptor.environmentId.startsWith("fixture-")).toBe(true);
        const unauthenticatedShell = await requestFixture(
          launch.origin,
          "/api/orchestration/shell",
          {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION) },
          },
        );
        expect(unauthenticatedShell.status).toBe(401);
        const index = await requestFixture(launch.origin, "/");
        expect(index.status).toBe(200);
        expect(index.body).toContain("Controlled fixture");
        const manifest = decodeManifest(NodeFS.readFileSync(launch.manifestPath, "utf8"));
        const credential = new URLSearchParams(new URL(manifest.pairingUrl).hash.slice(1)).get(
          "token",
        );
        const secondManifestPath = await launch.issuePairingManifest("android");
        expect(NodeFS.statSync(secondManifestPath).mode & 0o777).toBe(0o600);
        const secondManifest = decodeManifest(NodeFS.readFileSync(secondManifestPath, "utf8"));
        expect(secondManifest.pairingUrl !== manifest.pairingUrl).toBe(true);
        const session = await requestFixture(launch.origin, "/api/auth/session");
        expect(session.status).toBe(200);
        expect(await session.json()).toMatchObject({ authenticated: false });
        const ws = await requestFixture(
          launch.origin,
          `/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
        );
        expect(ws.status).toBe(401);
        const copiedGrant = await requestFixture(launch.origin, "/api/auth/browser-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential: "copied-fixture-credential" }),
        });
        expect(copiedGrant.status).toBe(401);
        const paired = await requestFixture(launch.origin, "/api/auth/browser-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential }),
        });
        expect(paired.status).toBe(200);
        expect(paired.cookies.some((value) => value.includes("HttpOnly"))).toBe(true);
        const cookie = paired.cookies
          .filter((value) => !value.includes("Max-Age=0"))
          .map((value) => value.split(";", 1)[0])
          .join("; ");
        const authenticated = await requestFixture(launch.origin, "/api/auth/session", {
          headers: { cookie },
        });
        expect(await authenticated.json()).toMatchObject({ authenticated: true });
        const shellHttp = await requestFixture(launch.origin, "/api/orchestration/shell", {
          headers: {
            cookie,
            [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
          },
        });
        expect(shellHttp.status).toBe(200);
        expect(shellHttp.contentType).toContain("application/json");
        const httpSnapshot = decodeShellSnapshot(shellHttp.json());
        const ticketResponse = await requestFixture(launch.origin, "/api/auth/websocket-ticket", {
          method: "POST",
          headers: { cookie },
        });
        expect(ticketResponse.status).toBe(200);
        const ticket = decodeTicket(ticketResponse.json()).ticket;
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(
            `${launch.origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
          );
          socket.addEventListener(
            "error",
            () => reject(new Error("Fixture WebSocket upgrade failed")),
            { once: true },
          );
          let responseReceived = false;
          let welcomeReceived = false;
          let readyReceived = false;
          let notificationRequested = false;
          let configSnapshotReceived = false;
          let themeReceived = false;
          let usageSourcesReceived = false;
          let shellSnapshotReceived = false;
          let shellSynchronized = false;
          socket.addEventListener(
            "open",
            () =>
              socket.send(
                JSON.stringify({
                  _tag: "Request",
                  id: "fixture-config",
                  tag: WS_METHODS.serverGetConfig,
                  payload: {},
                  headers: [],
                }),
              ),
            { once: true },
          );
          socket.addEventListener("message", (event) => {
            try {
              const decoded = decodeRpcJson(event.data);
              const frames: ReadonlyArray<unknown> = Array.isArray(decoded) ? decoded : [decoded];
              for (const frame of frames) {
                if (decodeRequestId(frame).requestId === "fixture-config") {
                  const response = decodeConfigExit(frame);
                  expect(response.exit.value.environment.label).toBe("Controlled upgrade fixture");
                  expect(response.exit.value.environment.environmentId).toBe(
                    descriptor.environmentId,
                  );
                  expect(response.exit.value.providers).toHaveLength(1);
                  socket.send(
                    JSON.stringify({
                      _tag: "Request",
                      id: "fixture-lifecycle",
                      tag: WS_METHODS.subscribeServerLifecycle,
                      payload: {},
                      headers: [],
                    }),
                  );
                  socket.send(
                    JSON.stringify({
                      _tag: "Request",
                      id: "fixture-config-stream",
                      tag: WS_METHODS.subscribeServerConfig,
                      payload: {
                        environmentThemes: true,
                        usageLimitSources: true,
                        usageLimitsCommand: true,
                      },
                      headers: [],
                    }),
                  );
                  socket.send(
                    JSON.stringify({
                      _tag: "Request",
                      id: "fixture-shell",
                      tag: ORCHESTRATION_V2_WS_METHODS.subscribeShell,
                      payload: { requestCompletionMarker: true },
                      headers: [],
                    }),
                  );
                } else if (decodeRequestId(frame).requestId === "fixture-lifecycle") {
                  for (const event of decodeLifecycleChunk(frame).values) {
                    if (event.type === "welcome") {
                      expect(event.payload.environment.environmentId).toBe(
                        descriptor.environmentId,
                      );
                      expect(event.payload.bootstrapStatus).toBe("complete");
                      expect(event.payload.bootstrapProjectCreated).toBe(false);
                      expect(event.payload.bootstrapThreadCreated).toBe(false);
                      welcomeReceived = true;
                    } else if (event.type === "ready") {
                      expect(event.payload.environment.environmentId).toBe(
                        descriptor.environmentId,
                      );
                      readyReceived = true;
                    }
                  }
                  socket.send(JSON.stringify({ _tag: "Ack", requestId: "fixture-lifecycle" }));
                } else if (decodeRequestId(frame).requestId === "fixture-config-stream") {
                  for (const event of decodeConfigChunk(frame).values) {
                    if (event.type === "snapshot") {
                      expect(event.config.environment.environmentId).toBe(descriptor.environmentId);
                      configSnapshotReceived = true;
                    } else if (event.type === "environmentThemesUpdated") {
                      expect(event.payload.themes).toEqual([]);
                      themeReceived = true;
                    } else if (event.type === "usageLimitSourcesUpdated") {
                      expect(event.payload.sources).toEqual([]);
                      usageSourcesReceived = true;
                    }
                  }
                  socket.send(JSON.stringify({ _tag: "Ack", requestId: "fixture-config-stream" }));
                } else if (decodeRequestId(frame).requestId === "fixture-shell") {
                  for (const item of decodeShellChunk(frame).values) {
                    if (item.kind === "snapshot") {
                      expect(item.snapshot.snapshotSequence).toBeGreaterThanOrEqual(
                        httpSnapshot.snapshotSequence,
                      );
                      expect(item.snapshot.projects).toEqual(httpSnapshot.projects);
                      expect(item.snapshot.threads).toEqual(httpSnapshot.threads);
                      shellSnapshotReceived = true;
                    } else if (item.kind === "synchronized") shellSynchronized = true;
                  }
                  socket.send(JSON.stringify({ _tag: "Ack", requestId: "fixture-shell" }));
                } else {
                  decodeNotificationExit(frame);
                  responseReceived = true;
                  socket.close();
                }
                if (
                  welcomeReceived &&
                  readyReceived &&
                  configSnapshotReceived &&
                  themeReceived &&
                  usageSourcesReceived &&
                  shellSnapshotReceived &&
                  shellSynchronized &&
                  !notificationRequested
                ) {
                  notificationRequested = true;
                  socket.send(
                    JSON.stringify({
                      _tag: "Request",
                      id: "fixture-notification",
                      tag: WS_METHODS.serverTestExternalNotification,
                      payload: { destinationId: controlledNotificationDestinationId },
                      headers: [],
                    }),
                  );
                }
              }
            } catch {
              reject(
                new Error(
                  "Fixture config/notification RPC did not return a valid successful response",
                ),
              );
              socket.close();
            }
          });
          socket.addEventListener(
            "close",
            () =>
              responseReceived
                ? resolve()
                : reject(new Error("Fixture WebSocket closed before its config response")),
            { once: true },
          );
        });
      } finally {
        await launch.close();
      }
    }),
);
