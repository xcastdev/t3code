import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Snapshot from "./ProjectIssueCredentialSnapshot.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const input = { cwd: "/repo", host: "github.com" };
const account = (login = "alice", host = "github.com", active = true, state = "success") => ({
  host,
  login,
  active,
  state,
});
const authStatus = (accounts = [account()]) => encodeJson({ hosts: { fixture: accounts } });
const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
type Stage = "status" | "token" | "user";
type Script = (
  stage: Stage,
  input: ProcessRunner.ProcessRunInput,
  fallback: ProcessRunner.ProcessRunOutput,
) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;

const makeFixture = Effect.fn("makeFixture")(function* (script?: Script) {
  const calls: Array<ProcessRunner.ProcessRunInput> = [];
  const state = {
    status: authStatus(),
    token: "fixture-token-1\n",
    user: encodeJson({ node_id: "NODE_1", login: "alice" }),
  };
  const runner = ProcessRunner.ProcessRunner.of({
    run: (command) => {
      calls.push(command);
      const stage: Stage =
        command.args[0] === "api" ? "user" : command.args[1] === "token" ? "token" : "status";
      const fallback = output(state[stage]);
      return script === undefined ? Effect.succeed(fallback) : script(stage, command, fallback);
    },
  });
  const vcs = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const github = yield* GitHubCli.make.pipe(Effect.provideService(VcsProcess.VcsProcess, vcs));
  const service = yield* Snapshot.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(GitHubCli.GitHubCli, github),
  );
  return { service, state, calls };
});
const encodeError = Schema.encodeEffect(
  Schema.fromJsonString(Snapshot.IssueCredentialSnapshotError),
);

describe("ProjectIssueCredentialSnapshot", () => {
  it.effect("selects the exact host/login and verifies using the captured token", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.state.status = authStatus([
        account("bob"),
        account("alice", "other.example.test"),
        account("alice", input.host, false),
      ]);
      const verified = yield* fixture.service.read({
        ...input,
        accountLogin: "alice",
        expectedAccountNodeId: "NODE_1",
      });
      expect(verified).toMatchObject({
        ...input,
        accountNodeId: "NODE_1",
        accountLogin: "alice",
      });
      expect(Redacted.value(verified.token)).toBe("fixture-token-1");
      expect(verified.credentialEpoch).toMatch(/^[a-f0-9-]{36}$/u);
      expect(fixture.calls.map((call) => call.args)).toEqual([
        ["auth", "status", "--hostname", input.host, "--json", "hosts"],
        ["auth", "token", "--hostname", input.host, "--user", "alice"],
        ["api", "--hostname", input.host, "user"],
      ]);
      for (const call of fixture.calls) {
        expect(call.cwd).toBe(input.cwd);
        expect(call.maxOutputBytes).toBe(16 * 1024);
        expect(call.timeout).toBe(15_000);
        expect(call.timeoutBehavior).toBe("error");
      }
      for (const call of fixture.calls.slice(0, 2)) {
        expect(call.env).toMatchObject({
          GH_HOST: "",
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
          GH_DEBUG: "",
        });
        expect(call.env).not.toHaveProperty("GH_CONFIG_DIR");
        expect(call.outputMode).toBe("error");
      }
      expect(fixture.calls[2]?.env).toMatchObject({
        GH_HOST: input.host,
        GH_TOKEN: "fixture-token-1",
        GITHUB_TOKEN: "fixture-token-1",
        GH_ENTERPRISE_TOKEN: "fixture-token-1",
        GITHUB_ENTERPRISE_TOKEN: "fixture-token-1",
        GH_DEBUG: "",
      });
      expect(encodeJson(verified)).not.toContain("fixture-token-1");
    }).pipe(Effect.scoped),
  );

  const selectionCases = [
    { name: "two active accounts", accounts: [account(), account("bob")], reason: "ambiguous" },
    {
      name: "duplicate selected login",
      accounts: [account(), account()],
      login: "alice",
      reason: "ambiguous",
    },
    {
      name: "only inactive accounts",
      accounts: [account("alice", input.host, false)],
      reason: "authentication",
    },
    {
      name: "another host",
      accounts: [account("alice", "other.example.test")],
      reason: "authentication",
    },
    {
      name: "failed active account",
      accounts: [account("alice", input.host, true, "failure"), account("bob", input.host, false)],
      reason: "authentication",
    },
    {
      name: "missing selected login",
      accounts: [account("bob")],
      login: "alice",
      reason: "authentication",
    },
    {
      name: "login case mismatch",
      accounts: [account("Alice")],
      login: "alice",
      reason: "authentication",
    },
  ];
  for (const test of selectionCases) {
    it.effect(`refuses ${test.name} without account fallback`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.status = authStatus(test.accounts);
        const error = yield* fixture.service
          .read({ ...input, ...(test.login === undefined ? {} : { accountLogin: test.login }) })
          .pipe(Effect.flip);
        expect(error.reason).toBe(test.reason);
        expect(fixture.calls).toHaveLength(1);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("initial discovery picks the one authenticated active host account", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.state.status = authStatus([
        account("bob", input.host, false),
        account(),
        account("bob", "other.example.test"),
      ]);
      expect((yield* fixture.service.read(input)).accountLogin).toBe("alice");
    }).pipe(Effect.scoped),
  );

  for (const test of [
    { name: "different token user", user: { node_id: "NODE_2", login: "bob" }, expected: "NODE_1" },
    { name: "different node ID", user: { node_id: "NODE_2", login: "alice" }, expected: "NODE_1" },
    {
      name: "different login for same node",
      user: { node_id: "NODE_1", login: "Alice" },
      expected: "NODE_1",
    },
  ]) {
    it.effect(`rejects ${test.name}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.user = encodeJson(test.user);
        const error = yield* fixture.service
          .read({ ...input, expectedAccountNodeId: test.expected })
          .pipe(Effect.flip);
        expect(error.reason).toBe("account-mismatch");
      }).pipe(Effect.scoped),
    );
  }

  for (const invalid of [
    { ...input, host: "GitHub.com" },
    { ...input, host: "https://github.com" },
    { ...input, host: "github.com/other" },
    { ...input, host: `${"a".repeat(64)}.test` },
    { ...input, cwd: "relative" },
    { ...input, cwd: "/repo\n" },
    { ...input, cwd: `/${"a".repeat(4096)}` },
    { ...input, accountLogin: "--user=bob" },
    { ...input, accountLogin: "a".repeat(40) },
    { ...input, expectedAccountNodeId: "" },
  ]) {
    it.effect(`rejects invalid input ${encodeJson(invalid)}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        expect((yield* fixture.service.read(invalid).pipe(Effect.flip)).reason).toBe(
          "invalid-input",
        );
        expect(fixture.calls).toHaveLength(0);
      }).pipe(Effect.scoped),
    );
  }

  for (const token of [
    "",
    "\n",
    "two\nlines",
    "fixture\n\n",
    " fixture",
    "fixture\t",
    "fixture\x00",
    "fixture\x7f",
    "fixture\u0085",
    "x".repeat(16 * 1024 + 1),
  ]) {
    it.effect(`refuses invalid token shape (${token.length} bytes)`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.token = token;
        expect((yield* fixture.service.read(input).pipe(Effect.flip)).reason).toBe(
          "invalid-response",
        );
        expect(fixture.calls).toHaveLength(2);
      }).pipe(Effect.scoped),
    );
  }

  for (const token of ["fixture-token-1", "fixture-token-1\n", "fixture-token-1\r\n"]) {
    it.effect(`accepts a token with ${token.length - 15} terminal newline bytes`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.token = token;
        expect(Redacted.value((yield* fixture.service.read(input)).token)).toBe("fixture-token-1");
      }).pipe(Effect.scoped),
    );
  }

  const damagedOutputs: ReadonlyArray<Partial<ProcessRunner.ProcessRunOutput>> = [
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { stdoutInvalidUtf8: true },
    { stderrInvalidUtf8: true },
    { code: ChildProcessSpawner.ExitCode(1), stderr: "authentication failed fixture-secret" },
    { code: null },
    { timedOut: true, code: null },
  ];
  for (const stage of ["status", "token", "user"] as const) {
    it.effect(`rejects damaged ${stage} output and never serializes provider secrets`, () =>
      Effect.gen(function* () {
        for (const damage of damagedOutputs) {
          const fixture = yield* makeFixture((current, _command, fallback) =>
            Effect.succeed(
              current === stage ? { ...fallback, ...damage, stderr: "fixture-secret" } : fallback,
            ),
          );
          const error = yield* fixture.service.read(input).pipe(Effect.flip);
          expect(error._tag).toBe("IssueCredentialSnapshotError");
          expect(yield* encodeError(error)).not.toContain("fixture-secret");
          expect(encodeJson(error)).not.toContain("fixture-secret");
          expect(fixture.calls).toHaveLength(stage === "status" ? 1 : stage === "token" ? 2 : 3);
        }
      }).pipe(Effect.scoped),
    );
  }

  for (const stage of ["status", "user"] as const) {
    it.effect(`rejects malformed and oversized ${stage} JSON`, () =>
      Effect.gen(function* () {
        for (const text of [
          "fixture-secret",
          "{}",
          "null",
          "x".repeat(16 * 1024 + 1),
          encodeJson(
            stage === "user" ? { node_id: "NODE_1", login: "invalid login" } : { hosts: [] },
          ),
        ]) {
          const fixture = yield* makeFixture((current, _command, fallback) =>
            Effect.succeed(current === stage ? output(text) : fallback),
          );
          const error = yield* fixture.service.read(input).pipe(Effect.flip);
          expect(error.reason).toBe("invalid-response");
          expect(yield* encodeError(error)).not.toContain("fixture-secret");
        }
      }).pipe(Effect.scoped),
    );
  }

  it.effect("maps process failures to generic errors without their causes", () =>
    Effect.gen(function* () {
      const errors: ReadonlyArray<ProcessRunner.ProcessRunError> = [
        new ProcessRunner.ProcessSpawnError({
          command: "gh",
          argumentCount: 6,
          cause: new Error("fixture-secret"),
        }),
        new ProcessRunner.ProcessReadError({
          command: "gh",
          argumentCount: 6,
          stream: "stdout",
          cause: new Error("fixture-secret"),
        }),
        new ProcessRunner.ProcessOutputLimitError({
          command: "gh",
          argumentCount: 6,
          stream: "stdout",
          maxBytes: 16 * 1024,
          observedBytes: 16 * 1024 + 1,
        }),
        new ProcessRunner.ProcessTimeoutError({
          command: "gh",
          argumentCount: 6,
          timeoutMs: 15_000,
        }),
      ];
      for (const stage of ["status", "token", "user"] as const) {
        for (const processError of errors) {
          const fixture = yield* makeFixture((current, _command, fallback) =>
            current === stage ? Effect.fail(processError) : Effect.succeed(fallback),
          );
          const error = yield* fixture.service.read(input).pipe(Effect.flip);
          expect(error.reason).toBe(
            processError._tag === "ProcessReadError" ||
              processError._tag === "ProcessOutputLimitError"
              ? "invalid-response"
              : "unavailable",
          );
          expect(yield* encodeError(error)).not.toContain("fixture-secret");
          expect(encodeJson(error)).not.toContain("cause");
        }
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rereads and verifies every token; only equal verified tokens reuse an epoch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* fixture.service.read(input);
      const same = yield* fixture.service.read({ ...input, cwd: "/second-repo" });
      expect(same.credentialEpoch).toBe(first.credentialEpoch);
      fixture.state.token = "fixture-token-2\n";
      const changed = yield* fixture.service.read(input);
      expect(changed.credentialEpoch).not.toBe(first.credentialEpoch);
      fixture.state.token = "fixture-token-3\n";
      fixture.state.user = encodeJson({ node_id: "NODE_1", login: "bob" });
      yield* fixture.service.read(input).pipe(Effect.flip);
      fixture.state.user = encodeJson({ node_id: "NODE_1", login: "alice" });
      fixture.state.token = "fixture-token-2\n";
      expect((yield* fixture.service.read(input)).credentialEpoch).toBe(changed.credentialEpoch);
      fixture.state.token = "fixture-token-1\n";
      const restored = yield* fixture.service.read(input);
      expect(restored.credentialEpoch).not.toBe(first.credentialEpoch);
      expect(fixture.calls.filter((call) => call.args[0] === "api")).toHaveLength(6);
      const restarted = yield* makeFixture();
      expect((yield* restarted.service.read(input)).credentialEpoch).not.toBe(
        restored.credentialEpoch,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("evicts the oldest of at most 32 account entries and isolates hosts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* fixture.service.read(input);
      for (let index = 2; index <= 33; index++) {
        fixture.state.user = encodeJson({ node_id: `NODE_${index}`, login: "alice" });
        yield* fixture.service.read(input);
      }
      fixture.state.user = encodeJson({ node_id: "NODE_1", login: "alice" });
      expect((yield* fixture.service.read(input)).credentialEpoch).not.toBe(first.credentialEpoch);
      fixture.state.status = authStatus([account("alice", "enterprise.example.test")]);
      const enterprise = yield* fixture.service.read({ ...input, host: "enterprise.example.test" });
      expect(enterprise.credentialEpoch).not.toBe(first.credentialEpoch);
      expect(fixture.calls.at(-1)?.env?.GH_HOST).toBe("enterprise.example.test");
    }).pipe(Effect.scoped),
  );

  it.effect("serializes account reads so older verification cannot overwrite a newer epoch", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let blocked = false;
      const fixture = yield* makeFixture((stage, command, fallback) =>
        Effect.gen(function* () {
          if (stage === "user" && !blocked) {
            blocked = true;
            expect(command.env?.GH_TOKEN).toBe("fixture-token-1");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return fallback;
        }),
      );
      const mutableInput = { ...input };
      const old = yield* fixture.service.read(mutableInput).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      mutableInput.host = "changed.example.test";
      mutableInput.cwd = "/changed-repo";
      fixture.state.token = "fixture-token-2\n";
      fixture.state.status = authStatus([account("bob"), account("alice", input.host, false)]);
      const attempted = yield* Deferred.make<void>();
      const newer = yield* Effect.gen(function* () {
        yield* Deferred.succeed(attempted, undefined);
        return yield* fixture.service.read({ ...input, accountLogin: "alice" });
      }).pipe(Effect.forkChild);
      yield* Deferred.await(attempted);
      expect(fixture.calls).toHaveLength(3);
      yield* Deferred.succeed(release, undefined);
      const previous = yield* Fiber.join(old);
      const current = yield* Fiber.join(newer);
      expect(previous.host).toBe(input.host);
      expect(previous.cwd).toBe(input.cwd);
      expect(previous.credentialEpoch).not.toBe(current.credentialEpoch);
      expect(Redacted.value(previous.token)).toBe("fixture-token-1");
      expect(Redacted.value(current.token)).toBe("fixture-token-2");
      expect(
        (yield* fixture.service.read({ ...input, accountLogin: "alice" })).credentialEpoch,
      ).toBe(current.credentialEpoch);
      const concurrent = yield* Effect.all(
        [
          fixture.service.read({ ...input, accountLogin: "alice" }),
          fixture.service.read({ ...input, accountLogin: "alice" }),
        ],
        { concurrency: 2 },
      );
      expect(concurrent.map((result) => result.credentialEpoch)).toEqual([
        current.credentialEpoch,
        current.credentialEpoch,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("scope closure denies both retained readers and an in-flight verification", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fixture = yield* makeFixture((stage, _command, fallback) =>
        Effect.gen(function* () {
          if (stage === "user") {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return fallback;
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const running = yield* fixture.service.read(input).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(running))._tag).toBe("Failure");
      expect((yield* fixture.service.read(input).pipe(Effect.flip)).reason).toBe("unavailable");
      expect(fixture.calls).toHaveLength(3);
      const restarted = yield* makeFixture();
      expect((yield* restarted.service.read(input)).credentialEpoch).toMatch(/^[a-f0-9-]{36}$/u);
    }).pipe(Effect.scoped),
  );
});
