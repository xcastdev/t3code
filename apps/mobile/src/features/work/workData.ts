import { ProjectWorkTaskRead, type ProjectId } from "@t3tools/contracts";
import {
  asProjectWorkPage,
  asProjectWorkFoundationPage,
  combineProjectWorkFoundationPages,
} from "@t3tools/client-runtime/project-work";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
const decodeTasks = Schema.decodeUnknownOption(
  Schema.Array(ProjectWorkTaskRead).check(Schema.isMaxLength(51)),
);

export function mobileTaskPage(value: unknown, projectId: ProjectId, offset: number) {
  if (value === null || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  if (
    !Array.isArray(value) &&
    (envelope.projectId !== projectId ||
      envelope.offset !== offset ||
      typeof envelope.revision !== "number" ||
      !Number.isSafeInteger(envelope.revision) ||
      envelope.revision < 0)
  )
    return null;
  const decoded = decodeTasks(Array.isArray(value) ? value : envelope.items);
  if (Option.isNone(decoded) || decoded.value.some((task) => task.projectId !== projectId))
    return null;
  return asProjectWorkPage<ProjectWorkTaskRead>(
    Array.isArray(value) ? decoded.value : { ...envelope, items: decoded.value },
    offset,
  );
}
export function mobileFoundationView<E>(
  projectId: ProjectId,
  cursors: ReadonlyArray<string | undefined>,
  values: ReadonlyArray<AsyncResult.AsyncResult<unknown, E>>,
) {
  const snapshot = combineProjectWorkFoundationPages({
    projectId,
    pages: values.map((value, index) => ({
      ...(cursors[index] === undefined ? {} : { cursor: cursors[index] }),
      value: Option.getOrNull(AsyncResult.value(value)),
    })),
  });
  return {
    snapshot,
    loading: values.some((value) => value._tag === "Initial" || value.waiting),
    current:
      values.length > 0 &&
      values.every((value) => value._tag === "Success" && !value.waiting) &&
      snapshot.complete &&
      snapshot.error === null,
  };
}

/** Advance a bounded cursor chain or restart once after an aggregate revision changes. */
export function mobileFoundationProgress<E>(
  projectId: ProjectId,
  cursors: ReadonlyArray<string | undefined>,
  values: ReadonlyArray<AsyncResult.AsyncResult<unknown, E>>,
  resetKey: string | null,
) {
  const view = mobileFoundationView(projectId, cursors, values);
  const page = (value: AsyncResult.AsyncResult<unknown, E> | undefined) =>
    asProjectWorkFoundationPage(
      value === undefined ? null : Option.getOrNull(AsyncResult.value(value)),
      projectId,
    );
  const first = page(values[0]);
  const last = page(values.at(-1));
  const key = JSON.stringify([first?.revision, first?.nextCursor]);
  if (
    (view.snapshot.error === "revision-changed" ||
      (cursors.length > 1 && first?.nextCursor !== cursors[1])) &&
    resetKey !== key
  )
    return { cursors: [undefined], resetKey: key, restart: true };
  if (
    values.length > 0 &&
    values.every((value) => value._tag === "Success" && !value.waiting) &&
    view.snapshot.error === null &&
    last?.nextCursor !== undefined &&
    cursors.length < 16 &&
    !cursors.includes(last.nextCursor)
  )
    return { cursors: [...cursors, last.nextCursor], resetKey, restart: false };
  return { cursors, resetKey, restart: false };
}
