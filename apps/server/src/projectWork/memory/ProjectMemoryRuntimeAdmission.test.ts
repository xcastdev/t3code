import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeProjectMemoryRuntimeAdmission } from "./ProjectMemoryRuntimeAdmission.ts";
import { ProjectMemoryServiceError } from "./ProjectMemoryService.ts";

const enabled = { projectWorkEnabled: true, projectTeamExecutionEnabled: true };

// Injectable boundary controls only; these do not exercise the runtime or SQL owners.
const controlledForward = (assertAdmission: Effect.Effect<void, ProjectMemoryServiceError>) => {
  const calls = { allocations: 0, transports: 0 };
  const forward = Effect.gen(function* () {
    yield* assertAdmission;
    yield* Effect.sync(() => {
      calls.allocations++;
    });
    yield* Effect.sync(() => {
      calls.transports++;
    });
  });
  return { calls, forward };
};

it.effect("replaces the unavailable guard with readiness without requiring a live bridge", () =>
  Effect.gen(function* () {
    const oldGuard = controlledForward(
      Effect.fail(
        new ProjectMemoryServiceError({
          reason:
            "Memory processing awaits authorized runtime activation, companion provisioning and runtime proof",
        }),
      ),
    );
    expect((yield* Effect.result(oldGuard.forward))._tag).toBe("Failure");
    expect(oldGuard.calls).toEqual({ allocations: 0, transports: 0 });

    let settingsReads = 0;
    const { assertAdmission } = makeProjectMemoryRuntimeAdmission({
      platform: "linux",
      userId: 1000,
      readSettings: Effect.sync(() => {
        settingsReads++;
        return enabled;
      }),
    });
    const current = controlledForward(assertAdmission);
    expect(settingsReads).toBe(0);
    yield* assertAdmission;
    expect(settingsReads).toBe(1);
    expect(current.calls).toEqual({ allocations: 0, transports: 0 });
    yield* current.forward;
    expect(settingsReads).toBe(2);
    expect(current.calls).toEqual({ allocations: 1, transports: 1 });
  }),
);

it.effect(
  "accepts uid zero",
  () =>
    makeProjectMemoryRuntimeAdmission({
      platform: "linux",
      userId: 0,
      readSettings: Effect.succeed(enabled),
    }).assertAdmission,
);

for (const platform of [
  "darwin",
  "win32",
  "freebsd",
  "aix",
  "openbsd",
  "sunos",
  "android",
  "haiku",
] as const) {
  it.effect(`denies unsupported platform ${platform} before controlled work`, () =>
    Effect.gen(function* () {
      const { assertAdmission } = makeProjectMemoryRuntimeAdmission({
        platform,
        userId: 1000,
        readSettings: Effect.succeed(enabled),
      });
      const boundary = controlledForward(assertAdmission);
      const result = yield* Effect.result(boundary.forward);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("ProjectMemoryServiceError");
      expect(boundary.calls).toEqual({ allocations: 0, transports: 0 });
    }),
  );
}

for (const userId of [
  undefined,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
]) {
  it.effect(`denies invalid or missing uid ${userId} before controlled work`, () =>
    Effect.gen(function* () {
      const { assertAdmission } = makeProjectMemoryRuntimeAdmission({
        platform: "linux",
        userId,
        readSettings: Effect.succeed(enabled),
      });
      const boundary = controlledForward(assertAdmission);
      expect((yield* Effect.result(boundary.forward))._tag).toBe("Failure");
      expect(boundary.calls).toEqual({ allocations: 0, transports: 0 });
    }),
  );
}

for (const settings of [
  { projectWorkEnabled: false, projectTeamExecutionEnabled: true },
  { projectWorkEnabled: true, projectTeamExecutionEnabled: false },
  { projectWorkEnabled: false, projectTeamExecutionEnabled: false },
]) {
  it.effect(`denies disabled settings ${JSON.stringify(settings)} before controlled work`, () =>
    Effect.gen(function* () {
      const { assertAdmission } = makeProjectMemoryRuntimeAdmission({
        platform: "linux",
        userId: 1000,
        readSettings: Effect.succeed(settings),
      });
      const boundary = controlledForward(assertAdmission);
      expect((yield* Effect.result(boundary.forward))._tag).toBe("Failure");
      expect(boundary.calls).toEqual({ allocations: 0, transports: 0 });
    }),
  );
}

for (const setting of ["projectWorkEnabled", "projectTeamExecutionEnabled"] as const) {
  it.effect(`rechecks ${setting} after readiness and permits reenable`, () =>
    Effect.gen(function* () {
      let settings = { ...enabled };
      const { assertAdmission } = makeProjectMemoryRuntimeAdmission({
        platform: "linux",
        userId: 1000,
        readSettings: Effect.sync(() => settings),
      });
      yield* assertAdmission;
      settings = { ...enabled, [setting]: false };
      const boundary = controlledForward(assertAdmission);
      expect((yield* Effect.result(boundary.forward))._tag).toBe("Failure");
      expect(boundary.calls).toEqual({ allocations: 0, transports: 0 });
      settings = { ...enabled };
      yield* boundary.forward;
      expect(boundary.calls).toEqual({ allocations: 1, transports: 1 });
    }),
  );
}

it.effect("propagates a current settings read failure before controlled work", () =>
  Effect.gen(function* () {
    const failure = new ProjectMemoryServiceError({ reason: "Controlled settings read failure" });
    let failRead = false;
    const { assertAdmission } = makeProjectMemoryRuntimeAdmission({
      platform: "linux",
      userId: 1000,
      readSettings: Effect.suspend(() =>
        failRead ? Effect.fail(failure) : Effect.succeed(enabled),
      ),
    });
    yield* assertAdmission;
    failRead = true;
    const boundary = controlledForward(assertAdmission);
    const result = yield* Effect.result(boundary.forward);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe(failure);
    expect(boundary.calls).toEqual({ allocations: 0, transports: 0 });
  }),
);
