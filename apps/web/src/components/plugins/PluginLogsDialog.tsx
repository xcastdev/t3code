import type { PluginLogs } from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export type PluginLogsView =
  | { readonly pluginName: string; readonly lines: PluginLogs["lines"] }
  | { readonly pluginName: string; readonly error: string };

export function PluginLogsDialog(props: {
  readonly view: PluginLogsView;
  readonly onClose: () => void;
}) {
  const { view } = props;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{view.pluginName} logs</DialogTitle>
          <DialogDescription>Recent output from the plugin's backend.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {"error" in view ? (
            <p className="text-destructive-foreground text-sm">{view.error}</p>
          ) : view.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">No output yet.</p>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 font-mono text-xs">
              {view.lines
                .map((line) => `${new Date(line.at).toLocaleTimeString()}  ${line.line}`)
                .join("\n")}
            </pre>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
