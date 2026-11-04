import {
  Activity,
  Binary,
  Braces,
  Bug,
  Calculator,
  Database,
  FileText,
  Gauge,
  Globe,
  type LucideIcon,
  Network,
  Puzzle,
  Search,
  Shield,
  TerminalSquare,
  Wrench,
} from "lucide-react";

// An allowlist, not a dynamic lookup, so the bundle only carries these icons.
const PLUGIN_ICONS: ReadonlyMap<string, LucideIcon> = new Map(
  Object.entries({
    activity: Activity,
    binary: Binary,
    braces: Braces,
    bug: Bug,
    calculator: Calculator,
    database: Database,
    "file-text": FileText,
    gauge: Gauge,
    globe: Globe,
    network: Network,
    puzzle: Puzzle,
    search: Search,
    shield: Shield,
    terminal: TerminalSquare,
    wrench: Wrench,
  }),
);

/** The lucide icon a manifest panel names, or `Puzzle` for unknown and missing names. */
export function pluginPanelIcon(name: string | undefined): LucideIcon {
  return (name === undefined ? undefined : PLUGIN_ICONS.get(name)) ?? Puzzle;
}
