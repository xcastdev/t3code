import type {
  ProjectMcpCredentialDraft,
  ProjectMcpTransport,
  ProjectMcpTransportDraft,
} from "@t3tools/contracts";

const credentialIdentityChanged = (
  previous: { readonly id: string },
  draft: ProjectMcpCredentialDraft,
): boolean => draft.value !== undefined || draft.id === undefined || draft.id !== previous.id;

const credentialsIdentityChanged = (
  previous: ReadonlyArray<{
    readonly name: string;
    readonly credential: { readonly id: string };
  }>,
  draft: ReadonlyArray<{
    readonly name: string;
    readonly credential: ProjectMcpCredentialDraft;
  }>,
): boolean =>
  previous.length !== draft.length ||
  previous.some(
    (entry, index) =>
      entry.name !== draft[index]?.name ||
      draft[index] === undefined ||
      credentialIdentityChanged(entry.credential, draft[index]!.credential),
  );

const oauthRegistrationIdentityChanged = (
  previous: Extract<
    NonNullable<
      Extract<
        ProjectMcpTransport,
        { readonly type: "streamable-http" | "legacy-sse" }
      >["authorization"]
    >,
    { readonly type: "oauth" }
  >,
  draft: Extract<
    NonNullable<
      Extract<
        ProjectMcpTransportDraft,
        { readonly type: "streamable-http" | "legacy-sse" }
      >["authorization"]
    >,
    { readonly type: "oauth" }
  >,
): boolean => {
  if (previous.registration.type !== draft.registration.type) return true;
  if (draft.registration.type === "automatic") return false;
  if (previous.registration.type !== "pre-registered") return true;
  if (previous.registration.clientId !== draft.registration.clientId) return true;
  const previousSecret = previous.registration.clientSecret;
  const draftSecret = draft.registration.clientSecret;
  return previousSecret === undefined
    ? draftSecret !== undefined
    : draftSecret === undefined || credentialIdentityChanged(previousSecret, draftSecret);
};

/**
 * Returns whether an update changes the owner of a complete MCP transport.
 *
 * Comparisons are intentionally exact and order-sensitive. Credential display
 * names are metadata, but supplied values, ids, header/environment names, and
 * their order are part of the transport identity because the secret store
 * cannot safely compare secret contents.
 */
export const hasCatalogTransportIdentityChange = (
  previous: ProjectMcpTransport,
  draft: ProjectMcpTransportDraft,
): boolean => {
  if (previous.type !== draft.type) return true;

  if (previous.type === "stdio" && draft.type === "stdio") {
    return (
      previous.command !== draft.command ||
      previous.cwd !== draft.cwd ||
      previous.args.length !== draft.args.length ||
      previous.args.some((argument, index) => argument !== draft.args[index]) ||
      credentialsIdentityChanged(previous.env, draft.env)
    );
  }

  if (previous.type === "streamable-http" || previous.type === "legacy-sse") {
    if (draft.type !== previous.type) return true;
    if (previous.url !== draft.url || credentialsIdentityChanged(previous.headers, draft.headers)) {
      return true;
    }
    if (previous.authorization.type !== draft.authorization.type) return true;
    if (previous.authorization.type === "none" || draft.authorization.type === "none") {
      return false;
    }
    return oauthRegistrationIdentityChanged(previous.authorization, draft.authorization);
  }

  return true;
};
