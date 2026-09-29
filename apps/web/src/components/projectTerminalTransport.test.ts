import { describe, expect, it, vi } from "vite-plus/test";

import { createProjectTerminalTransport } from "./projectTerminalTransport";

describe("project terminal transport policy", () => {
  it("drops terminal input and device replies and never resizes in view mode", () => {
    const write = vi.fn();
    const resize = vi.fn();
    const transport = createProjectTerminalTransport({
      mode: () => "view",
      focused: () => true,
      write,
      resize,
    });

    transport.onData("hello");
    transport.onData("\u001b[0n");
    transport.onResize(120, 36);

    expect(write).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it("allows input and focused resize only in interactive mode", () => {
    const write = vi.fn();
    const resize = vi.fn();
    let focused = false;
    const transport = createProjectTerminalTransport({
      mode: () => "interactive",
      focused: () => focused,
      write,
      resize,
    });

    transport.onData("hello");
    transport.onResize(120, 36);
    focused = true;
    transport.onResize(121, 36);

    expect(write).toHaveBeenCalledWith("hello");
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(121, 36);
  });
});
