import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Validate cwd with the server host's native path syntax without another service dependency.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { VcsProcessOutputLimitError, VcsProcessOutputReadError } from "@t3tools/contracts";

import * as ProcessRunner from "../processRunner.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { parseGitHubAuthStatus } from "../sourceControl/gitHubAuthStatus.ts";

const MAX_OUTPUT_BYTES = 16 * 1024;
const TIMEOUT_MS = 15_000;
const CACHE_CAPACITY = 32;
const Host = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  ),
);
const Login = Schema.String.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u),
);
const NodeId = Schema.String.check(Schema.isMaxLength(1024), Schema.isPattern(/^[\x21-\x7e]+$/u));
const Input = Schema.Struct({
  cwd: Schema.String.check(
    Schema.isMaxLength(4096),
    Schema.isPattern(/^[^\p{Cc}]+$/u),
    Schema.makeFilter(NodePath.isAbsolute),
  ),
  host: Host,
  expectedAccountNodeId: Schema.optional(NodeId),
  accountLogin: Schema.optional(Login),
});
const User = Schema.Struct({ node_id: NodeId, login: Login });
const decodeInput = Schema.decodeUnknownEffect(Input);
const decodeUser = Schema.decodeUnknownEffect(Schema.fromJsonString(User));
const isHost = Schema.is(Host);
const isLogin = Schema.is(Login);
const isOutputLimit = Schema.is(VcsProcessOutputLimitError);
const isOutputReadError = Schema.is(VcsProcessOutputReadError);
const encodeCacheKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Host, NodeId, Login])),
);

export class IssueCredentialSnapshotError extends Schema.TaggedError<IssueCredentialSnapshotError>()(
  "IssueCredentialSnapshotError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "unavailable",
      "authentication",
      "ambiguous",
      "account-mismatch",
      "invalid-response",
    ]),
  },
) {
  override get message(): string {
    return `GitHub issue credentials could not be verified (${this.reason}).`;
  }
}

export interface VerifiedIssueCredentialSnapshot {
  readonly cwd: string;
  readonly host: string;
  readonly accountNodeId: string;
  readonly accountLogin: string;
  readonly credentialEpoch: string;
  readonly token: Redacted.Redacted<string>;
}

export class ProjectIssueCredentialSnapshot extends Context.Service<
  ProjectIssueCredentialSnapshot,
  {
    readonly read: (
      input: typeof Input.Type,
    ) => Effect.Effect<VerifiedIssueCredentialSnapshot, IssueCredentialSnapshotError>;
  }
>()("t3/projectWork/ProjectIssueCredentialSnapshot") {}

const failure = (reason: IssueCredentialSnapshotError["reason"]) =>
  new IssueCredentialSnapshotError({ reason });

// Empty overrides suppress inherited credentials. GH_CONFIG_DIR remains server-owned.
const discoveryEnv = {
  GH_HOST: "",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
  GH_DEBUG: "",
  GH_PROMPT_DISABLED: "1",
};

const validOutput = (output: {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
}) =>
  !output.stdoutTruncated &&
  !output.stderrTruncated &&
  !output.stdoutInvalidUtf8 &&
  !output.stderrInvalidUtf8 &&
  Buffer.byteLength(output.stdout, "utf8") <= MAX_OUTPUT_BYTES &&
  Buffer.byteLength(output.stderr, "utf8") <= MAX_OUTPUT_BYTES;

/** @public Scoped construction captures the server's process and GitHub services. */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const github = yield* GitHubCli.GitHubCli;
  const lock = yield* Semaphore.make(1);
  const cache = new Map<
    string,
    { readonly token: Redacted.Redacted<string>; readonly epoch: string }
  >();
  let stopped = false;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopped = true;
      cache.clear();
    }),
  );

  const discover = Effect.fn("ProjectIssueCredentialSnapshot.discover")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    if (stopped) return yield* failure("unavailable");
    const output = yield* runner
      .run({
        command: "gh",
        args,
        cwd,
        env: { ...discoveryEnv },
        timeout: TIMEOUT_MS,
        timeoutBehavior: "error",
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "error",
        truncatedMarker: "",
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            error._tag === "ProcessOutputLimitError" || error._tag === "ProcessReadError"
              ? "invalid-response"
              : "unavailable",
          ),
        ),
      );
    if (stopped || output.timedOut) return yield* failure("unavailable");
    if (!validOutput(output)) return yield* failure("invalid-response");
    if (output.code !== 0) return yield* failure("authentication");
    return output.stdout;
  });

  const readLocked = Effect.fn("ProjectIssueCredentialSnapshot.readLocked")(function* (
    raw: typeof Input.Type,
  ) {
    if (stopped) return yield* failure("unavailable");
    const decoded = yield* decodeInput(raw).pipe(Effect.mapError(() => failure("invalid-input")));
    const input = { ...decoded };
    const status = parseGitHubAuthStatus(
      yield* discover(input.cwd, ["auth", "status", "--hostname", input.host, "--json", "hosts"]),
    );
    if (
      !status.parsed ||
      status.accounts.length > 128 ||
      status.accounts.some((account) => !isHost(account.host) || !isLogin(account.account))
    ) {
      return yield* failure("invalid-response");
    }
    const accounts = status.accounts.filter(
      (account) =>
        account.host === input.host &&
        account.authenticated &&
        account.error === null &&
        (input.accountLogin === undefined
          ? account.active
          : account.account === input.accountLogin),
    );
    if (accounts.length > 1) return yield* failure("ambiguous");
    const selected = accounts[0];
    if (selected === undefined) return yield* failure("authentication");
    const rawToken = yield* discover(input.cwd, [
      "auth",
      "token",
      "--hostname",
      input.host,
      "--user",
      selected.account,
    ]);
    const token = Redacted.make(rawToken.replace(/\r?\n$/u, ""));
    if (!/^[\x21-\x7e]+$/u.test(Redacted.value(token))) {
      return yield* failure("invalid-response");
    }
    // The verification request uses this captured token, even if gh's active user changes.
    const candidateEpoch = NodeCrypto.randomUUID();
    const output = yield* github
      .execute({
        cwd: input.cwd,
        args: ["api", "--hostname", input.host, "user"],
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        env: { ...discoveryEnv },
      })
      .pipe(
        Effect.provideService(GitHubCli.PinnedGitHubCredential, {
          host: input.host,
          token,
          credentialFingerprint: candidateEpoch,
        }),
        Effect.mapError((error) =>
          failure(
            error._tag === "GitHubCliAuthenticationError"
              ? "authentication"
              : isOutputLimit(error.cause) || isOutputReadError(error.cause)
                ? "invalid-response"
                : "unavailable",
          ),
        ),
      );
    if (stopped) return yield* failure("unavailable");
    if (output.exitCode !== 0 || !validOutput(output)) {
      return yield* failure("invalid-response");
    }
    const user = yield* decodeUser(output.stdout).pipe(
      Effect.mapError(() => failure("invalid-response")),
    );
    if (
      user.login !== selected.account ||
      (input.expectedAccountNodeId !== undefined && user.node_id !== input.expectedAccountNodeId)
    ) {
      return yield* failure("account-mismatch");
    }
    if (stopped) return yield* failure("unavailable");
    const key = encodeCacheKey([input.host, user.node_id, user.login]);
    const previous = cache.get(key);
    const credentialEpoch =
      previous !== undefined && Redacted.value(previous.token) === Redacted.value(token)
        ? previous.epoch
        : candidateEpoch;
    cache.delete(key);
    if (cache.size === CACHE_CAPACITY) cache.delete(cache.keys().next().value!);
    cache.set(key, { token, epoch: credentialEpoch });
    return {
      cwd: input.cwd,
      host: input.host,
      accountNodeId: user.node_id,
      accountLogin: user.login,
      credentialEpoch,
      token,
    } satisfies VerifiedIssueCredentialSnapshot;
  });

  const read: ProjectIssueCredentialSnapshot["Service"]["read"] = Effect.fn(
    "ProjectIssueCredentialSnapshot.read",
  )((input) => lock.withPermits(1)(readLocked(input)));
  return ProjectIssueCredentialSnapshot.of({ read });
});

export const layer = Layer.effect(ProjectIssueCredentialSnapshot, make);
