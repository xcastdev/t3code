import type { ProjectWorkCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/** Text inserted when a derived/public representation contains a known secret. */
export const PROJECT_WORK_REDACTION_MARKER = "[REDACTED_SECRET]";

export interface ProjectWorkSecretMatch {
  readonly path: string;
  readonly kind:
    | "private-key"
    | "bearer-token"
    | "basic-credential"
    | "provider-token"
    | "credential-assignment"
    | "known-secret";
  readonly value: string;
}

export class ProjectWorkContentRejectedError extends Schema.TaggedError<ProjectWorkContentRejectedError>()(
  "ProjectWorkContentRejectedError",
  {
    matches: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        kind: Schema.String,
      }),
    ),
  },
) {
  override get message(): string {
    return "Project-work content contains a high-confidence secret and was rejected.";
  }
}
export const isProjectWorkContentRejectedError = Schema.is(ProjectWorkContentRejectedError);

const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const BEARER = /\bBearer\s+([A-Za-z0-9_./+=:-]{20,})/gu;
const BASIC = /\bBasic\s+([A-Za-z0-9+/]{20,}={0,2})/gu;
const PROVIDER_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/gu;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[-_ ]?key|access[-_ ]?token|auth(?:entication)?[-_ ]?token|client[-_ ]?secret|password|secret|token|credential)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=:@-]{20,})["']?/giu;
const URL_CREDENTIAL = /\bhttps?:\/\/[^\s/@:]+:([^\s/@]+)@[^\s]+/gu;

const PLACEHOLDER = /^(?:test|example|dummy|fake|sample|placeholder|redacted|secret)[-_ :]/iu;
const isSecretCandidate = (value: string): boolean =>
  value.length >= 20 && !PLACEHOLDER.test(value) && !/^\*+$/.test(value);

const replaceMatches = (
  value: string,
  path: string,
  matches: Array<ProjectWorkSecretMatch>,
): string => {
  const add = (kind: ProjectWorkSecretMatch["kind"], secret: string) => {
    if (!isSecretCandidate(secret)) return;
    if (!matches.some((match) => match.path === path && match.value === secret))
      matches.push({ path, kind, value: secret });
  };
  for (const match of value.matchAll(PRIVATE_KEY)) add("private-key", match[0]);
  for (const match of value.matchAll(BEARER)) add("bearer-token", match[1] ?? "");
  for (const match of value.matchAll(BASIC)) add("basic-credential", match[1] ?? "");
  for (const match of value.matchAll(PROVIDER_TOKEN)) add("provider-token", match[0]);
  for (const match of value.matchAll(CREDENTIAL_ASSIGNMENT))
    add("credential-assignment", match[1] ?? "");
  for (const match of value.matchAll(URL_CREDENTIAL)) add("basic-credential", match[1] ?? "");
  return value;
};

const walk = (value: unknown, path: string, matches: Array<ProjectWorkSecretMatch>): void => {
  if (typeof value === "string") {
    replaceMatches(value, path, matches);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, matches));
    return;
  }
  if (value !== null && typeof value === "object")
    Object.entries(value).forEach(([key, entry]) =>
      walk(entry, path === "$" ? `$.${key}` : `${path}.${key}`, matches),
    );
};

/** Finds only high-confidence credential formats; ordinary prose is ignored. */
export const findProjectWorkSecrets = (value: unknown): ReadonlyArray<ProjectWorkSecretMatch> => {
  const matches: Array<ProjectWorkSecretMatch> = [];
  walk(value, "$", matches);
  return matches;
};

const replaceAllLiteral = (value: string, secret: string): string =>
  secret.length < 4 ? value : value.replaceAll(secret, PROJECT_WORK_REDACTION_MARKER);

const redactValue = (
  value: unknown,
  knownSecrets: ReadonlyArray<string>,
  redactions: Set<string>,
  path: string,
): unknown => {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of knownSecrets) {
      if (secret.length >= 4 && redacted.includes(secret)) {
        redacted = replaceAllLiteral(redacted, secret);
        redactions.add(path);
      }
    }
    const matches = findProjectWorkSecrets(value);
    for (const match of matches) {
      redacted = replaceAllLiteral(redacted, match.value);
      redactions.add(path);
    }
    return redacted;
  }
  if (Array.isArray(value))
    return value.map((entry, index) =>
      redactValue(entry, knownSecrets, redactions, `${path}[${index}]`),
    );
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactValue(entry, knownSecrets, redactions, path === "$" ? `$.${key}` : `${path}.${key}`),
      ]),
    );
  return value;
};

const normalizeExportKey = (key: string): string =>
  key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

/** Only proof-bearing or credential value fields are removed. Domain data such
 * as approval records, approval ids, lease expiry, attribution and provenance
 * must survive an authoritative export. */
const EXPORT_CREDENTIAL_KEYS = new Set([
  "approvaltoken",
  "leasetoken",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "apikey",
  "clientsecret",
  "password",
  "credentials",
  "authorization",
  "authentication",
]);

const isExportCredentialKey = (key: string): boolean =>
  EXPORT_CREDENTIAL_KEYS.has(normalizeExportKey(key));

const redactExportValue = (
  value: unknown,
  knownSecrets: ReadonlyArray<string>,
  redactions: Set<string>,
  path: string,
): unknown => {
  if (Array.isArray(value))
    return value.map((entry, index) =>
      redactExportValue(entry, knownSecrets, redactions, `${path}[${index}]`),
    );
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const entryPath = path === "$" ? `$.${key}` : `${path}.${key}`;
        if (isExportCredentialKey(key)) {
          redactions.add(entryPath);
          return [];
        }
        return [[key, redactExportValue(entry, knownSecrets, redactions, entryPath)]];
      }),
    );
  }
  return redactValue(value, knownSecrets, redactions, path);
};

/** Export-specific defense in depth: bearer fields are removed regardless of
 * their value, then credential-shaped and newly known values are redacted. */
export const redactProjectWorkExportContent = (
  value: unknown,
  knownSecrets: ReadonlyArray<string> = [],
): { readonly value: unknown; readonly redactions: ReadonlyArray<string> } => {
  const redactions = new Set<string>();
  return {
    value: redactExportValue(value, knownSecrets, redactions, "$"),
    redactions: [...redactions].sort(),
  };
};

export const redactProjectWorkContent = (
  value: unknown,
  knownSecrets: ReadonlyArray<string> = [],
): { readonly value: unknown; readonly redactions: ReadonlyArray<string> } => {
  const redactions = new Set<string>();
  return {
    value: redactValue(value, knownSecrets, redactions, "$"),
    redactions: [...redactions].sort(),
  };
};

export const assertProjectWorkContentSafe = (value: unknown): void => {
  const matches = findProjectWorkSecrets(value);
  if (matches.length > 0)
    throw new ProjectWorkContentRejectedError({
      matches: matches.map(({ path, kind }) => ({ path, kind })),
    });
};

const findKnownSecretMatches = (
  value: unknown,
  knownSecrets: ReadonlyArray<string>,
): ReadonlyArray<ProjectWorkSecretMatch> => {
  const matches: Array<ProjectWorkSecretMatch> = [];
  const visit = (entry: unknown, path: string): void => {
    if (typeof entry === "string") {
      for (const secret of knownSecrets)
        if (secret.length >= 4 && entry.includes(secret))
          matches.push({ path, kind: "known-secret", value: secret });
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (entry !== null && typeof entry === "object")
      Object.entries(entry).forEach(([key, item]) =>
        visit(item, path === "$" ? `$.${key}` : `${path}.${key}`),
      );
  };
  visit(value, "$");
  return matches;
};

/** Approval proofs are transport credentials, not project content. */
export const assertProjectWorkCommandContentSafe = (command: ProjectWorkCommand): void => {
  const { approvalToken: _approvalToken, ...content } = command as ProjectWorkCommand & {
    readonly approvalToken?: string;
  };
  assertProjectWorkContentSafe(content);
};

export interface ProjectWorkContentGuardShape {
  readonly assertSafe: (value: unknown) => Effect.Effect<void, ProjectWorkContentRejectedError>;
  readonly redact: (
    value: unknown,
    knownSecrets?: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly value: unknown; readonly redactions: ReadonlyArray<string> }>;
  /** Notify derived caches when a credential becomes known outside project work. */
  readonly registerKnownSecrets: (secrets: ReadonlyArray<string>) => Effect.Effect<number>;
  readonly knownSecrets: Effect.Effect<ReadonlyArray<string>>;
  /** Register a derived-cache scrubber without coupling the guard to a cache. */
  readonly registerScrubber: (
    scrubber: (secrets: ReadonlyArray<string>) => Effect.Effect<number>,
  ) => Effect.Effect<void>;
  readonly assertCommandSafe: (
    command: ProjectWorkCommand,
  ) => Effect.Effect<void, ProjectWorkContentRejectedError>;
}

export class ProjectWorkContentGuard extends Context.Service<
  ProjectWorkContentGuard,
  ProjectWorkContentGuardShape
>()("t3/projectWork/ProjectWorkContentGuard") {}

export const layer = Layer.effect(
  ProjectWorkContentGuard,
  Effect.gen(function* () {
    const known = yield* Ref.make(new Set<string>());
    const scrubbers = new Set<(secrets: ReadonlyArray<string>) => Effect.Effect<number>>();
    const assertSafe: ProjectWorkContentGuardShape["assertSafe"] = (value) =>
      Effect.gen(function* () {
        const secrets = yield* Ref.get(known);
        yield* Effect.try({
          try: () => {
            const matches = [
              ...findProjectWorkSecrets(value),
              ...findKnownSecretMatches(value, [...secrets]),
            ];
            if (matches.length > 0)
              throw new ProjectWorkContentRejectedError({
                matches: matches.map(({ path, kind }) => ({ path, kind })),
              });
          },
          catch: (cause) =>
            isProjectWorkContentRejectedError(cause)
              ? cause
              : new ProjectWorkContentRejectedError({ matches: [] }),
        });
        // A caller may register a secret after this check; the shared set is
        // also used by redaction, so this read intentionally stays explicit.
        void secrets;
      });
    const registerKnownSecrets: ProjectWorkContentGuardShape["registerKnownSecrets"] = (secrets) =>
      Effect.gen(function* () {
        const additions = yield* Ref.modify(known, (current) => {
          const nextAdditions = [
            ...new Set(
              secrets.filter(
                (secret) => secret.length >= 4 && !/^\*+$/u.test(secret) && !current.has(secret),
              ),
            ),
          ];
          if (nextAdditions.length === 0) return [nextAdditions, current] as const;
          const next = new Set(current);
          for (const secret of nextAdditions) next.add(secret);
          return [nextAdditions, next] as const;
        });
        if (additions.length === 0) return 0;
        let removed = 0;
        for (const scrub of scrubbers) removed += yield* scrub(additions);
        return removed;
      });
    return {
      assertSafe,
      redact: (value, providedSecrets = []) =>
        Ref.get(known).pipe(
          Effect.map((stored) => redactProjectWorkContent(value, [...stored, ...providedSecrets])),
        ),
      registerKnownSecrets,
      knownSecrets: Ref.get(known).pipe(Effect.map((values) => [...values])),
      registerScrubber: (scrubber) => Effect.sync(() => void scrubbers.add(scrubber)),
      assertCommandSafe: (command) => {
        const { approvalToken: _approvalToken, ...content } = command as ProjectWorkCommand & {
          readonly approvalToken?: string;
        };
        return assertSafe(content);
      },
    } satisfies ProjectWorkContentGuardShape;
  }),
);
