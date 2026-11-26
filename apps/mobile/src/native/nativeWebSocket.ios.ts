import { layerFromModule } from "./nativeWebSocketBridge";

export { Connection, Sockets, type NativeModule } from "./nativeWebSocketBridge";

export const layer = layerFromModule("T3WebSocket");
