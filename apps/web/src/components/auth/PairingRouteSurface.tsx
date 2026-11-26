import { Alert, AlertDescription } from "../ui/alert";
import { Link } from "@tanstack/react-router";
import type { AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { useGT } from "gt-react";
import {
  listHostedRelayPairingBindings,
  submitEnrolledHostedRelayPairing,
} from "../../connection/hostedRelayAdmission";
import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest, type HostedPairingRequest } from "../../hostedPairing";
import { DesktopPrimaryBackendRecovery } from "../settings/DesktopPrimaryBackendSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Pairing with this environment"
        description="Validating the pairing link and preparing your session."
      />
    </StandalonePage>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const [autoPairToken] = useState(peekPairingTokenFromUrl);
  const [credential, setCredential] = useState(autoPairToken ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = async (nextCredential: string) => {
    setIsSubmitting(true);
    setErrorMessage("");

    const submitError = await submitServerAuthCredential(nextCredential).then(
      () => null,
      (error) => errorMessageFromUnknown(error),
    );

    setIsSubmitting(false);

    if (submitError) {
      setErrorMessage(submitError);
      return;
    }

    startTransition(() => {
      onAuthenticated();
    });
  };

  const handleSubmit = async (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    await submitCredential(credential);
  };

  const autoSubmit = useEffectEvent((token: string) => {
    void submitCredential(token);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the pairing token from the URL and submits it once when the route carries one
  useEffect(() => {
    if (!autoPairToken || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    autoSubmit(autoPairToken);
  }, [autoPairToken]);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title="Pair with this environment"
        description={describeAuthGate(auth.bootstrapMethods)}
      />

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="pairing-token">
            Pairing token
          </label>
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setCredential(event.currentTarget.value)}
            placeholder="Paste a one-time token or pairing secret"
            spellCheck={false}
            value={credential}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? "Pairing..." : "Continue"}
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload app
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </div>

      <DesktopPrimaryBackendRecovery />
    </StandalonePage>
  );
}

function getPairingRequestOrigin(request: HostedPairingRequest | null) {
  if (!request) return null;
  try {
    const target = resolveRemotePairingTarget({ host: request.host, pairingCode: request.token });
    return new URL(target.httpBaseUrl).origin;
  } catch {
    return null;
  }
}

export function HostedPairingRouteSurface() {
  const [request] = useState(readHostedPairingRequest);
  const bindings = listHostedRelayPairingBindings();
  const requestOrigin = getPairingRequestOrigin(request);
  if (
    bindings.length > 0 &&
    (!request || bindings.some((binding) => binding.httpsOrigin === requestOrigin))
  ) {
    return (
      <HostedRelayPairingForm
        bindings={bindings}
        requestOrigin={requestOrigin}
        linkToken={request?.token ?? ""}
      />
    );
  }
  return <HostedLinkPairing request={request} />;
}

function HostedRelayPairingForm({
  bindings,
  requestOrigin,
  linkToken,
}: {
  bindings: ReturnType<typeof listHostedRelayPairingBindings>;
  requestOrigin: string | null;
  linkToken: string;
}) {
  const gt = useGT();
  const connect = useAtomCommand(connectPairing, { reportFailure: false, reportDefect: false });
  const onlyOrigin = bindings.length === 1 ? (bindings[0]?.httpsOrigin ?? null) : null;
  const [selectedOrigin, setSelectedOrigin] = useState(onlyOrigin);
  const [operatorTicket, setOperatorTicket] = useState("");
  const [pairingCode, setPairingCode] = useState(
    onlyOrigin !== null && onlyOrigin === requestOrigin ? linkToken : "",
  );
  const [linkUsed, setLinkUsed] = useState(false);
  const [status, setStatus] = useState<
    "ready" | "submitting" | "connected" | "admission-error" | "pairing-error"
  >("ready");
  const binding = bindings.find(({ httpsOrigin }) => httpsOrigin === selectedOrigin);
  const submitting = status === "submitting";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips destination credentials from the address bar
  useEffect(stripPairingTokenFromUrl, []);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!binding || !operatorTicket.trim() || submitting || status === "connected") return;
    setStatus("submitting");
    setOperatorTicket("");
    try {
      const result = await submitEnrolledHostedRelayPairing(
        binding,
        operatorTicket.trim(),
        pairingCode.trim(),
        (input) => {
          setPairingCode("");
          setLinkUsed(true);
          return connect(input);
        },
      );
      setStatus(result?._tag === "Failure" ? "pairing-error" : "connected");
    } catch {
      setStatus("admission-error");
    }
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={gt("Connect through a relay")}
        description={gt(
          "Choose an enrolled environment and enter a one-time ticket from its relay operator.",
        )}
      />
      {status === "connected" ? (
        <div className="mt-6 space-y-4">
          <p role="status">{gt("Relay access is ready for this tab.")}</p>
          <Button size="sm" render={<Link to="/" replace />}>
            {gt("Open app")}
          </Button>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="hosted-relay-environment">
              {gt("Enrolled environment")}
            </label>
            <Select
              disabled={submitting}
              value={selectedOrigin}
              onValueChange={(origin) => {
                setSelectedOrigin(origin);
                setOperatorTicket("");
                setPairingCode(!linkUsed && origin === requestOrigin ? linkToken : "");
              }}
            >
              <SelectTrigger id="hosted-relay-environment">
                <SelectValue placeholder={gt("Choose an environment")}>
                  {binding ? `${binding.environmentId} · ${binding.httpsOrigin}` : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {bindings.map(({ httpsOrigin, environmentId }) => (
                  <SelectItem key={httpsOrigin} value={httpsOrigin}>
                    {environmentId} · {httpsOrigin}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="hosted-relay-ticket">
              {gt("Operator relay ticket")}
            </label>
            <Input
              id="hosted-relay-ticket"
              nativeInput
              type="password"
              autoComplete="off"
              disabled={submitting || !binding}
              onChange={(event) => setOperatorTicket(event.currentTarget.value)}
              required
              value={operatorTicket}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="hosted-destination-token">
              {gt("Destination pairing token")}
            </label>
            <Input
              id="hosted-destination-token"
              nativeInput
              type="password"
              autoComplete="off"
              disabled={submitting || !binding}
              onChange={(event) => setPairingCode(event.currentTarget.value)}
              value={pairingCode}
            />
            <p className="text-xs text-muted-foreground">
              {gt("Leave this blank if the environment is already paired.")}
            </p>
          </div>
          {status === "admission-error" || status === "pairing-error" ? (
            <Alert variant="error">
              <AlertDescription>
                {status === "admission-error"
                  ? gt("Relay access could not be confirmed. Request a fresh operator ticket.")
                  : gt(
                      "The environment could not be paired. Request a new pairing token and operator ticket before trying again.",
                    )}
              </AlertDescription>
            </Alert>
          ) : null}
          <Button
            disabled={submitting || !binding || !operatorTicket.trim()}
            size="sm"
            type="submit"
          >
            {submitting ? gt("Connecting…") : gt("Connect")}
          </Button>
        </form>
      )}
    </StandalonePage>
  );
}

function HostedLinkPairing({ request }: { request: HostedPairingRequest | null }) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(
    request ? "pairing" : "error",
  );
  const [message, setMessage] = useState(
    request
      ? "Connecting to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = async () => {
    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This one-time pairing token was already submitted. Request a new pairing link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "The environment"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
    );
  };

  const submitOnMount = useEffectEvent(() => {
    void submitHostedPairingRequest();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the pairing token from the URL and submits the hosted pairing request once on mount
  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    submitOnMount();
  }, []);

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={
          status === "paired"
            ? "Backend paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing backend"
        }
        description={message}
      />

      {request ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <Alert variant="error" className="mt-5">
          <AlertDescription>
            Verify the backend is reachable from this browser, supports CORS for hosted clients, and
            is served over HTTPS when opening this page from HTTPS.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" ? (
          <Button disabled size="sm">
            Pairing...
          </Button>
        ) : canRetry ? (
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" render={<Link to="/" replace />}>
            Open app
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
