import type { DesktopRelayCommand, DesktopRelayEvent } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { createDesktopRelayWebSocketConstructor } from "./desktopRelayTransport";

it("drains accepted text and Blob sends before a graceful socket close", async () => {
  const commands: DesktopRelayCommand[] = [];
  let receive: ((event: DesktopRelayEvent) => void) | undefined;
  let closed!: () => void;
  const closeSent = new Promise<void>((resolve) => {
    closed = resolve;
  });
  vi.stubGlobal("window", {
    location: { href: "t3://app/" },
    desktopBridge: {
      relayTransport: {
        origins: ["https://relay.example"],
        open: (_input: unknown, listener: (event: DesktopRelayEvent) => void) => {
          receive = listener;
          queueMicrotask(() => receive?.({ type: "open", protocol: "", extensions: "" }));
          return (command: DesktopRelayCommand) => {
            commands.push(command);
            if (command.type === "close") closed();
          };
        },
      },
    },
  });
  try {
    const Socket = createDesktopRelayWebSocketConstructor();
    const socket = new Socket("wss://relay.example/ws?wsTicket=fixture");
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    socket.send("first");
    socket.send(new Blob([new Uint8Array([0, 255])]));
    socket.close(1000, "done");
    socket.send("after close");
    await closeSent;
    expect(commands.filter((command) => command.type !== "pull")).toEqual([
      { type: "send", data: "first" },
      { type: "send", data: new Uint8Array([0, 255]) },
      { type: "close", code: 1000, reason: "done" },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
