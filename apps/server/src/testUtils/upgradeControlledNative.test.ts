// @effect-diagnostics nodeBuiltinImport:off -- Only synthetic SQL and owned temporary PTY roots are used.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { runMigrations } from "../persistence/Migrations.ts";
import { prepareUpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";
import { layerControlledPty, controlledTerminalInput } from "./upgradeControlledNative.ts";
import { assert, it } from "@effect/vitest";
import { controlledGitArguments } from "./upgradeControlledNative.ts";

it("admits fixture provisioning and rejects scripts, external config and arbitrary refs", () => {
  const cwd = "/tmp/fixture/assistant";
  assert.isTrue(controlledGitArguments(["init", "--initial-branch=main", "--template="], cwd));
  assert.isTrue(
    controlledGitArguments(["config", "--local", "core.hooksPath", `${cwd}/.git/t3-no-hooks`], cwd),
  );
  assert.isTrue(
    controlledGitArguments(["-c", "core.fsmonitor=false", "add", "-A", "--", "."], cwd),
  );
  assert.isFalse(controlledGitArguments(["-c", "core.fsmonitor=/tmp/script", "status"], cwd));
  assert.isFalse(
    controlledGitArguments(["config", "--local", "core.hooksPath", "/tmp/hooks"], cwd),
  );
  assert.isFalse(controlledGitArguments(["-c", "alias.run=!sh -c whoami", "run"], cwd));
  assert.isFalse(controlledGitArguments(["fetch", "https://example.com/repo"], cwd));
  assert.isFalse(controlledGitArguments(["update-ref", "refs/heads/main", "a".repeat(40)], cwd));
  assert.isFalse(
    controlledGitArguments(
      ["update-ref", "refs/t3/orchestration-v2/checkpoints/../main", "a".repeat(40)],
      cwd,
    ),
  );
  assert.isTrue(
    controlledGitArguments(
      ["update-ref", "refs/t3/orchestration-v2/checkpoints/fixture/1", "a".repeat(40)],
      cwd,
    ),
  );
});

it.live(
  "runs only the authored input in a real non-login PTY and drains its captured process",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-controlled-pty-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      NodeFS.mkdirSync(NodePath.join(root, "source"));
      NodeFS.mkdirSync(NodePath.join(root, "disposable"));
      const dbPath = NodePath.join(root, "source", "statev2.sqlite");
      yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      const snapshot = yield* Effect.promise(() =>
        prepareUpgradeSnapshot({
          configured: { dbPath },
          disposableRoot: NodePath.join(root, "disposable"),
          activeDatabasePaths: [dbPath],
        }),
      );
      const cwd = upgradeFixtureRoots(snapshot).claimAssistant(`assistant-${"a".repeat(64)}`);
      NodeFS.mkdirSync(cwd);
      yield* Effect.gen(function* () {
        const adapter = yield* PtyAdapter.PtyAdapter;
        const child = yield* adapter.spawn({
          shell: "/bin/false",
          args: ["--login"],
          cwd,
          cols: 80,
          rows: 24,
          env: { BASH_ENV: "/untrusted/startup" },
        });
        const exited = yield* Deferred.make<void>();
        let output = "";
        const offData = child.onData((data) => {
          output += data;
        });
        const offExit = child.onExit(() => Deferred.doneUnsafe(exited, Effect.void));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            offData();
            offExit();
          }),
        );
        assert.throws(() => child.write("touch /tmp/not-fixture\r"));
        for (const fragment of controlledTerminalInput) child.write(fragment);
        child.write("\u0004");
        yield* Deferred.await(exited);
        assert.include(output, "\rp21-fixture-terminal\r\n");
      }).pipe(Effect.provide(layerControlledPty(snapshot).pipe(Layer.provide(NodeServices.layer))));
    }).pipe(Effect.scoped),
);
