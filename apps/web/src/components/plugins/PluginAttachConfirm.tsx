import { useEffect, useRef, useState, type ReactNode } from "react";

import type { PluginAttachConfirmation } from "~/plugins/attachToChat";
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

interface PendingConfirmation {
  readonly confirmation: PluginAttachConfirmation;
  readonly resolve: (confirmed: boolean) => void;
}

function PluginAttachConfirm(props: {
  readonly confirmation: PluginAttachConfirmation;
  readonly onResolve: (confirmed: boolean) => void;
}) {
  const { confirmation } = props;
  const what = confirmation.kind === "reference" ? "a reference" : "text";
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onResolve(false);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Attach to “{confirmation.destinationTitle}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation.pluginName} wants to add {what} to the draft in “
            {confirmation.destinationTitle}”.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={() => props.onResolve(true)}>Attach</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** A panel host's `confirm` for attaching, and the dialog it shows while one is pending. */
export function usePluginAttachConfirm(): {
  readonly confirm: (confirmation: PluginAttachConfirmation) => Promise<boolean>;
  readonly dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const settleOnUnmount = useRef<PendingConfirmation["resolve"] | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a request still pending when the host unmounts settles as cancelled
  useEffect(
    () => () => {
      settleOnUnmount.current?.(false);
    },
    [],
  );
  const confirm = (confirmation: PluginAttachConfirmation) =>
    new Promise<boolean>((resolve) => {
      settleOnUnmount.current?.(false);
      settleOnUnmount.current = resolve;
      setPending({ confirmation, resolve });
    });
  const resolve = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    if (settleOnUnmount.current === pending?.resolve) settleOnUnmount.current = null;
    setPending(null);
  };
  return {
    confirm,
    dialog:
      pending === null ? null : (
        <PluginAttachConfirm confirmation={pending.confirmation} onResolve={resolve} />
      ),
  };
}
