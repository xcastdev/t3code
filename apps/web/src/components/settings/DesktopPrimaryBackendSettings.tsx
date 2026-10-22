import type { DesktopBridge, DesktopPrimaryBackendState } from "@t3tools/contracts";
import { ServerIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import {
  desktopPrimaryBackendStateAtom,
  desktopPrimaryCredentialExpiry,
  refreshDesktopPrimaryBackendState,
} from "~/state/desktopPrimaryBackend";
import { formatExpiresInLabel } from "~/timestampFormat";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// The bridge method's name reads as a React hook to lint, so it is addressed by key.
const SWITCH_TO_MANAGED_BACKEND = "useManagedPrimaryBackend" satisfies keyof DesktopBridge;
type SwitchToManagedBackend = DesktopBridge[typeof SWITCH_TO_MANAGED_BACKEND];

// Bridge failures come back from the main process already redacted; anything else
// gets a fixed message so a pasted credential can never be echoed back.
function bridgeErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function CredentialForm(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly fallbackError: string;
  readonly onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    setError(null);
    let failure: string | null = null;
    try {
      await props.onSubmit(trimmed);
    } catch (cause) {
      failure = bridgeErrorMessage(cause, props.fallbackError);
    }
    setPending(false);
    if (failure === null) setValue("");
    setError(failure);
  };

  return (
    <form className="flex w-full flex-col gap-1.5" onSubmit={(event) => void submit(event)}>
      <div className="flex w-full items-center gap-2">
        <Input
          type="password"
          font="mono"
          size="sm"
          autoComplete="off"
          spellCheck={false}
          aria-label={props.label}
          placeholder={props.placeholder}
          value={value}
          disabled={pending}
          onValueChange={(next) => {
            setValue(next);
            if (error !== null) setError(null);
          }}
        />
        <Button type="submit" size="sm" disabled={pending || value.trim().length === 0}>
          {pending ? (
            <>
              <Spinner size="sm" />
              {props.pendingLabel}
            </>
          ) : (
            props.submitLabel
          )}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

function UseManagedBackendButton(props: {
  readonly switchToManaged: SwitchToManagedBackend;
  readonly attached: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setPending(true);
    setError(null);
    try {
      await props.switchToManaged();
    } catch (cause) {
      setError(bridgeErrorMessage(cause, "Couldn't switch to the bundled server."));
      setPending(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Use bundled server
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to the bundled server?</AlertDialogTitle>
            <AlertDialogDescription>
              {props.attached
                ? "T3 Code will restart and run its own server on this computer. The attached server keeps running, along with its agents and terminals; reattach it any time with a new pairing link."
                : "T3 Code will forget the unusable attachment, restart and run its own server on this computer."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button disabled={pending} onClick={() => void apply()}>
              {pending ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : (
                "Restart with bundled server"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

// A refresh rotates the attachment revision, and every credential request carries the
// revision captured from the bootstrap, so the window reloads to pick up the new one.
async function refreshAttachedCredential(bridge: DesktopBridge, credential: string) {
  await bridge.refreshPrimaryBackendCredential(credential);
  window.location.reload();
}

function AttachmentCredentialForm(props: {
  readonly bridge: DesktopBridge;
  readonly state: DesktopPrimaryBackendState;
}) {
  const { bridge } = props;
  return props.state.mode === "attached" ? (
    <CredentialForm
      label="New pairing link for the attached server"
      placeholder="http://127.0.0.1:…/pair#token=…"
      submitLabel="Refresh"
      pendingLabel="Refreshing…"
      fallbackError="Couldn't refresh the credential."
      onSubmit={(credential) => refreshAttachedCredential(bridge, credential)}
    />
  ) : (
    <CredentialForm
      label="Pairing link for a server on this computer"
      placeholder="http://127.0.0.1:…/pair#token=…"
      submitLabel="Attach"
      pendingLabel="Attaching…"
      fallbackError="Couldn't attach to that server."
      onSubmit={async (pairingUrl) => {
        await bridge.attachPrimaryBackend(pairingUrl);
        refreshDesktopPrimaryBackendState();
      }}
    />
  );
}

function OwnershipDescription({ state }: { readonly state: DesktopPrimaryBackendState }) {
  // The state is re-read after every change, so the time it was shown is precise enough.
  const [shownAt] = useState(() => Date.now());
  switch (state.mode) {
    case "managed":
      return <>This app starts and stops its own server on this computer.</>;
    case "invalid-attached":
      return (
        <span className="text-destructive">
          The saved attachment can't be used: {state.reason}. Attach again or switch back to the
          bundled server.
        </span>
      );
    case "attached": {
      const expiry = desktopPrimaryCredentialExpiry(state.bearerExpiresAt, shownAt);
      return (
        <span className="flex flex-col gap-0.5">
          <span>
            Attached to <span className="font-medium text-foreground">{state.label}</span>, which
            runs on its own. Quitting this app, detaching or turning off the local environment never
            stops it.
          </span>
          <span className="font-mono text-xs">{state.httpBaseUrl}</span>
          {expiry.kind === "expired" ? (
            <span className="text-destructive">
              Credential expired. Refresh it with a new pairing link.
            </span>
          ) : expiry.kind === "valid" ? (
            <span>Credential {formatExpiresInLabel(state.bearerExpiresAt)}.</span>
          ) : null}
        </span>
      );
    }
  }
}

/**
 * Which server the desktop app's primary environment is. Everything here goes through
 * the main process, so it keeps working while the attached server is unreachable.
 */
export function DesktopPrimaryBackendSettings() {
  const bridge = window.desktopBridge;
  const state = useEnvironmentQuery(bridge ? desktopPrimaryBackendStateAtom : null);
  if (!bridge) return null;
  const current = state.data;

  return (
    <SettingsSection
      {...searchableSetting("primary-server")}
      icon={<ServerIcon aria-hidden className="size-4" />}
    >
      <SettingsRow
        title={
          current?.mode === "attached"
            ? "Attached server"
            : current?.mode === "invalid-attached"
              ? "Attachment unavailable"
              : "Bundled server"
        }
        description={
          current ? (
            <OwnershipDescription state={current} />
          ) : state.error ? (
            <span className="text-destructive">{state.error}</span>
          ) : (
            "Loading…"
          )
        }
        control={
          current === null && state.error ? (
            <Button size="sm" variant="outline" onClick={refreshDesktopPrimaryBackendState}>
              Retry
            </Button>
          ) : current && current.mode !== "managed" ? (
            <UseManagedBackendButton
              switchToManaged={() => bridge[SWITCH_TO_MANAGED_BACKEND]()}
              attached={current.mode === "attached"}
            />
          ) : undefined
        }
      />
      {current?.mode === "attached" ? (
        <SettingsRow
          title="Refresh credential"
          description="Paste a new owner pairing link from the attached server. Its identity is checked before the credential is saved."
        >
          <AttachmentCredentialForm bridge={bridge} state={current} />
        </SettingsRow>
      ) : current ? (
        <SettingsRow
          title="Attach a running server"
          description="Use a T3 Code server already running on this computer instead of the bundled one. Paste its owner pairing link; the app restarts to connect."
        >
          <AttachmentCredentialForm bridge={bridge} state={current} />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}

/**
 * The same attachment controls for pages shown when the primary server can't be
 * reached or won't authenticate this app, where Settings never loads. They only talk
 * to the main process, so nothing here needs the server or a session.
 */
export function DesktopPrimaryBackendRecovery() {
  const bridge = window.desktopBridge;
  const state = useEnvironmentQuery(bridge ? desktopPrimaryBackendStateAtom : null);
  const current = state.data;
  if (!bridge || current === null || current.mode === "managed") return null;

  return (
    <section
      aria-label="Attached server"
      className="mt-5 flex flex-col gap-3 rounded-lg border border-border/70 bg-background/55 p-3 text-sm"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-muted-foreground">
          <OwnershipDescription state={current} />
        </div>
        <UseManagedBackendButton
          switchToManaged={() => bridge[SWITCH_TO_MANAGED_BACKEND]()}
          attached={current.mode === "attached"}
        />
      </div>
      <AttachmentCredentialForm bridge={bridge} state={current} />
    </section>
  );
}
