/**
 * Backup config parser and defaults.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export interface BackupCategory {
  id: string;
  label: string;
  sensitive: boolean;
  /** Resolve the absolute path(s) for this category */
  paths: (ocDir: string, workspace: string) => string[];
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
    label: "Agent Workspace",
    sensitive: false,
    paths: (_oc, ws) => [ws],
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
