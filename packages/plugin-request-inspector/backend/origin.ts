// Imports nothing, so the panel bundle can share it with the backend.
export interface RequestTarget {
  readonly scheme: string;
  readonly host: string;
  readonly port: number;
  readonly authority?: string | undefined;
}

export function requestOrigin(target: RequestTarget): string {
  if (target.authority) return target.authority;
  const host =
    target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  const defaultPort =
    (target.scheme === "http" && target.port === 80) ||
    (target.scheme === "https" && target.port === 443);
  return defaultPort ? host : `${host}:${target.port}`;
}
