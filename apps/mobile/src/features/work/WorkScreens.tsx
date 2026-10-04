import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkTaskContext,
  ProjectIssueIntakeRead,
  ProjectIssueRepositoryCursorRead,
  type ProjectTeamRecordRead,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useProject, useEnvironmentServerConfig } from "../../state/entities";
import {
  useSavedRemoteConnections,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { mobileWorkEnvironment } from "./workEnvironment";
import { decodeWorkRoute } from "./workNavigation";
import { mobileTaskPage } from "./workData";
import { useWorkFoundation } from "./useWorkFoundation";
import { createWorkActionSession, reviewMobileWork, type MobileWorkCurrent } from "./workActions";
import { WorkQuestions, WorkTeam } from "./WorkTeam";
import { WorkEvidence } from "./WorkEvidence";

const decodeContext = Schema.decodeUnknownOption(ProjectWorkTaskContext);
const isIssue = Schema.is(ProjectIssueIntakeRead);
const isCursor = Schema.is(ProjectIssueRepositoryCursorRead);
const decodeTaskId = Schema.decodeUnknownOption(ProjectWorkTaskId);
export function WorkButton(props: {
  readonly children: ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-11 justify-center rounded-xl border border-border bg-card px-4 py-2 ${props.disabled ? "opacity-50" : ""}`}
    >
      <Text className="text-sm font-t3-medium text-accent">{props.children}</Text>
    </Pressable>
  );
}
function WorkSurface(props: { readonly title: string; readonly children: ReactNode }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{ title: props.title, headerShown: Platform.OS !== "android" }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={props.title} onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: insets.bottom + 24 }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}
export function Notice(props: { readonly children: ReactNode }) {
  return (
    <Text accessibilityRole="text" className="text-sm text-foreground-muted">
      {props.children}
    </Text>
  );
}
export function WorkCard(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Text className="text-base font-t3-semibold text-foreground">{props.title}</Text>
      {props.children}
    </View>
  );
}

/** A persistent entry in compact, split and Settings navigation, including older servers. */
export function WorkEntryRow() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <View
      className="border-t border-border bg-screen px-4 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open project Work"
        className="min-h-11 justify-center"
        onPress={() => navigation.navigate("WorkProjects")}
      >
        <Text className="font-t3-semibold text-accent">Project Work</Text>
      </Pressable>
    </View>
  );
}
export function WorkProjectsScreen() {
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  return (
    <WorkSurface title="Project Work">
      <Notice>Review issues and tasks in a specific environment and project.</Notice>
      {projects.length === 0 ? (
        <Notice>No projects are available. Connect an environment and add a project first.</Notice>
      ) : null}
      {projects.map((project) => (
        <Pressable
          key={JSON.stringify([project.environmentId, project.id])}
          accessibilityRole="button"
          onPress={() =>
            navigation.navigate("ProjectWork", {
              environmentId: String(project.environmentId),
              projectId: String(project.id),
            })
          }
          className="gap-1 rounded-2xl border border-border bg-card p-4"
        >
          <Text className="font-t3-semibold text-foreground">{project.title}</Text>
          <Text className="text-xs text-foreground-muted">
            {savedConnectionsById[project.environmentId]?.environmentLabel ?? project.environmentId}{" "}
            · {project.environmentId}
          </Text>
          <Text className="text-xs text-foreground-muted">{project.id}</Text>
        </Pressable>
      ))}
    </WorkSurface>
  );
}

type ProjectParams = { readonly environmentId: string; readonly projectId: string };
export function ProjectWorkScreen({ route }: StaticScreenProps<ProjectParams>) {
  const target = decodeWorkRoute(route.params);
  return target ? (
    <ProjectWorkSession key={JSON.stringify(target)} target={target} />
  ) : (
    <WorkSurface title="Project Work">
      <Notice>This link is missing an environment or project.</Notice>
    </WorkSurface>
  );
}
function ProjectIdentity({
  target,
}: {
  readonly target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
}) {
  const project = useProject(target);
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <View className="gap-1">
      <Text className="text-lg font-t3-bold text-foreground">
        {project?.title ?? "Project unavailable"}
      </Text>
      <Notice>
        {savedConnectionsById[target.environmentId]?.environmentLabel ?? target.environmentId} ·{" "}
        {target.environmentId}
      </Notice>
      <Notice>{target.projectId}</Notice>
    </View>
  );
}
function ProjectWorkSession({
  target,
}: {
  readonly target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
}) {
  const project = useProject(target);
  const config = useEnvironmentServerConfig(target.environmentId);
  const runtime = useRemoteEnvironmentRuntime(target.environmentId);
  const supported = project !== null && config?.settings.projectWorkEnabled === true;
  const foundationSupported =
    supported && config?.environment.capabilities.projectTeamFoundationReads === true;
  const foundation = useWorkFoundation(target, foundationSupported);
  const [foundationOwner] = useState(() => target);
  const [showEvidence, setShowEvidence] = useState(false);
  const [offset, setOffset] = useState(0);
  const [issuePage, setIssuePage] = useState(0);
  const query = useEnvironmentQuery(
    supported ? mobileWorkEnvironment.page({ ...target, collection: "tasks", offset }) : null,
  );
  const tasks = mobileTaskPage(query.data, target.projectId, offset);
  const issues = foundation.snapshot.records.filter(isIssue);
  const sync = foundation.snapshot.records.filter(isCursor);
  const navigation = useNavigation();
  const openTask = (taskId: ProjectWorkTaskId) =>
    navigation.navigate("WorkTask", {
      environmentId: String(target.environmentId),
      projectId: String(target.projectId),
      taskId: String(taskId),
    });
  const pageCount = Math.max(1, Math.ceil(issues.length / 25));
  const currentIssuePage = Math.min(issuePage, pageCount - 1);
  return (
    <WorkSurface title="Project Work">
      <ProjectIdentity target={target} />
      {project === null ? (
        <Notice>This project is unavailable in the selected environment.</Notice>
      ) : !supported ? (
        <Notice>
          Project Work is disabled or unavailable on this server. Enable it in the environment's
          settings.
        </Notice>
      ) : null}
      {runtime?.connectionState !== "connected" ? (
        <Notice>Disconnected. Cached work may be out of date. Reconnect to refresh.</Notice>
      ) : null}
      <View className="flex-row gap-3">
        <WorkButton
          disabled={!supported || runtime?.connectionState !== "connected"}
          onPress={() => {
            query.refresh();
            foundation.refresh();
          }}
        >
          Refresh work
        </WorkButton>
      </View>
      {foundation.loadedAt ? (
        <Notice>
          Last complete project read: {foundation.loadedAt}
          {foundation.current ? "" : " · cached"}
        </Notice>
      ) : null}
      {query.error ? <Notice>{query.error}</Notice> : null}
      {foundation.error ? <Notice>{foundation.error}</Notice> : null}
      <WorkButton onPress={() => setShowEvidence((visible) => !visible)}>
        {showEvidence ? "Show project work" : "Show evidence"}
      </WorkButton>
      {showEvidence ? (
        <WorkEvidence
          target={target}
          foundationOwner={foundationOwner}
          foundation={foundation.snapshot}
          current={foundation.current && foundation.error === null}
          connected={runtime?.connectionState === "connected"}
          enabled={supported}
          supported={foundationSupported}
        />
      ) : (
        <>
          <WorkTeam
            target={target}
            foundation={foundation.snapshot}
            supported={foundationSupported}
          />
          <WorkCard title="Issue intake">
            {!foundationSupported ? (
              <Notice>
                This server does not support issue intake reads. Existing tasks remain available
                when Project Work is enabled.
              </Notice>
            ) : null}
            {sync.map((cursor) => (
              <Notice key={cursor.recordId}>
                {cursor.status}
                {cursor.lastSuccessfulPageAt
                  ? ` · Last successful sync ${cursor.lastSuccessfulPageAt}`
                  : " · No successful sync recorded"}
                {cursor.error ? ` · ${cursor.error}` : ""}
              </Notice>
            ))}
            {issues.slice(currentIssuePage * 25, (currentIssuePage + 1) * 25).map((issue) => (
              <View key={issue.recordId} className="gap-2 border-t border-border pt-3">
                <Text className="font-t3-medium text-foreground">
                  {issue.repositoryName} #{issue.identity.number} · {issue.status}
                </Text>
                <Text selectable className="text-foreground">
                  {issue.title}
                </Text>
                <Notice>Observed {issue.observedAt}</Notice>
                <Text selectable className="text-sm text-foreground-muted">
                  {issue.body}
                </Text>
                {issue.taskId ? (
                  <WorkButton onPress={() => openTask(issue.taskId!)}>Open linked task</WorkButton>
                ) : (
                  <Notice>
                    This issue has no linked task. Refine it in the web or desktop Work view.
                  </Notice>
                )}
              </View>
            ))}
            {foundationSupported && issues.length === 0 ? (
              <Notice>
                {foundation.current ? "No issues in this project." : "Loading issue intake…"}
              </Notice>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <WorkButton
                disabled={currentIssuePage === 0}
                onPress={() => setIssuePage(currentIssuePage - 1)}
              >
                Previous issues
              </WorkButton>
              <WorkButton
                disabled={currentIssuePage + 1 >= pageCount}
                onPress={() => setIssuePage(currentIssuePage + 1)}
              >
                Next issues
              </WorkButton>
            </View>
            <Notice>
              Issue page {currentIssuePage + 1} of {pageCount}
            </Notice>
          </WorkCard>
          <WorkCard title="Tasks">
            {query.isPending ? <Notice>Refreshing tasks…</Notice> : null}
            {tasks?.records.map((task) => (
              <Pressable
                key={task.taskId}
                accessibilityRole="button"
                onPress={() => openTask(task.taskId)}
                className="gap-1 border-t border-border py-3"
              >
                <Text className="font-t3-medium text-foreground">{task.title}</Text>
                <Notice>{task.state}</Notice>
              </Pressable>
            ))}
            {tasks?.records.length === 0 ? <Notice>No tasks on this page.</Notice> : null}
            {query.data !== null && tasks === null ? (
              <Notice>This server returned an unsupported task page.</Notice>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <WorkButton
                disabled={offset === 0 || query.isPending}
                onPress={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous tasks
              </WorkButton>
              <WorkButton
                disabled={tasks?.nextOffset === null || tasks === null || query.isPending}
                onPress={() => {
                  if (tasks?.nextOffset !== null && tasks?.nextOffset !== undefined)
                    setOffset(tasks.nextOffset);
                }}
              >
                Next tasks
              </WorkButton>
            </View>
            <Notice>Task page {Math.floor(offset / 50) + 1}</Notice>
          </WorkCard>
        </>
      )}
    </WorkSurface>
  );
}

export function WorkTaskScreen({
  route,
}: StaticScreenProps<ProjectParams & { readonly taskId: string }>) {
  const target = decodeWorkRoute(route.params);
  const taskId = Option.getOrNull(decodeTaskId(route.params.taskId));
  return target && taskId ? (
    <WorkTaskSession key={JSON.stringify([target, taskId])} target={target} taskId={taskId} />
  ) : (
    <WorkSurface title="Task">
      <Notice>This link is missing an environment, project or task.</Notice>
    </WorkSurface>
  );
}
function WorkTaskSession({
  target,
  taskId,
}: {
  readonly target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  readonly taskId: ProjectWorkTaskId;
}) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const project = useProject(target);
  const config = useEnvironmentServerConfig(target.environmentId);
  const runtime = useRemoteEnvironmentRuntime(target.environmentId);
  const enabled = project !== null && config?.settings.projectWorkEnabled === true;
  const foundationSupported =
    enabled && config?.environment.capabilities.projectTeamFoundationReads === true;
  const foundation = useWorkFoundation(target, foundationSupported);
  const contextAtom = enabled ? mobileWorkEnvironment.taskContext({ ...target, taskId }) : null;
  const raw = useEnvironmentQuery(contextAtom);
  const context = Option.getOrNull(decodeContext(raw.data));
  const current: MobileWorkCurrent = {
    ...target,
    taskId,
    context,
    foundation: foundation.snapshot,
    connected: focused && runtime?.connectionState === "connected",
    enabled,
    foundationSupported,
    guidedSupported: config?.environment.capabilities.projectTeamGuidedWrites === true,
    fresh: foundation.current && raw.error === null && !raw.isPending,
  };
  const review = reviewMobileWork(current);
  const [, changed] = useState(0);
  const write = useAtomCommand(mobileWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  const [session] = useState(() =>
    createWorkActionSession(
      { ...target, taskId },
      () => current,
      async (input) => {
        const result = await write({ environmentId: target.environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
      () => CommandId.make(uuidv4()),
      () => changed((value) => value + 1),
    ),
  );
  const readCurrent = () => {
    const presentation = appAtomRegistry.get(
      environmentPresentations.presentationAtom(target.environmentId),
    );
    const ownProject = appAtomRegistry.get(environmentProjects.projectAtom(target));
    const verified = foundation.verify();
    const result = contextAtom === null ? null : appAtomRegistry.get(contextAtom);
    const freshContext =
      result === null
        ? null
        : Option.getOrNull(decodeContext(Option.getOrNull(AsyncResult.value(result))));
    return {
      ...current,
      context: freshContext,
      foundation: verified.snapshot,
      connected:
        navigation.isFocused() &&
        presentation?.entry.enabled === true &&
        presentation.connection.phase === "connected",
      enabled:
        ownProject !== null && presentation?.serverConfig?.settings.projectWorkEnabled === true,
      foundationSupported:
        presentation?.serverConfig?.environment.capabilities.projectTeamFoundationReads === true,
      guidedSupported:
        presentation?.serverConfig?.environment.capabilities.projectTeamGuidedWrites === true,
      fresh: verified.current && result?._tag === "Success" && !result.waiting,
    };
  };
  useLayoutEffect(() => {
    session.setCurrent(readCurrent);
  });
  useLayoutEffect(() => {
    session.activate();
    return () => session.dispose();
  }, [session]);
  const state = session.state;
  const locked = review.reason !== null || !session.canSubmit(context?.revision ?? null);
  const refresh = () => {
    raw.refresh();
    foundation.refresh();
  };
  const ownContext =
    context?.projectId === target.projectId &&
    context.task.projectId === target.projectId &&
    context.task.taskId === taskId
      ? context
      : null;
  return (
    <WorkSurface title="Work task">
      <ProjectIdentity target={target} />
      <Notice>{taskId}</Notice>
      <WorkButton disabled={runtime?.connectionState !== "connected" || !enabled} onPress={refresh}>
        Refresh work
      </WorkButton>
      {raw.error ? <Notice>{raw.error}</Notice> : null}
      {foundation.error ? <Notice>{foundation.error}</Notice> : null}
      {foundation.loadedAt ? (
        <Notice>
          Last complete project read: {foundation.loadedAt}
          {foundation.current ? "" : " · cached"}
        </Notice>
      ) : null}
      {review.reason ? <Notice>{review.reason}</Notice> : null}
      {state.notice ? <Notice>{state.notice}</Notice> : null}
      {state.status === "sending" ? <Notice>Sending…</Notice> : null}
      {state.status === "uncertain" ? (
        <WorkButton disabled={review.reason !== null} onPress={() => void session.retry()}>
          Retry exact command
        </WorkButton>
      ) : null}
      {state.status !== "idle" && state.status !== "sending" && state.status !== "uncertain" ? (
        <WorkButton onPress={() => session.reset()}>Review refreshed work</WorkButton>
      ) : null}
      {ownContext === null ? (
        <Notice>
          {raw.isPending ? "Loading task…" : "This task is unavailable in the selected project."}
        </Notice>
      ) : (
        <>
          <WorkCard title={ownContext.task.title}>
            <Notice>
              {ownContext.task.state} · Task revision {ownContext.task.revision}
            </Notice>
            {ownContext.task.summary ? <Text selectable>{ownContext.task.summary}</Text> : null}
            {ownContext.blockers.map((blocker) => (
              <Notice key={blocker.blockerId}>{blocker.reason}</Notice>
            ))}
          </WorkCard>
          <WorkQuestions
            current={current}
            readCurrent={readCurrent}
            send={async (input) => {
              const result = await write({ environmentId: target.environmentId, input });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            }}
          />
          <WorkCard title={`Specification ${ownContext.task.specRevision}`}>
            <Text selectable>
              {ownContext.task.specification?.objective ?? "No specification proposed."}
            </Text>
            {ownContext.task.specification ? (
              <>
                <Text selectable>{ownContext.task.specification.scopeIn}</Text>
                <Notice>Excluded: {ownContext.task.specification.scopeOut}</Notice>
              </>
            ) : null}
            {ownContext.criteria.map((criterion) => (
              <Notice key={criterion.criterionId}>
                {criterion.description} · {criterion.status}
              </Notice>
            ))}
            {review.specificationGate ? (
              <GateButtons gate={review.specificationGate} locked={locked} session={session} />
            ) : null}
          </WorkCard>
          <WorkCard title={review.plan ? `Plan ${review.plan.planRevision}` : "Plan"}>
            <Text selectable>{review.plan?.content ?? "No current plan proposed."}</Text>
            {review.planGate ? (
              <GateButtons gate={review.planGate} locked={locked} session={session} />
            ) : null}
          </WorkCard>
          <WorkCard title="Approval history">
            {review.gates.map((gate) => (
              <Notice key={gate.recordId}>
                {gate.gate} · specification {gate.specRevision}, plan {gate.planRevision} ·{" "}
                {gate.status}
              </Notice>
            ))}
            {review.gates.length === 0 ? <Notice>No recorded approvals.</Notice> : null}
          </WorkCard>
          <WorkCard title="Investigation">
            <Notice>
              Request bounded research for this task. Implementation still requires separate
              approval.
            </Notice>
            <TextInput
              accessibilityLabel="Investigation objective"
              multiline
              maxLength={32000}
              editable={state.status !== "sending" && state.status !== "uncertain"}
              value={state.objective}
              onChangeText={(text) => session.edit(text, state.outputs)}
              placeholder="What should be investigated?"
            />
            <TextInput
              accessibilityLabel="Investigation outputs, one per line"
              multiline
              maxLength={64000}
              editable={state.status !== "sending" && state.status !== "uncertain"}
              value={state.outputs}
              onChangeText={(text) => session.edit(state.objective, text)}
            />
            <WorkButton
              disabled={locked || !review.canInvestigate}
              onPress={() => void session.submit({ kind: "investigate" })}
            >
              Start investigation
            </WorkButton>
          </WorkCard>
          <WorkCard title="Findings and evidence">
            {ownContext.comments.map((comment) => (
              <Text key={comment.commentId} selectable>
                {comment.body}
              </Text>
            ))}
            {ownContext.evidence.map((evidence) => (
              <Notice key={evidence.evidenceId}>{evidence.summary}</Notice>
            ))}
            {ownContext.comments.length === 0 && ownContext.evidence.length === 0 ? (
              <Notice>No findings recorded.</Notice>
            ) : null}
          </WorkCard>
        </>
      )}
    </WorkSurface>
  );
}
function GateButtons({
  gate,
  locked,
  session,
}: {
  readonly gate: Extract<ProjectTeamRecordRead, { kind: "gate" }>;
  readonly locked: boolean;
  readonly session: ReturnType<typeof createWorkActionSession>;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      <WorkButton
        disabled={locked}
        onPress={() =>
          void session.submit({ kind: "gate", gateId: gate.recordId, response: "approved" })
        }
      >
        Approve {gate.gate}
      </WorkButton>
      <WorkButton
        disabled={locked}
        onPress={() =>
          void session.submit({ kind: "gate", gateId: gate.recordId, response: "rejected" })
        }
      >
        Reject {gate.gate}
      </WorkButton>
    </View>
  );
}
