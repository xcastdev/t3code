import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { asProjectTeamSupervisionSummary } from "@t3tools/client-runtime/project-work";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { RefreshCwIcon } from "lucide-react";
import { useContext, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { WorkSupervision, type WorkSupervisionProps } from "./WorkSupervision";
import { Button } from "../ui/button";
import { projectWorkEnvironment } from "../../state/projectWork";

export type WorkSupervisionSourceProps = Pick<
  WorkSupervisionProps,
  | "environmentId"
  | "projectId"
  | "title"
  | "connected"
  | "enabled"
  | "supported"
  | "onOpenTask"
  | "onOpenWorker"
  | "onInspectProject"
>;

/** Own one bounded summary query; retain its receive time when showing cached metadata. */
export function WorkSupervisionSource(props: WorkSupervisionSourceProps) {
  return (
    <SupervisionRead key={JSON.stringify([props.environmentId, props.projectId])} {...props} />
  );
}

function SupervisionRead(props: WorkSupervisionSourceProps) {
  const registry = useContext(RegistryContext);
  const atom = projectWorkEnvironment.supervision({
    environmentId: props.environmentId,
    projectId: props.projectId,
    enabled: props.enabled,
    capability: props.supported,
    connectionPhase: props.connected ? "connected" : "disconnected",
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const [inspectedAt, setInspectedAt] = useState(Date.now);
  useLayoutEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active && registry.get(atom) === result) setInspectedAt(Date.now());
    });
    return () => {
      active = false;
    };
  }, [registry, atom, result]);
  const success =
    result._tag === "Success"
      ? result
      : result._tag === "Failure"
        ? Option.getOrNull(result.previousSuccess)
        : null;
  const decoded = success ? asProjectTeamSupervisionSummary(success.value, props.projectId) : null;
  const token = decoded ? JSON.stringify(decoded) : null;
  const [saved, save] = useState<{
    readonly token: string;
    readonly snapshot: NonNullable<WorkSupervisionProps["snapshot"]>;
  } | null>(null);
  if (
    success &&
    decoded &&
    token !== null &&
    (!saved || saved.token !== token || !Object.is(saved.snapshot.receivedAt, success.timestamp))
  ) {
    save({
      token,
      snapshot: {
        environmentId: props.environmentId,
        data: decoded,
        receivedAt: success.timestamp,
      },
    });
  }
  const snapshot =
    success && decoded
      ? { environmentId: props.environmentId, data: decoded, receivedAt: success.timestamp }
      : saved?.snapshot;
  const error =
    result._tag === "Failure"
      ? "Could not refresh supervision. Cached metadata may be out of date."
      : success && !decoded
        ? "Unsupported or incoherent supervision metadata."
        : undefined;
  const current =
    props.connected &&
    props.enabled &&
    props.supported &&
    result._tag === "Success" &&
    !result.waiting &&
    decoded?.availability === "available";
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const permits = (target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) =>
    mounted.current &&
    current &&
    registry.get(atom) === result &&
    target.environmentId === props.environmentId &&
    target.projectId === props.projectId;
  const refreshCurrent = useEffectEvent(() => {
    if (mounted.current && props.connected && props.enabled && props.supported) refresh();
  });
  return (
    <>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!props.connected || !props.enabled || !props.supported}
          onClick={() => refreshCurrent()}
        >
          <RefreshCwIcon aria-hidden />
          Refresh summary
        </Button>
      </div>
      <WorkSupervision
        {...props}
        current={current}
        {...(snapshot ? { snapshot } : {})}
        {...(error === undefined ? {} : { error })}
        now={inspectedAt}
        onOpenTask={(target) => {
          if (permits(target)) props.onOpenTask(target);
        }}
        onOpenWorker={(target) => {
          if (permits(target)) props.onOpenWorker(target);
        }}
        onInspectProject={(target) => {
          if (
            mounted.current &&
            target.environmentId === props.environmentId &&
            target.projectId === props.projectId
          )
            props.onInspectProject(target);
        }}
      />
    </>
  );
}
