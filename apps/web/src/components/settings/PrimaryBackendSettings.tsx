import type { DesktopBridge, DesktopPrimaryBackendState } from "@t3tools/contracts";
import { useState } from "react";

import { desktopPrimaryBackendStateAtom } from "~/state/desktopPrimaryBackendState";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsRow } from "./settingsLayout";

export function describeDesktopPrimaryBackend(state: DesktopPrimaryBackendState | null): string {
  if (state?.mode === "attached") {
    return `Using the T3 server at ${state.httpBaseUrl}.`;
  }
  if (state?.mode === "invalid-attached") {
    return "The saved attached backend preference needs recovery before T3 Code can connect.";
  }
  if (state?.mode === "managed") {
    return "Started and managed by the desktop app.";
  }
  return "Loading backend ownership…";
}

export function PrimaryBackendSettings({ bridge }: { readonly bridge: DesktopBridge }) {
  const stateQuery = useEnvironmentQuery(desktopPrimaryBackendStateAtom);
  const state = stateQuery.data;
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [useManagedDialogOpen, setUseManagedDialogOpen] = useState(false);
  const [pairingUrl, setPairingUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitAttach = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await bridge.attachPrimaryBackend(pairingUrl);
      setAttachDialogOpen(false);
      setPairingUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The backend could not be attached.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const switchToManaged = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await bridge.useManagedPrimaryBackend();
      setUseManagedDialogOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The desktop backend could not be restored.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const isAttached = state?.mode === "attached";
  const isInvalid = state?.mode === "invalid-attached";

  return (
    <>
      <SettingsRow
        title="Backend process"
        description={
          <>
            {describeDesktopPrimaryBackend(state)}
            {stateQuery.error ? (
              <span className="mt-1 block text-destructive">{stateQuery.error}</span>
            ) : null}
            {error ? <span className="mt-1 block text-destructive">{error}</span> : null}
          </>
        }
        control={
          isAttached ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setUseManagedDialogOpen(true)}
              disabled={isSubmitting}
            >
              Use desktop backend
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => setAttachDialogOpen(true)}
              disabled={isSubmitting}
            >
              {isInvalid ? "Recover attachment" : "Attach backend"}
            </Button>
          )
        }
      />

      <Dialog open={attachDialogOpen} onOpenChange={setAttachDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Attach primary backend</DialogTitle>
            <DialogDescription>
              Paste the full owner pairing URL printed by <code>t3 serve</code> or
              <code>t3 pair --owner</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              nativeInput
              onChange={(event) => setPairingUrl(event.currentTarget.value)}
              placeholder="http://127.0.0.1:3773/pair#token=..."
              spellCheck={false}
              value={pairingUrl}
            />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
              Cancel
            </DialogClose>
            <Button
              onClick={() => void submitAttach()}
              disabled={isSubmitting || !pairingUrl.trim()}
            >
              {isSubmitting ? "Attaching…" : "Attach and restart"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={useManagedDialogOpen} onOpenChange={setUseManagedDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use desktop backend?</AlertDialogTitle>
            <AlertDialogDescription>
              T3 Code will stop using the attached server and restart with the backend managed on
              this machine.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isSubmitting} />}>
              Cancel
            </AlertDialogClose>
            <Button onClick={() => void switchToManaged()} disabled={isSubmitting}>
              {isSubmitting ? "Restarting…" : "Use desktop backend"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
