export interface ProjectTerminalTransport {
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
}

/** Gate all surface output, including Ghostty device replies, at the transport edge. */
export function createProjectTerminalTransport(input: {
  readonly mode: () => "view" | "interactive";
  readonly focused: () => boolean;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
}): ProjectTerminalTransport {
  return {
    onData: (data) => {
      if (input.mode() === "interactive") input.write(data);
    },
    onResize: (cols, rows) => {
      if (input.mode() === "interactive" && input.focused()) input.resize(cols, rows);
    },
  };
}
