export {
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
} from "./context";

export {
  createServerPairingCredential,
  peekPairingTokenFromUrl,
  PrimaryEnvironmentPairingCredentialRejectedError,
  PrimaryEnvironmentRequestError,
  resolveInitialServerAuthGateState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
  __resetServerAuthBootstrapForTests,
} from "./auth";

export { usePrimarySessionState } from "./sessionState";

export {
  DesktopAttachmentUnavailableError,
  DesktopEnvironmentBootstrapIncompleteError,
  PrimaryEnvironmentProtocolUnsupportedError,
  PrimaryEnvironmentUrlInvalidError,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
  isLoopbackHostname,
  type PrimaryEnvironmentTarget,
} from "./target";
