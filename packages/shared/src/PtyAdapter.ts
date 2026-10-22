import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

export class PtyDrainError extends Schema.TaggedError<PtyDrainError>()("PtyDrainError", {
  reason: Schema.Literals([
    "unsupported",
    "ownership-changed",
    "inspection-failed",
    "signal-failed",
    "deadline",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not prove owned terminal processes drained (${this.reason})`;
  }
}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  /** Captured spawn ownership, including ordinary foreground/background jobs. */
  readonly signalOwned?: (signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void, PtyDrainError>;
  readonly awaitOwnedExit?: Effect.Effect<void, PtyDrainError>;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export class PtyAdapter extends Context.Service<
  PtyAdapter,
  {
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>()("@t3tools/shared/PtyAdapter") {}
