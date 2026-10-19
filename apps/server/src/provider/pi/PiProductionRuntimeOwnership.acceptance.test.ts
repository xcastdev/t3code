import { expect, it } from "@effect/vitest";
import { describe, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Schema from "effect/Schema";
import { ThreadId } from "@t3tools/contracts";
import { makeProjectTeamPiRuntime } from "../../projectWork/ProjectTeamPiRuntime.ts";
import { providerInstanceId } from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import { PiModelCatalogue, makePiModelCatalogue } from "./PiModelCatalogue.ts";
import { makePiProductionRuntime } from "./PiProductionRuntime.ts";
import {
  model,
  ownershipAssignment,
  ownershipRuntime,
} from "./PiProductionRuntimeOwnership.testFixtures.ts";

const distributionDirectory = process.env.PI_PRODUCTION_RUNTIME_DISTRIBUTION;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

// This opt-in case requires the actual Root-built worker/SDK distribution.
// A skipped case supplies no native execution evidence.
// Factory/SDK baseline only: ProviderService, ExecutionHost, managed workspace
// creation, concurrent writes, replacement and lifecycle settlement remain unproven.
describe.runIf(distributionDirectory !== undefined)("production Pi ownership composition", () => {
  it.live(
    "initializes and joins the factory's actual native worker for its retained assignment",
    () =>
      Effect.gen(function* () {
        const f = yield* ownershipAssignment;
        yield* f.fs.writeFileString(
          f.agentDirectory + "/auth.json",
          yield* encodeJson({
            "command-code": { type: "api_key", key: "synthetic-offline-ownership-key" },
          }),
        );
        yield* f.fs.chmod(f.agentDirectory + "/auth.json", 0o600);
        const registry = yield* makeProjectTeamPiRuntime();
        const fetch = vi.fn<typeof globalThis.fetch>(async () => {
          throw new Error("No inference is authorized during initialization");
        });
        const catalogue = {
          source: "https://api.commandcode.ai/provider/v1/models" as const,
          fetchedAt: DateTime.formatIso(yield* DateTime.now),
          selectedEntry: {
            id: model,
            owned_by: "command-code" as const,
            context_length: 262144,
            supported_endpoints: ["/chat/completions"],
          },
        };
        yield* f.sql`INSERT INTO project_team_pi_catalogue (source,fetched_at,payload_json)
        VALUES (${catalogue.source},${catalogue.fetchedAt},${yield* encodeJson(catalogue)})`;
        const catalogueService = yield* makePiModelCatalogue.pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        );
        const factory = yield* makePiProductionRuntime(
          {
            environmentId: "environment",
            distributionDirectory: distributionDirectory!,
            agentDirectory: f.agentDirectory,
            nativeStateRoot: f.scratch + "/native",
            stagingRoot: f.scratch + "/stage",
            protectedRoots: [f.agentDirectory, f.main],
            memoryBytes: 536870912,
            cleanupDeadlineMs: 3000,
            maxInputTokens: 32768,
            maxOutputTokens: 2048,
          },
          registry,
        ).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provideService(PiModelCatalogue, catalogueService),
        );
        const runtime = yield* factory.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        yield* registry.withInstance(providerInstanceId, (published) =>
          Effect.sync(() => {
            expect(published.runtime).toBe(runtime);
            expect(published.assets.runtimeFiles.length).toBeGreaterThan(0);
          }),
        );
        const prepared = yield* runtime.prepareOperation(
          {
            kind: "initialize",
            threadId: f.binding.threadId,
            operationId: f.request.initializeOperationId,
          },
          () => Effect.void,
        );
        const { session, terminal } = yield* prepared.run;
        expect(terminal.outcome).toBe("success");
        expect(terminal.native?.persisted).toBe(true);
        expect(terminal.ownerCaptured).toBe(true);
        expect(terminal.drain?.childExitCode).toBe(0);
        expect(terminal.drain?.childPid).toBeGreaterThan(0);
        expect(terminal.accountingReceipts).toEqual([]);
        expect(session.resumeCursor).toBeDefined();
        expect(session.cwd).toBe(f.worktree);
        const rows = yield* f.sql<{ status: string; terminal_json: string }>`
        SELECT status,terminal_json FROM project_team_pi_operation`;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("settled");
        expect(yield* decodeJson(rows[0]!.terminal_json)).toEqual(terminal);
        const processes = yield* f.sql<{ status: string; drain_json: string }>`
        SELECT status,drain_json FROM project_team_pi_process`;
        expect(processes).toHaveLength(1);
        expect(processes[0]?.status).toBe("drained");
        expect(yield* decodeJson(processes[0]!.drain_json)).toEqual(terminal.drain);
        const budgets = yield* f.sql`SELECT * FROM project_team_model_budget`;
        for (const request of [
          {
            kind: "initialize" as const,
            threadId: ThreadId.make("unbound"),
            operationId: "foreign",
          },
          { kind: "initialize" as const, threadId: f.binding.threadId, operationId: "foreign" },
        ]) {
          const result = yield* runtime
            .prepareOperation(request, () => Effect.void)
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
        }
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budgets);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toHaveLength(1);
        expect(fetch).not.toHaveBeenCalled();
        expect(yield* f.fs.readFileString(f.main + "/primary.txt")).toBe("primary bytes\n");
      }).pipe(Effect.scoped, Effect.provide(ownershipRuntime)),
    60000,
  );
});
