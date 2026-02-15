/**
 * Backup config parser and defaults.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface BackupCategory {
  id: string;
  label: string;
  sensitive: boolean;
  /** Resolve the absolute path(s) for this category */
  paths: (ocDir: string, workspace: string) => string[];
}

/**
 * Discover all agent workspace directories.
 * Includes the primary workspace (~/clawd or ~/.openclaw/workspace)
 * plus any workspace-* directories under ~/.openclaw/.
 */
function discoverWorkspaces(ocDir: string, primaryWorkspace: string): string[] {
  const paths = [primaryWorkspace];
  try {
    const entries = readdirSync(ocDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("workspace-")) {
        paths.push(resolve(ocDir, entry.name));
      }
    }
  } catch {
    // ocDir not readable
  }
  return paths;
}

export const CATEGORIES: BackupCategory[] = [
  {
    id: "config",
    label: "OpenClaw Config",
    sensitive: true,
    paths: (oc) => [resolve(oc, "openclaw.json")],
  },
  {
    id: "credentials",
    label: "Credentials",
    sensitive: true,
    paths: (oc) => [resolve(oc, "credentials")],
  },
  {
    id: "wallet",
    label: "DOGE Wallet",
    sensitive: true,
    paths: (oc) => [resolve(oc, "doge")],
  },
  {
    id: "brain",
    label: "Brain Data",
    sensitive: false,
    paths: (oc) => [resolve(oc, "brain")],
  },
  {
    id: "docrag",
    label: "Document Store",
    sensitive: false,
    paths: (oc) => [resolve(oc, "docrag")],
  },
  {
    id: "cron",
    label: "Cron Jobs",
    sensitive: false,
    paths: (oc) => [resolve(oc, "cron")],
  },
  {
    id: "extensions",
    label: "Extensions/Plugins",
    sensitive: false,
    paths: (oc) => [resolve(oc, "extensions")],
  },
  {
    id: "workspace",
    label: "Agent Workspaces",
    sensitive: false,
    paths: (oc, ws) => discoverWorkspaces(oc, ws),
  },
  {
    id: "devices",
    label: "Paired Devices",
    sensitive: false,
    paths: (oc) => [resolve(oc, "devices")],
  },
  {
    id: "identity",
    label: "Agent Identity",
    sensitive: false,
    paths: (oc) => [resolve(oc, "identity")],
  },
  {
    id: "telegram",
    label: "Telegram State",
    sensitive: false,
    paths: (oc) => [resolve(oc, "telegram")],
  },
  {
    id: "agents",
    label: "Agent Sessions",
    sensitive: false,
    paths: (oc) => [resolve(oc, "agents")],
  },
  {
    id: "subagents",
    label: "Subagent State",
    sensitive: false,
    paths: (oc) => [resolve(oc, "subagents")],
  },
  {
    id: "log-monitor",
    label: "Log Monitor State",
    sensitive: false,
    paths: (oc) => [resolve(oc, "log-monitor")],
  },
];

export interface BackupConfig {
  backupDir: string;
  categories: Record<string, boolean>;
  retention: { maxBackups: number; maxAgeDays: number };
  notifications: { enabled: boolean; channel: string; target?: string };
}

export function parseConfig(raw: Record<string, unknown> = {}): BackupConfig {
  const home = homedir();
  const cats = (raw.categories ?? {}) as Record<string, boolean>;
  const ret = (raw.retention ?? {}) as Record<string, number>;
  const notif = (raw.notifications ?? {}) as Record<string, unknown>;

  return {
    backupDir: resolve(
      ((raw.backupDir as string) ?? `${home}/.openclaw/backups`).replace(
        /^~/,
        home,
      ),
    ),
    categories: Object.fromEntries(
      CATEGORIES.map((c) => [c.id, cats[c.id] !== false]),
    ),
    retention: {
      maxBackups: ret.maxBackups ?? 5,
      maxAgeDays: ret.maxAgeDays ?? 30,
    },
    notifications: {
      enabled: notif.enabled !== false,
      channel: (notif.channel as string) ?? "telegram",
      target: notif.target as string | undefined,
    },
  };
}
