import type { ProjectId } from "@t3tools/contracts";

export type TerminalOwner =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "project"; readonly projectId: ProjectId };

export interface TerminalTarget {
  readonly owner: TerminalOwner;
  readonly terminalId: string;
}

export type ProjectTerminalRuntimeEvent =
  | {
      readonly type: "created";
      readonly target: TerminalTarget;
      readonly generation: string;
      readonly sequence: number;
      readonly creatingThreadId: string;
      readonly label: string;
      readonly status: "running";
      readonly cols: number;
      readonly rows: number;
      readonly exitCode: null;
      readonly exitSignal: null;
      readonly updatedAt: string;
    }
  | {
      readonly type: "output";
      readonly target: TerminalTarget;
      readonly generation: string;
      readonly sequence: number;
      readonly data: string;
    }
  | {
      readonly type: "resized";
      readonly target: TerminalTarget;
      readonly generation: string;
      readonly sequence: number;
      readonly cols: number;
      readonly rows: number;
    }
  | {
      readonly type: "status";
      readonly target: TerminalTarget;
      readonly generation: string;
      readonly sequence: number;
    }
  | {
      readonly type: "exited";
      readonly target: TerminalTarget;
      readonly generation: string;
      readonly sequence: number;
      readonly status: "exited" | "killed";
      readonly label: string;
      readonly creatingThreadId: string;
      readonly updatedAt: string;
      readonly exitCode: number | null;
      readonly exitSignal: number | null;
    }
  | {
      readonly type: "closed";
      readonly target: TerminalTarget;
      readonly generation: string;
      readonly sequence: number;
    };

export const threadTerminalTarget = (threadId: string, terminalId: string): TerminalTarget => ({
  owner: { kind: "thread", threadId },
  terminalId,
});

export const projectTerminalTarget = (
  projectId: ProjectId,
  terminalId: string,
): TerminalTarget => ({
  owner: { kind: "project", projectId },
  terminalId,
});

export const terminalTargetKey = ({ owner, terminalId }: TerminalTarget): string =>
  owner.kind === "thread"
    ? JSON.stringify(["thread", owner.threadId, terminalId])
    : JSON.stringify(["project", owner.projectId, terminalId]);
