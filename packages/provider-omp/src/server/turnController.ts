import { assertAllowedPrompt, type OmpCommand } from "./commands.ts";
export type NativeRecord = { type: string; [key: string]: unknown };
export class OmpTurnController {
  private active:
    | { id: string; result?: NativeRecord; local?: boolean; compacting?: boolean }
    | undefined;
  private stopping = false;
  private readonly used = new Set<string>();
  private readonly send: (r: NativeRecord) => Promise<unknown>;
  private readonly emit: (r: NativeRecord) => void;
  private readonly request: (r: NativeRecord) => Promise<unknown>;
  constructor(
    send: (r: NativeRecord) => Promise<unknown>,
    emit: (r: NativeRecord) => void,
    request: (r: NativeRecord) => Promise<unknown> = send,
  ) {
    this.send = send;
    this.emit = emit;
    this.request = request;
  }
  get activeId() {
    return this.active?.id;
  }
  async start(
    id: string,
    text: string,
    commands: readonly OmpCommand[],
    images?: readonly unknown[],
  ) {
    if (this.active || this.stopping || this.used.has(id))
      throw new Error("OMP turn already active or prompt identity reused");
    assertAllowedPrompt(text, commands);
    this.used.add(id);
    this.active = { id };
    try {
      await this.send({ type: "prompt", id, message: text, ...(images?.length ? { images } : {}) });
    } catch (error) {
      this.finish("error", "OMP prompt transport failed");
      throw error;
    }
  }
  async steer(text: string, commands: readonly OmpCommand[]) {
    if (!this.active || this.stopping) throw new Error("OMP has no steerable turn");
    assertAllowedPrompt(text, commands);
    await this.request({ type: "steer", message: text });
  }
  async stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    try {
      await this.request({ type: "abort_and_restore_queue" });
      this.finish("aborted");
    } finally {
      this.stopping = false;
    }
  }
  fail(message: string) {
    this.finish("error", message);
  }
  private finish(status: string, error?: string) {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.emit({ type: "terminal", id: active.id, status, ...(error ? { error } : {}) });
  }
  private async settleLocal(active: NonNullable<OmpTurnController["active"]>) {
    try {
      const state = await this.request({ type: "get_state" });
      if (this.active !== active) return;
      if (
        typeof state !== "object" ||
        state === null ||
        !("isSettled" in state) ||
        typeof state.isSettled !== "boolean"
      )
        this.finish("error", "Native local command settlement is unavailable");
      else {
        if ("isCompacting" in state && state.isCompacting === true) active.compacting = true;
        if (state.isSettled && !active.compacting)
          this.finish(
            typeof active.result?.status === "string" ? active.result.status : "completed",
          );
      }
    } catch {
      if (this.active === active) this.finish("error", "Native local command settlement failed");
    }
  }
  async handle(record: NativeRecord) {
    const active = this.active;
    if (record.type === "response" && record.command === "prompt") {
      if (record.id === active?.id && record.success === false)
        this.finish(
          "error",
          typeof record.error === "string" ? record.error : "OMP prompt rejected",
        );
      else if (
        active &&
        record.id === active.id &&
        record.success === true &&
        typeof record.data === "object" &&
        record.data !== null &&
        "agentInvoked" in record.data &&
        record.data.agentInvoked === false
      ) {
        active.local = true;
        active.result = { type: "local_result", status: "completed" };
        await this.settleLocal(active);
      }
      return;
    }
    if (record.type === "prompt_result") {
      if (!active || record.id !== active.id) return;
      active.result = record;
      if (record.status === "error")
        this.finish(
          "error",
          typeof record.error === "object" && record.error !== null && "message" in record.error
            ? String(record.error.message)
            : "OMP prompt failed",
        );
      else if (record.sessionSettled === true)
        this.finish(record.status === "aborted" ? "aborted" : "completed");
      return;
    }
    if (record.type === "manual_compaction_start" && active) {
      active.compacting = true;
      this.emit({ ...record, promptId: active.id });
      return;
    }
    if (record.type === "manual_compaction_end" && active) {
      active.compacting = false;
      this.emit({ ...record, promptId: active.id });
      if (active.local) {
        active.result = {
          type: "local_result",
          status:
            record.aborted === true
              ? "aborted"
              : record.errorMessage && !record.skipped
                ? "error"
                : "completed",
        };
        await this.settleLocal(active);
      }
      return;
    }
    if (record.type === "session_settled") {
      if (active?.result && !active.compacting)
        this.finish(typeof active.result.status === "string" ? active.result.status : "completed");
      return;
    }
    if (
      record.type === "error" ||
      record.type === "persistence_error" ||
      record.type === "session_persistence_error"
    ) {
      this.finish("error", "OMP runtime or persistence failed");
      return;
    }
    if (active) this.emit({ ...record, promptId: active.id });
  }
}
