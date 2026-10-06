import { readProjectWorkPublicationHistory } from "@t3tools/shared/projectWorkPublicationHistory";
import { useNavigation } from "@react-navigation/native";
import type { ProjectWorkFoundationSnapshot } from "@t3tools/client-runtime/project-work";
import {
  ProjectTeamRecord,
  type ProjectTeamEffect,
  type EnvironmentId,
  type ProjectId,
  type ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useMemo, useState } from "react";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";

const knownRecord = Schema.is(ProjectTeamRecord);
const PAGE_SIZE = 20;
const RELATED_LIMIT = 8;
type Target = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;

export interface WorkEvidenceProps {
  readonly target: Target;
  /** The immutable owner of the parent's loaded snapshot, including cached snapshots. */
  readonly foundationOwner: Target;
  readonly foundation: ProjectWorkFoundationSnapshot;
  readonly current: boolean;
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly taskId?: ProjectWorkTaskId;
}

/** Inspect the parent's bounded records; this view makes no reads or authoritative commands. */
export function WorkEvidence(props: WorkEvidenceProps) {
  if (!props.supported)
    return (
      <WorkCard title="Evidence and delivery records">
        <Notice>This environment does not support evidence inspection.</Notice>
      </WorkCard>
    );
  if (
    props.target.environmentId !== props.foundationOwner.environmentId ||
    props.target.projectId !== props.foundationOwner.projectId
  )
    return (
      <WorkCard title="Evidence and delivery records">
        <Notice>
          Waiting for this environment's snapshot. Cached records belong to another owner.
        </Notice>
      </WorkCard>
    );
  return (
    <EvidenceSession
      key={JSON.stringify([
        props.target.environmentId,
        props.target.projectId,
        props.taskId ?? null,
      ])}
      {...props}
    />
  );
}

function EvidenceSession(props: WorkEvidenceProps) {
  const navigation = useNavigation();
  const [taskId, selectTask] = useState(props.taskId);
  const [page, setPage] = useState(0);
  const [inspectedAt] = useState(() => Date.now());
  const view = useMemo(() => {
    const owned = props.foundation.records.filter(
      (record) => record.projectId === props.target.projectId,
    );
    const records = owned.filter(knownRecord);
    const unsupported = owned.filter((record) => !knownRecord(record));
    const gates = records.filter((record) => record.kind === "gate");
    const plans = records.filter((record) => record.kind === "plan-revision");
    const runs = records.filter((record) => record.kind === "run-binding");
    const roles = records.filter((record) => record.kind === "role-revision");
    const items = owned.filter((record) => {
      if (taskId !== undefined && (!("taskId" in record) || record.taskId !== taskId)) return false;
      return (
        !knownRecord(record) ||
        record.kind === "evidence-applicability" ||
        (record.kind === "effect" && record.effectKind === "publication")
      );
    });
    let latestUpdate: { value: string; instant: number } | null = null;
    let invalidTimestamps = false;
    for (const record of owned) {
      const instant = Date.parse(record.updatedAt);
      if (!Number.isFinite(instant)) invalidTimestamps = true;
      else if (latestUpdate === null || instant > latestUpdate.instant)
        latestUpdate = { value: record.updatedAt, instant };
    }
    return {
      items,
      gates,
      plans,
      runs,
      roles,
      unsupported,
      latestUpdate,
      invalidTimestamps,
      foreign: owned.length !== props.foundation.records.length,
    };
  }, [props.foundation, props.target.projectId, taskId]);
  const pages = Math.max(1, Math.ceil(view.items.length / PAGE_SIZE));
  const visible = Math.min(page, pages - 1);
  const complete =
    props.connected &&
    props.enabled &&
    props.current &&
    props.foundation.complete &&
    props.foundation.nextCursor === null &&
    props.foundation.error === null &&
    props.foundation.revision !== null &&
    !view.foreign &&
    !view.invalidTimestamps &&
    view.unsupported.length === 0;
  const age =
    view.latestUpdate !== null && !view.invalidTimestamps
      ? Math.max(0, Math.floor((inspectedAt - view.latestUpdate.instant) / 60000))
      : null;
  const changeTask = (id: ProjectWorkTaskId | undefined) => {
    selectTask(id);
    setPage(0);
  };
  return (
    <>
      <WorkCard title="Evidence and delivery records">
        <Notice>
          {complete ? "Complete recorded snapshot" : "Cached or incomplete evidence"} ·{" "}
          {props.foundation.revision === null
            ? "Revision unknown"
            : `Project revision ${props.foundation.revision}`}
        </Notice>
        {view.latestUpdate ? <Notice>Last recorded update {view.latestUpdate.value}</Notice> : null}
        {age !== null ? (
          <Notice>Recorded age {age} minutes at inspection</Notice>
        ) : (
          <Notice>Recorded age unavailable.</Notice>
        )}
        {view.invalidTimestamps ? (
          <Notice>
            Recorded freshness unavailable: one or more record timestamps are invalid.
          </Notice>
        ) : null}
        <Notice>
          Recorded applicability does not establish current approval or live delivery qualification.
          Publication receipts do not confirm a merge.
        </Notice>
        {!props.connected ? <Notice>Disconnected. Recorded metadata may be stale.</Notice> : null}
        {!props.enabled ? (
          <Notice>Project Work is disabled. Recorded metadata may be cached.</Notice>
        ) : null}
        {!complete ? (
          <Notice>
            Reconnect and load a complete owner-scoped snapshot to inspect the latest recorded
            metadata.
          </Notice>
        ) : null}
        {view.foreign ? <Notice>Records from another project were excluded.</Notice> : null}
        {view.unsupported.length > 0 ? (
          <Notice>
            Unsupported workflow records are present. Applicability is unknown for those records.
          </Notice>
        ) : null}
        {taskId ? (
          <>
            <Notice>Evidence for task {taskId}</Notice>
            <WorkButton onPress={() => changeTask(undefined)}>Show all project evidence</WorkButton>
          </>
        ) : null}
        {view.items.length === 0 ? (
          <Notice>No evidence or publication records in this snapshot.</Notice>
        ) : null}
      </WorkCard>
      {view.items.slice(visible * PAGE_SIZE, (visible + 1) * PAGE_SIZE).map((item) => {
        if (!knownRecord(item))
          return (
            <WorkCard key={item.recordId} title="Unsupported workflow record">
              <Notice>
                {item.kind} · {item.status} · {item.recordId}
              </Notice>
              <Notice>Applicability is unknown. Update this client to inspect this record.</Notice>
            </WorkCard>
          );
        if (
          item.kind !== "evidence-applicability" &&
          (item.kind !== "effect" || item.effectKind !== "publication")
        )
          return null;
        const linkedGates = view.gates.filter(
          (gate) =>
            item.taskId !== undefined &&
            gate.taskId === item.taskId &&
            (item.kind === "evidence-applicability"
              ? gate.evidenceIds.includes(item.evidenceId) ||
                gate.evidenceIds.includes(item.recordId)
              : gate.recordId === item.targetId || item.payload.recordIds.includes(gate.recordId)),
        );
        const linkedPlans = view.plans.filter(
          (plan) =>
            plan.taskId === item.taskId &&
            (item.kind === "evidence-applicability"
              ? plan.specRevision === item.specRevision && plan.planRevision === item.planRevision
              : item.payload.recordIds.includes(plan.recordId) ||
                linkedGates.some(
                  (gate) =>
                    gate.specRevision === plan.specRevision &&
                    gate.planRevision === plan.planRevision,
                )),
        );
        const run =
          item.kind === "effect" && item.runId
            ? view.runs.find(
                (run) =>
                  run.recordId === item.runId &&
                  run.taskId === item.taskId &&
                  run.environmentId === props.target.environmentId,
              )
            : undefined;
        const role = run
          ? view.roles.find((role) => role.recordId === run.roleRevisionId)
          : undefined;
        return (
          <WorkCard
            key={item.recordId}
            title={
              item.kind === "evidence-applicability"
                ? `Evidence ${item.evidenceId}`
                : `Publication effect ${item.effectId}`
            }
          >
            <Notice>
              Record {item.recordId} · Source record revision {item.revision} · Generation{" "}
              {item.generation}
            </Notice>
            {item.kind === "evidence-applicability" ? (
              <>
                <Notice>Recorded applicability: {item.status}</Notice>
                <Metadata label="Command" value={item.command || "Command not recorded"} />
                <Metadata label="Command result" value={`Exit code ${item.exitCode}`} />
                <Metadata label="Raw artifact ID" value={item.artifactId} />
                <Metadata label="Repository" value={item.repository} />
                <Metadata label="Tested worktree" value={item.worktree} />
                <Metadata label="Tested tree" value={item.testedTree} />
                <Metadata
                  label="Tested commit"
                  value={item.testedCommit ?? "Tested commit not recorded"}
                />
                <Metadata label="Recorded base" value={item.baseSha} />
                <Metadata label="Recorded head" value={item.headSha} />
                <Notice>
                  Spec revision {item.specRevision} · Plan revision {item.planRevision}
                </Notice>
                <Metadata label="Environment summary" value={item.environmentSummary} />
                <Notice>Integration evidence: {item.integration ? "yes" : "no"}</Notice>
                {item.scopeHash ? (
                  <Metadata label="Recorded scope hash" value={item.scopeHash} />
                ) : null}
                <Notice>
                  A tested tree does not qualify a later commit. Artifact retention and reviewed
                  source qualification are not provided by this snapshot.
                </Notice>
              </>
            ) : (
              <>
                <Notice>Recorded publication status: {item.status}</Notice>
                <PublicationHistory key={`${item.recordId}:${item.revision}`} effect={item} />
                <Metadata label="Publication target" value={`Target ${item.targetId}`} />
                <Notice>
                  Expected project revision {item.payload.expectedRevision} · Claim generation{" "}
                  {item.claimGeneration}
                </Notice>
                <Metadata
                  label="Referenced record IDs"
                  value={item.payload.recordIds.join(" · ") || "None recorded"}
                />
                <Metadata label="Available at" value={item.availableAt} />
                {item.sourceId ? (
                  <Metadata
                    label="Recorded source"
                    value={`${item.sourceId} · generation ${item.sourceGeneration ?? "unknown"}`}
                  />
                ) : null}
                {item.runId ? <Metadata label="Recorded run" value={item.runId} /> : null}
              </>
            )}
            {run ? (
              <>
                <Metadata label="Recorded model" value={run.model} />
                <Metadata
                  label="Recorded source profile"
                  value={
                    role
                      ? `${role.recordId} · role revision ${role.roleRevision} · record revision ${role.revision} · ${role.role}`
                      : `${run.roleRevisionId} · profile metadata unavailable`
                  }
                />
                <Notice>
                  Recorded run revision {run.revision}; linked metadata does not qualify delivery.
                </Notice>
              </>
            ) : (
              <Notice>
                Source profile and model not recorded in linked owner-scoped metadata.
              </Notice>
            )}
            <Text className="font-t3-medium text-foreground">Linked recorded plans</Text>
            {linkedPlans.slice(0, RELATED_LIMIT).map((plan) => (
              <Notice key={plan.recordId}>
                {plan.recordId} · {plan.status} · Spec revision {plan.specRevision} · Plan revision{" "}
                {plan.planRevision} · Content hash {plan.contentHash}
              </Notice>
            ))}
            {linkedPlans.length === 0 ? (
              <Notice>No matching frozen plan recorded in this snapshot.</Notice>
            ) : null}
            {linkedPlans.length > RELATED_LIMIT ? (
              <Notice>More linked plans are available in the task.</Notice>
            ) : null}
            <Text className="font-t3-medium text-foreground">Linked recorded gates</Text>
            {linkedGates.slice(0, RELATED_LIMIT).map((gate) => (
              <RecordedGate key={gate.recordId} gate={gate} />
            ))}
            {linkedGates.length === 0 ? (
              <Notice>No matching task gate recorded in this snapshot.</Notice>
            ) : null}
            {linkedGates.length > RELATED_LIMIT ? (
              <Notice>More linked gates are available in the task.</Notice>
            ) : null}
            <Notice>Last recorded update {item.updatedAt}</Notice>
            {item.taskId ? (
              <>
                <WorkButton
                  onPress={() =>
                    navigation.navigate("WorkTask", { ...props.target, taskId: item.taskId! })
                  }
                >
                  Open task {item.taskId}
                </WorkButton>
                {taskId === undefined ? (
                  <WorkButton onPress={() => changeTask(item.taskId)}>
                    Inspect evidence for task {item.taskId}
                  </WorkButton>
                ) : null}
              </>
            ) : (
              <Notice>Task identity not recorded.</Notice>
            )}
          </WorkCard>
        );
      })}
      <View className="gap-2">
        <Notice>
          Page {visible + 1} of {pages}
        </Notice>
        {pages > 1 ? (
          <View className="flex-row flex-wrap gap-2">
            <WorkButton disabled={visible === 0} onPress={() => setPage(visible - 1)}>
              Previous evidence page
            </WorkButton>
            <WorkButton disabled={visible + 1 === pages} onPress={() => setPage(visible + 1)}>
              Next evidence page
            </WorkButton>
          </View>
        ) : null}
      </View>
    </>
  );
}

function Metadata({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1">
      <Notice>{label}</Notice>
      <Text selectable className="text-sm text-foreground">
        {value}
      </Text>
    </View>
  );
}

function RecordedGate({ gate }: { readonly gate: Gate }) {
  return (
    <View className="gap-1 border-t border-border pt-2">
      <Notice>
        Gate {gate.recordId} · {gate.gate} · Recorded gate status: {gate.status}
      </Notice>
      <Notice>
        Gate revision {gate.revision} · Spec revision {gate.specRevision} · Plan revision{" "}
        {gate.planRevision}
      </Notice>
      <Metadata label="Content hash" value={gate.contentHash} />
      <Metadata label="Recorded gate head" value={gate.headSha ?? "not recorded"} />
      {gate.repository ? <Metadata label="Repository" value={gate.repository} /> : null}
      {gate.pullRequestNumber !== undefined ? (
        <Notice>PR number {gate.pullRequestNumber}</Notice>
      ) : null}
      {gate.targetBranch ? <Metadata label="Target branch" value={gate.targetBranch} /> : null}
      {gate.mergeMethod ? <Notice>Merge method {gate.mergeMethod}</Notice> : null}
    </View>
  );
}

function PublicationHistory({ effect }: { readonly effect: typeof ProjectTeamEffect.Type }) {
  const history = useMemo(() => readProjectWorkPublicationHistory(effect), [effect]);
  const [failed, setFailed] = useState(false);
  if (!history)
    return (
      <>
        <Notice>PR publication is unconfirmed in this record.</Notice>
        <Metadata label="Recorded outcome" value={effect.outcome ?? "Outcome not recorded"} />
      </>
    );
  const pr = history.pullRequest;
  return (
    <View className="gap-2">
      <Text className="font-t3-medium text-foreground">
        {history.repository.nameWithOwner} #{pr.number}
      </Text>
      <Notice>Recorded PR state: {pr.state}</Notice>
      <Metadata label="Recorded at" value={history.observedAt} />
      <Metadata label="Recorded base" value={`${pr.baseRef} · ${pr.baseSha}`} />
      <Metadata label="Recorded head" value={`${pr.headRef} · ${pr.headSha}`} />
      <WorkButton
        onPress={() => {
          void tryOpenExternalUrl(pr.url, "pull-request").then((opened) => setFailed(!opened));
        }}
      >
        Open PR #{pr.number}
      </WorkButton>
      {failed ? <Notice>Could not open the pull request. Try again.</Notice> : null}
    </View>
  );
}
