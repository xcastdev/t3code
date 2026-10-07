import {
  AuthOrchestrationOperateScope,
  PullRequestActionInput,
  canonicalProjectWorkPayload,
  type ProjectId,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { authIdentityForSession, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ManagedMergeError } from "./ProjectWorkManagedMergeJournal.ts";

const decode = Schema.decodeUnknownSync(PullRequestActionInput, { onExcessProperty: "error" });
const denied = () => new ManagedMergeError({ reason: "authorization-denied" });
export class ProjectWorkHumanMergeRequest extends Context.Service<
  ProjectWorkHumanMergeRequest,
  {
    readonly assertCurrent: (
      projectId: ProjectId,
      input: PullRequestActionInput,
    ) => Effect.Effect<ProjectWorkAttribution, ManagedMergeError>;
  }
>()("t3/projectWork/ProjectWorkHumanMergeRequest") {}

/** The permission belongs to the original authenticated RPC, never a serialized field. */
export const makeProjectWorkHumanMergeRequest = (
  session: AuthenticatedSession,
  input: PullRequestActionInput,
) => {
  const principal = {
    sessionId: session.sessionId,
    subject: session.subject,
    method: session.method,
    kind: session.identity.kind,
    id: session.identity.id,
    scopes: [...session.scopes],
    managed: session.managed !== undefined,
  };
  let captured: PullRequestActionInput | undefined;
  try {
    captured = decode(structuredClone(input));
    if (canonicalProjectWorkPayload(captured) !== canonicalProjectWorkPayload(input))
      captured = undefined;
  } catch {}
  return Effect.gen(function* () {
    const sessions = yield* AuthSessionRepository;
    const assert = Effect.fn("ProjectWorkHumanMergeRequest.assertCurrent")(function* (
      projectId: ProjectId,
      submitted: PullRequestActionInput | undefined,
    ) {
      if (
        !captured ||
        !submitted ||
        captured.action !== "merge" ||
        captured.stackNumber !== undefined ||
        captured.expectedStackHeads !== undefined ||
        !projectId.trim() ||
        submitted.projectId !== projectId ||
        canonicalProjectWorkPayload(captured) !== canonicalProjectWorkPayload(submitted) ||
        principal.kind !== "user" ||
        principal.managed ||
        principal.subject.startsWith("agent:") ||
        !principal.scopes.includes(AuthOrchestrationOperateScope)
      )
        return yield* denied();
      const retained = yield* sessions
        .getById({ sessionId: principal.sessionId })
        .pipe(Effect.mapError((cause) => new ManagedMergeError({ reason: "persistence", cause })));
      if (Option.isNone(retained)) return yield* denied();
      const row = retained.value;
      const now = yield* Clock.currentTimeMillis;
      if (
        row.subject !== principal.subject ||
        row.method !== principal.method ||
        row.revokedAt !== null ||
        !row.scopes.includes(AuthOrchestrationOperateScope) ||
        DateTime.toEpochMillis(row.expiresAt) <= now
      )
        return yield* denied();
      const identity = authIdentityForSession({
        subject: row.subject,
        client: { deviceType: row.client.deviceType },
      });
      if (identity.kind !== "user" || identity.id !== principal.id) return yield* denied();
      return {
        actor: { kind: "human" as const, id: principal.id },
        source: { kind: "web" as const, id: `project-work.merge:${principal.sessionId}` },
        recordedAt: DateTime.formatIso(yield* DateTime.now),
      };
    });
    return ProjectWorkHumanMergeRequest.of({
      assertCurrent(projectId, supplied) {
        let submitted: PullRequestActionInput | undefined;
        try {
          submitted = decode(structuredClone(supplied));
          if (canonicalProjectWorkPayload(submitted) !== canonicalProjectWorkPayload(supplied))
            submitted = undefined;
        } catch {}
        return assert(projectId, submitted);
      },
    });
  });
};
