export const RELAY_BROWSER_TICKETS_PATH = "/.well-known/t3/relay-browser/tickets";
export const RELAY_HOSTED_SESSION_PATH = "/.well-known/t3/relay-browser/hosted-session";
export const RELAY_HOSTED_SESSION_REQUIRED = "session-required";
export const RELAY_HOSTED_SESSION_HEADER = "x-t3-relay-session";
export const RELAY_HOSTED_WS_PROTOCOL = "t3-relay.v1";
export const RELAY_HOSTED_WS_PROTOCOL_PREFIX = "t3-relay.";
export const RELAY_BROWSER_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface RelayHostedTicketRequest {
  readonly clientOrigin: string;
}

export interface RelayHostedTicketResponse {
  readonly ticket: string;
  readonly expiresAt: number;
}

export interface RelayHostedSessionRequest {
  readonly ticket: string;
}

export interface RelayHostedSessionResponse {
  readonly session: string;
  readonly expiresAt: number;
}
