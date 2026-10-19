import {
  CommandId,
  ProjectWorkTaskId,
  ProjectWorkWriteIntent,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useLayoutEffect, useRef, useState } from "react";
import { AppTextInput as TextInput } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { mobileWorkEnvironment } from "./workEnvironment";
import { createMobileWorkRequest, publicWorkRejection } from "./workActions";
import { Notice, WorkButton, WorkCard } from "./WorkScreens";

type Request = Extract<ProjectWorkWriteIntent, { type: "project-work.task.create" }>;

/** Create a draft only; specification and execution still require their own approvals. */
export function WorkRequest(props: {
  readonly target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  readonly readRevision: () => number | null;
  readonly available: boolean;
  readonly onRefresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState<Request | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "uncertain" | "accepted" | "denied">(
    "idle",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [owner] = useState(() => props.target);
  const live = useRef(props);
  const mounted = useRef(false);
  const busy = useRef(false);
  useLayoutEffect(() => {
    live.current = props;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const write = useAtomCommand(mobileWorkEnvironment.write, {
    reportFailure: false,
    reportDefect: false,
  });
  async function submit() {
    if (!mounted.current || busy.current || status === "accepted" || status === "denied") return;
    if (
      live.current.target.environmentId !== owner.environmentId ||
      live.current.target.projectId !== owner.projectId
    )
      return;
    const revision = live.current.readRevision();
    if (revision === null || !live.current.available || (!pending && !title.trim())) return;
    const input =
      pending ??
      createMobileWorkRequest({
        commandId: CommandId.make(uuidv4()),
        taskId: ProjectWorkTaskId.make(uuidv4()),
        projectId: props.target.projectId,
        expectedRevision: revision,
        title: title.trim(),
        createdAt: new Date().toISOString(),
      });
    if (
      input.type !== "project-work.task.create" ||
      input.projectId !== live.current.target.projectId ||
      live.current.target.environmentId !== props.target.environmentId
    )
      return;
    busy.current = true;
    setPending(input);
    setStatus("sending");
    try {
      const result = await write({ environmentId: props.target.environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (mounted.current) {
        setStatus("accepted");
        setNotice(
          "Draft task recorded. Refresh to review its specification before approving work.",
        );
        live.current.onRefresh();
      }
    } catch (error) {
      if (mounted.current) {
        const rejection = publicWorkRejection(error);
        setStatus(rejection ? "denied" : "uncertain");
        setNotice(
          rejection?.notice ??
            (rejection
              ? "Work changed. Refresh before submitting again."
              : "The response was lost. Retry the exact request or refresh to inspect its result."),
        );
      }
    } finally {
      busy.current = false;
    }
  }
  return (
    <WorkCard title="Request work">
      <Notice>
        Create a draft task for this project. This does not approve or start execution.
      </Notice>
      <TextInput
        accessibilityLabel="Requested task title"
        value={title}
        onChangeText={setTitle}
        maxLength={1000}
        editable={status === "idle"}
      />
      {notice ? <Notice>{notice}</Notice> : null}
      <WorkButton
        disabled={
          !props.available ||
          !title.trim() ||
          status === "sending" ||
          status === "accepted" ||
          status === "denied"
        }
        onPress={() => void submit()}
      >
        {status === "uncertain" ? "Retry exact work request" : "Create draft task"}
      </WorkButton>
      {status === "accepted" || status === "denied" ? (
        <WorkButton
          onPress={() => {
            setPending(null);
            setStatus("idle");
            setTitle("");
            setNotice(null);
          }}
        >
          New work request
        </WorkButton>
      ) : null}
    </WorkCard>
  );
}
