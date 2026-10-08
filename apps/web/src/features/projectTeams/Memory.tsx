import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProjectTeamRecord,
  ProjectMemorySourceRead,
  ProjectMemoryObservationRead,
  ProjectMemoryExtractionRead,
  ProjectTeamEffect,
  CommandId,
  ProjectTeamMemoryRetractIntent,
  ProjectWorkWriteResult,
  type EnvironmentId,
  type ProjectId,
  type ProjectTeamRecordRead,
  type ProjectWorkAttributionRead,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { WorkCard } from "../../components/work/WorkDataNotice";
import {
  WorkTeamFoundation,
  type WorkTeamFoundationView,
} from "../../components/work/WorkTeamFoundation";
import { projectWorkEnvironment } from "../../state/projectWork";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkCommandFailure } from "../../components/work/workCommandFailure";
import { randomUUID } from "../../lib/utils";

const knownRecord = Schema.is(ProjectTeamRecord);
const sourceRecord = Schema.is(ProjectMemorySourceRead);
const observationRecord = Schema.is(ProjectMemoryObservationRead);
const extractionRecord = Schema.is(ProjectMemoryExtractionRead);
const effectRecord = Schema.is(
  Schema.Struct({ ...ProjectTeamEffect.fields, status: Schema.String, effectKind: Schema.String }),
);
const PAGE_SIZE = 64;
const decodeRetraction = Schema.decodeUnknownSync(ProjectTeamMemoryRetractIntent, {
  onExcessProperty: "error",
});
const decodeReceipt = Schema.decodeSync(ProjectWorkWriteResult);
const definiteRejection = Schema.is(
  Schema.Union([
    Schema.Struct({
      _tag: Schema.Literals(["ProjectTeamAuthorizationError", "ProjectWorkAuthorizationError"]),
      reason: Schema.String,
    }),
    Schema.Struct({
      _tag: Schema.Literal("ProjectWorkContentRejectedError"),
      matches: Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String })),
    }),
  ]),
);
function rejectedWrite(error: unknown) {
  return (
    definiteRejection(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "stale-revision",
        "invalid-state",
        "permission-denied",
        "forbidden",
        "unauthorized",
        "not-found",
        "invalid-request",
        "authority-required",
      ].includes(error.code))
  );
}
type Submission = {
  readonly command: ProjectTeamMemoryRetractIntent;
  readonly status: "sending" | "uncertain" | "accepted";
  readonly receiptRevision?: number;
};
type Source = Extract<ProjectTeamRecordRead, { kind: "memory-source" }>;
type Observation = Extract<ProjectTeamRecordRead, { kind: "memory-observation" }>;
type MemoryRecord = Extract<
  ProjectTeamRecordRead,
  { kind: "memory-source" | "memory-observation" | "memory-extraction" | "effect" }
>;

export interface MemoryProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly writesSupported?: boolean;
}

/** Inspect recorded memory without contacting the derived retrieval service. */
export function Memory(props: MemoryProps) {
  if (!props.supported) return <p>This environment does not support memory inspection.</p>;
  return (
    <WorkTeamFoundation {...props}>
      {(foundation) => (
        <MemorySnapshot
          key={JSON.stringify([props.environmentId, props.projectId])}
          {...props}
          foundation={foundation}
        />
      )}
    </WorkTeamFoundation>
  );
}

function provenance(value: ProjectWorkAttributionRead) {
  return `${value.actor.displayName ?? value.actor.id ?? value.actor.kind} · ${value.source.kind}${value.source.id ? ` ${value.source.id}` : ""}${value.source.uri ? ` · ${value.source.uri}` : ""} · Recorded ${value.recordedAt}`;
}

function memoryRecords(records: ReadonlyArray<ProjectTeamRecordRead>, projectId: ProjectId) {
  return records.filter(
    (record): record is MemoryRecord =>
      record.projectId === projectId &&
      (sourceRecord(record) ||
        observationRecord(record) ||
        extractionRecord(record) ||
        (effectRecord(record) &&
          (record.effectKind === "memory-index" || record.effectKind === "memory-delete"))),
  );
}

/** Retraction of a correction never revives its predecessor. */
function supersession(records: ReadonlyArray<MemoryRecord>) {
  const versions = records.filter(
    (record) => record.kind === "memory-source" || record.kind === "memory-observation",
  );
  const byId = new Map(versions.map((record) => [record.recordId, record]));
  const superseded = new Set<string>();
  const checked = new Set<string>();
  for (const record of versions) {
    const path = new Set<string>();
    let cursor: Source | Observation | undefined = record;
    while (cursor && !checked.has(cursor.recordId)) {
      if (path.has(cursor.recordId)) return { superseded, valid: false };
      path.add(cursor.recordId);
      if (cursor.supersedes === undefined) break;
      const previous = byId.get(cursor.supersedes);
      if (
        !previous ||
        previous.kind !== cursor.kind ||
        previous.projectId !== cursor.projectId ||
        (previous.kind === "memory-source" &&
          cursor.kind === "memory-source" &&
          previous.sourceId !== cursor.sourceId)
      )
        return { superseded, valid: false };
      superseded.add(previous.recordId);
      cursor = previous;
    }
    for (const id of path) checked.add(id);
  }
  return { superseded, valid: true };
}

function sourceUnavailable(
  source: Source,
  sources: ReadonlyArray<Source>,
  superseded: ReadonlySet<string>,
) {
  if (!knownRecord(source)) return "Unsupported source state";
  if (source.tombstonedAt !== undefined || source.status === "retracted") return "Retracted";
  if (source.status === "conflicted") return "Conflicted";
  if (source.status === "superseded" || superseded.has(source.recordId)) return "Superseded";
  if (![source.generation, source.sourceRevision].every(Number.isSafeInteger))
    return "Invalid source version";
  const versions = sources.filter((candidate) => candidate.sourceId === source.sourceId);
  if (
    versions.some(
      (candidate) => candidate.tombstonedAt !== undefined || candidate.status === "retracted",
    )
  )
    return "Logical source retracted";
  if (
    versions.some((candidate) => candidate.status === "conflicted") ||
    versions.filter(
      (candidate) => candidate.status === "current" && !superseded.has(candidate.recordId),
    ).length !== 1
  )
    return "Conflicting source history";
  if (
    versions.some(
      (candidate) =>
        candidate.generation > source.generation ||
        candidate.sourceRevision > source.sourceRevision,
    )
  )
    return "Newer source version recorded";
  return null;
}

function contentUnavailable(
  record: MemoryRecord,
  records: ReadonlyArray<MemoryRecord>,
  fresh: boolean,
) {
  if (!fresh) return "A complete fresh connected snapshot is required.";
  const chain = supersession(records);
  if (!chain.valid) return "Invalid or incomplete supersession history.";
  const sources = records.filter((item) => item.kind === "memory-source");
  if (record.kind === "memory-source") return sourceUnavailable(record, sources, chain.superseded);
  if (record.kind !== "memory-observation") return null;
  if (!knownRecord(record)) return "Unsupported observation state";
  if (record.tombstonedAt !== undefined || record.status === "retracted") return "Retracted";
  if (record.status === "conflicted") return "Conflicted";
  if (record.status === "superseded" || chain.superseded.has(record.recordId)) return "Superseded";
  const versions = records.filter(
    (item): item is Observation =>
      item.kind === "memory-observation" &&
      item.sourceId === record.sourceId &&
      item.observationKey === record.observationKey,
  );
  if (
    versions.some((item) => item.status === "conflicted") ||
    versions.filter(
      (item) =>
        item.status === "current" &&
        item.tombstonedAt === undefined &&
        !chain.superseded.has(item.recordId),
    ).length !== 1
  )
    return "Conflicting observation history";
  const source = sources.find((item) => item.recordId === record.sourceId);
  if (!source) return "Source not available in this project snapshot";
  const unavailable = sourceUnavailable(source, sources, chain.superseded);
  if (unavailable) return unavailable;
  if (
    record.sourceRevision !== source.sourceRevision ||
    record.sourceGeneration !== source.generation
  )
    return "Stale source revision or generation";
  const extraction = records.find(
    (item) => item.kind === "memory-extraction" && item.recordId === record.extractionId,
  );
  if (
    extraction?.kind !== "memory-extraction" ||
    !knownRecord(extraction) ||
    (extraction.status !== "extracted" && extraction.status !== "indexed") ||
    extraction.sourceId !== source.recordId ||
    extraction.sourceRevision !== source.sourceRevision ||
    extraction.sourceGeneration !== source.generation ||
    !extraction.extractionHash ||
    !extraction.expectedObservationIds.includes(record.recordId) ||
    (extraction.status === "indexed" &&
      !extraction.completedObservationIds.includes(record.recordId))
  )
    return "Matching successful extraction not available";
  return null;
}

function MemorySnapshot(props: MemoryProps & { readonly foundation: WorkTeamFoundationView }) {
  const atom = projectWorkEnvironment.foundationPage({
    environmentId: props.environmentId,
    projectId: props.projectId,
  });
  const result = useAtomValue(atom);
  const active = props.connected && props.enabled;
  const [epoch, setEpoch] = useState({ active, blocked: result });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspectedSource, setInspectedSource] = useState<Source | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const pending = useRef<Submission | null>(null);
  const owner = useRef(false);
  const access = useRef(props);
  useLayoutEffect(() => {
    access.current = props;
  });
  const [notice, setNotice] = useState("");
  const write = useAtomCommand(projectWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  useLayoutEffect(() => {
    owner.current = true;
    return () => {
      owner.current = false;
    };
  }, []);
  const store = (value: Submission | null) => {
    pending.current = value;
    setSubmission(value);
  };
  if (epoch.active !== active) setEpoch({ active, blocked: result });
  const refresh = useEffectEvent(() => props.foundation.refresh());
  // Cached success from an earlier connection is not a fresh read receipt.
  useLayoutEffect(() => {
    if (active) refresh();
  }, [active]);
  const fresh =
    active &&
    epoch.active === active &&
    result !== epoch.blocked &&
    result._tag === "Success" &&
    !result.waiting &&
    props.foundation.current;
  const records = memoryRecords(props.foundation.snapshot.records, props.projectId);
  const start = offset < records.length ? offset : 0;
  const selectedRecord = records.find((record) => record.recordId === selected);
  const updatedAt = records.reduce(
    (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
    "",
  );
  const unknown = props.foundation.snapshot.records.some((record) => !knownRecord(record));
  const locallySuppressed =
    selectedRecord !== undefined &&
    submission !== null &&
    (selectedRecord.recordId === submission.command.sourceRecordId ||
      (selectedRecord.kind === "memory-observation" &&
        selectedRecord.sourceId === submission.command.sourceRecordId));
  const unavailable = locallySuppressed
    ? "Retraction submitted; waiting for the recorded state."
    : selectedRecord
      ? contentUnavailable(selectedRecord, records, fresh)
      : null;
  const command = submission?.command;
  const recorded =
    command === undefined
      ? undefined
      : records.find((record) => record.recordId === command.sourceRecordId);
  const recordedRetraction =
    fresh &&
    submission?.status === "accepted" &&
    command !== undefined &&
    recorded !== undefined &&
    knownRecord(recorded) &&
    recorded.kind === "memory-source" &&
    recorded.status === "retracted" &&
    recorded.tombstonedAt !== undefined &&
    recorded.revision === command.expectedSourceRecordRevision + 1 &&
    recorded.generation === command.sourceGeneration + 1 &&
    recorded.sourceRevision === command.sourceRevision &&
    recorded.sharedWithProjectIds.length === 0 &&
    (props.foundation.snapshot.revision ?? -1) >= (submission.receiptRevision ?? Infinity);
  async function retract(retry: boolean) {
    let command: ProjectTeamMemoryRetractIntent | undefined;
    let rejected = false;
    try {
      const current = access.current;
      if (
        !owner.current ||
        !current.connected ||
        !current.enabled ||
        !current.supported ||
        !current.writesSupported ||
        !fresh
      )
        throw new Error("A complete fresh connected writable snapshot is required.");
      const snapshot = current.foundation.verify();
      if (retry) {
        if (pending.current?.status !== "uncertain") return;
        command = pending.current.command;
      } else {
        if (
          (pending.current !== null && !recordedRetraction) ||
          selectedRecord?.kind !== "memory-source" ||
          inspectedSource === null ||
          contentUnavailable(selectedRecord, records, fresh) !== null
        )
          return;
        const selectedNow = snapshot.records.find(
          (record) => record.recordId === selectedRecord.recordId,
        );
        if (
          selectedNow === undefined ||
          !knownRecord(selectedNow) ||
          selectedNow.kind !== "memory-source" ||
          selectedNow.status !== "current" ||
          selectedNow.tombstonedAt !== undefined ||
          selectedNow.revision !== inspectedSource.revision ||
          selectedNow.generation !== inspectedSource.generation ||
          selectedNow.sourceRevision !== inspectedSource.sourceRevision ||
          selectedNow.contentHash !== inspectedSource.contentHash
        )
          throw new Error(
            "The inspected source changed. Refresh and inspect the current source before retracting.",
          );
        command = decodeRetraction({
          type: "project-team.memory.retract",
          commandId: CommandId.make(randomUUID()),
          projectId: props.projectId,
          expectedRevision: snapshot.revision,
          sourceRecordId: selectedRecord.recordId,
          expectedSourceRecordRevision: selectedRecord.revision,
          sourceRevision: selectedRecord.sourceRevision,
          sourceGeneration: selectedRecord.generation,
          contentHash: selectedRecord.contentHash,
        });
      }
      store({ command, status: "sending" });
      setNotice("Retracting memory. Waiting for the authoritative receipt.");
      const outcome = await write({ environmentId: props.environmentId, input: command });
      if (!owner.current || pending.current?.command !== command) return;
      if (outcome._tag === "Failure") {
        rejected =
          outcome.cause.reasons.length > 0 &&
          outcome.cause.reasons.every(
            (reason) => reason._tag === "Fail" && rejectedWrite(reason.error),
          );
        throw squashAtomCommandFailure(outcome);
      }
      const receipt = decodeReceipt(outcome.value);
      if (
        receipt.projectId !== command.projectId ||
        receipt.receipt.projectId !== command.projectId ||
        receipt.receipt.commandId !== command.commandId ||
        receipt.receipt.status !== "accepted" ||
        receipt.receipt.eventCount !== 2 ||
        receipt.revision !== receipt.receipt.revision ||
        receipt.revision !== command.expectedRevision + 2
      )
        throw new Error(
          "Memory retraction receipt could not be verified. Retry the exact command.",
        );
      store({ command, status: "accepted", receiptRevision: receipt.revision });
      setNotice(
        "Memory retracted locally. Backend cleanup pending; waiting for the recorded state.",
      );
      access.current.foundation.refresh();
    } catch (error) {
      if (!owner.current) return;
      if (command !== undefined && pending.current?.command === command) {
        store(rejected ? null : { command, status: "uncertain" });
      }
      setNotice(
        rejected
          ? "Memory retraction was rejected. Refresh the recorded source and check your write permission."
          : projectWorkCommandFailure(error).message,
      );
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Memory</h2>
        <p className="text-sm text-muted-foreground">
          {fresh ? "Current recorded memory" : "Cached or incomplete memory"}
          {updatedAt ? ` · Last recorded update ${updatedAt}` : ""}
        </p>
        {!props.enabled ? (
          <p>Project Work is disabled. Enable it to inspect current memory content.</p>
        ) : null}
        {!fresh ? (
          <p>
            Source and observation content is hidden until a complete fresh connected snapshot is
            available.
          </p>
        ) : null}
        {unknown ? (
          <p>Unsupported records are present. Current memory content is unavailable.</p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Observations are extracted knowledge, not accepted decisions. Index and deletion states
          are recorded outcomes; retrieval health and physical cleanup are not verified here.
        </p>
        <Button size="sm" variant="outline" disabled={!active} onClick={props.foundation.refresh}>
          Refresh memory
        </Button>
        {notice ? (
          <p role="status">
            {recordedRetraction
              ? "Memory retracted locally. Backend cleanup requires an approved task; inspect its recorded deletion outcome."
              : notice}
          </p>
        ) : null}
        {submission?.status === "uncertain" ? (
          <Button disabled={!fresh || !props.writesSupported} onClick={() => void retract(true)}>
            Retry exact retraction
          </Button>
        ) : null}
      </div>
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No memory records available in this snapshot.
        </p>
      ) : null}
      {records.slice(start, start + PAGE_SIZE).map((record) => (
        <WorkCard key={record.recordId}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all font-medium">
              {record.kind === "effect" ? record.effectKind : record.kind.slice(7)} ·{" "}
              {record.recordId}
            </h3>
            <Badge variant="outline">Recorded {record.status}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Revision {record.revision} · Generation {record.generation} · Updated {record.updatedAt}
          </p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            aria-pressed={selected === record.recordId}
            onClick={() => {
              setSelected(selected === record.recordId ? null : record.recordId);
              setInspectedSource(record.kind === "memory-source" ? record : null);
              if (recordedRetraction) store(null);
            }}
          >
            Inspect {record.recordId}
          </Button>
        </WorkCard>
      ))}
      {selectedRecord ? (
        <WorkCard>
          <h3 className="break-all font-medium">Inspecting {selectedRecord.recordId}</h3>
          <RecordMetadata record={selectedRecord} />
          {selectedRecord.kind === "memory-source" ||
          selectedRecord.kind === "memory-observation" ? (
            unavailable ? (
              <p className="mt-3">Content hidden: {unavailable}</p>
            ) : (
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-sm">
                {selectedRecord.kind === "memory-source"
                  ? selectedRecord.content
                  : selectedRecord.body}
              </pre>
            )
          ) : null}
          {selectedRecord.kind === "memory-source" && sourceRecord(selectedRecord) ? (
            <div className="mt-3">
              <p>
                Retract this memory copy and revoke its shares. The underlying issue, decision or
                evidence is preserved. Physical cleanup waits for an approved task.
              </p>
              <Button
                disabled={
                  !fresh ||
                  !props.writesSupported ||
                  (submission !== null && !recordedRetraction) ||
                  unavailable !== null
                }
                onClick={() => void retract(false)}
              >
                Retract memory
              </Button>
              {!props.writesSupported ? (
                <p>This environment does not support human memory writes.</p>
              ) : null}
            </div>
          ) : null}
          <Button className="mt-3" size="sm" variant="outline" onClick={() => setSelected(null)}>
            Close inspection
          </Button>
        </WorkCard>
      ) : null}
      <div className="flex gap-2">
        {start > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOffset(start - PAGE_SIZE);
              setSelected(null);
            }}
          >
            Previous memory page
          </Button>
        ) : null}
        {start + PAGE_SIZE < records.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOffset(start + PAGE_SIZE);
              setSelected(null);
            }}
          >
            Next memory page
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RecordMetadata({ record }: { readonly record: MemoryRecord }) {
  if (record.kind === "memory-source")
    return (
      <div className="mt-3 flex flex-col gap-2 break-all text-sm">
        <p>
          Source {record.sourceKind} · Logical source {record.sourceId} · Source revision{" "}
          {record.sourceRevision} · Hash {record.contentHash}
        </p>
        <p>Provenance: {provenance(record.attribution)}</p>
        <p>
          Shared with projects:{" "}
          {record.sharedWithProjectIds.length
            ? record.sharedWithProjectIds.join(", ")
            : "None recorded (project only)"}
        </p>
        {record.supersedes ? <p>Supersedes {record.supersedes}</p> : null}
        {record.tombstonedAt ? <p>Retracted at {record.tombstonedAt}</p> : null}
      </div>
    );
  if (record.kind === "memory-observation")
    return (
      <div className="mt-3 flex flex-col gap-2 break-all text-sm">
        <p>
          Source {record.sourceId} · Source revision {record.sourceRevision} · Source generation{" "}
          {record.sourceGeneration}
        </p>
        <p>
          Extraction {record.extractionId} · Observation key {record.observationKey}
        </p>
        <p>Provenance: {provenance(record.provenance)}</p>
        {record.supersedes ? <p>Supersedes {record.supersedes}</p> : null}
        {record.tombstonedAt ? <p>Retracted at {record.tombstonedAt}</p> : null}
      </div>
    );
  if (record.kind === "memory-extraction")
    return (
      <div className="mt-3 flex flex-col gap-2 break-all text-sm">
        <p>
          Source {record.sourceId} · Source revision {record.sourceRevision} · Source generation{" "}
          {record.sourceGeneration}
        </p>
        <p>
          Engine {record.engine} {record.engineVersion} · Extraction model {record.extractionModel}{" "}
          · Embedding model {record.embeddingModel} · Dimensions {record.embeddingDimensions}
        </p>
        <p>
          Expected observations {record.expectedObservationIds.length} · Completed observations{" "}
          {record.completedObservationIds.length}
        </p>
        <p>
          Extraction hash {record.extractionHash ?? "Not recorded"}
          {record.error ? ` · Error ${record.error}` : ""}
        </p>
      </div>
    );
  return (
    <div className="mt-3 flex flex-col gap-2 break-all text-sm">
      <p>
        Target source {record.targetId} · Expected source revision {record.payload.expectedRevision}{" "}
        · Source generation {record.generation}
      </p>
      <p>
        Effect {record.effectId} · Claim generation {record.claimGeneration} · Available{" "}
        {record.availableAt}
      </p>
      <p>Related records: {record.payload.recordIds.join(", ") || "None recorded"}</p>
      <p>Outcome: {record.outcome ?? "Not recorded"}</p>
    </div>
  );
}
