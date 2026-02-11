/**
 * OpenClaw Backup Plugin — Entry Point
 *
 * Registers:
 * - Agent tools: backup_create, backup_restore, backup_list, backup_status
 * - CLI commands: openclaw backup create|restore|list|prune
 * - Auto-reply command: /backup
 * - Background service for scheduled backups
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Type } from "@sinclair/typebox";
import { parseConfig, CATEGORIES } from "./src/config.js";
import { createBackup, restoreBackup, listBackups, pruneBackups } from "./src/engine.js";

export default function register(api: any) {
  const logger = api.logger ?? console;
  const rawCfg = api.config?.plugins?.entries?.backup?.config ?? {};
  const config = parseConfig(rawCfg);

  // ─── Agent Tools ───────────────────────────────────────────────────────

  api.registerTool({
    name: "backup_create",
    description:
      "Create an encrypted backup of OpenClaw configs, plugins, brain, wallet, and workspace. Returns backup path and stats.",
    parameters: Type.Object({
      passphrase: Type.String({ description: "Encryption passphrase (8+ chars)" }),
      categories: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific categories to back up (default: all enabled)",
        }),
      ),
    }),
    handler: async ({ passphrase, categories }: { passphrase: string; categories?: string[] }) => {
      if (passphrase.length < 8) {
        return { error: "Passphrase must be at least 8 characters" };
      }

      const effectiveConfig = categories
        ? {
            ...config,
            categories: Object.fromEntries(
              CATEGORIES.map((c) => [c.id, categories.includes(c.id)]),
            ),
          }
        : config;

      const result = await createBackup(passphrase, effectiveConfig, logger);

      // Prune old backups
      const pruned = await pruneBackups(effectiveConfig, logger);

      return {
        path: result.path,
        sizeBytes: result.sizeBytes,
        sizeMB: (result.sizeBytes / 1024 / 1024).toFixed(1),
        fileCount: result.manifest.fileCount,
        categories: result.manifest.categories,
        durationMs: result.durationMs,
        pruned: pruned.length > 0 ? pruned : undefined,
      };
    },
  });

  api.registerTool({
    name: "backup_restore",
    description:
      "Restore OpenClaw from an encrypted backup archive. Can selectively restore specific categories. Use dryRun to preview.",
    parameters: Type.Object({
      archivePath: Type.String({ description: "Path to .ocbak backup file" }),
      passphrase: Type.String({ description: "Decryption passphrase" }),
      categories: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific categories to restore (default: all)",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Preview restore without writing files" }),
      ),
    }),
    handler: async ({
      archivePath,
      passphrase,
      categories,
      dryRun,
    }: {
      archivePath: string;
      passphrase: string;
      categories?: string[];
      dryRun?: boolean;
    }) => {
      const result = await restoreBackup(
        archivePath,
        passphrase,
        config,
        { categories, dryRun },
        logger,
      );

      return {
        manifest: result.manifest,
        restoredCategories: result.restoredCategories,
        fileCount: result.fileCount,
        durationMs: result.durationMs,
        dryRun: !!dryRun,
        note: dryRun
          ? "Dry run — no files were written"
          : "Restore complete. Restart gateway to apply config changes.",
      };
    },
  });

  api.registerTool({
    name: "backup_list",
    description: "List existing backup archives with sizes and dates.",
    parameters: Type.Object({}),
    handler: async () => {
      const backups = await listBackups(config.backupDir);
      return {
        backupDir: config.backupDir,
        count: backups.length,
        backups: backups.map((b) => ({
          filename: b.filename,
          sizeMB: (b.sizeBytes / 1024 / 1024).toFixed(1),
          createdAt: b.createdAt.toISOString(),
        })),
      };
    },
  });

  api.registerTool({
    name: "backup_status",
    description:
      "Show backup plugin status: config, last backup, retention policy, available categories.",
    parameters: Type.Object({}),
    handler: async () => {
      const backups = await listBackups(config.backupDir);
      const lastBackup = backups[0];

      return {
        backupDir: config.backupDir,
        enabledCategories: CATEGORIES.filter((c) => config.categories[c.id]).map(
          (c) => `${c.id} (${c.label}${c.sensitive ? " 🔐" : ""})`,
        ),
        retention: config.retention,
        totalBackups: backups.length,
        lastBackup: lastBackup
          ? {
              filename: lastBackup.filename,
              sizeMB: (lastBackup.sizeBytes / 1024 / 1024).toFixed(1),
              createdAt: lastBackup.createdAt.toISOString(),
            }
          : null,
        notifications: config.notifications,
      };
    },
  });

  // ─── CLI Commands ──────────────────────────────────────────────────────

  api.registerCli(
    ({ program }: any) => {
      const cmd = program
        .command("backup")
        .description("Manage OpenClaw backups");

      cmd
        .command("create")
        .description("Create an encrypted backup")
        .option("-p, --passphrase <pass>", "Encryption passphrase")
        .option(
          "-c, --categories <cats>",
          "Comma-separated categories to include",
        )
        .action(async (opts: any) => {
          const pass = opts.passphrase ?? process.env.OPENCLAW_BACKUP_PASSPHRASE;
          if (!pass) {
            console.error(
              "Error: passphrase required (--passphrase or OPENCLAW_BACKUP_PASSPHRASE env)",
            );
            process.exit(1);
          }
          if (pass.length < 8) {
            console.error("Error: passphrase must be at least 8 characters");
            process.exit(1);
          }

          const cats = opts.categories?.split(",");
          const effectiveConfig = cats
            ? {
                ...config,
                categories: Object.fromEntries(
                  CATEGORIES.map((c) => [c.id, cats.includes(c.id)]),
                ),
              }
            : config;

          console.log("Creating backup...");
          const result = await createBackup(pass, effectiveConfig, {
            info: (m: string) => console.log(m),
          });
          console.log(`\n✅ Backup created: ${result.path}`);
          console.log(
            `   Size: ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB | Files: ${result.manifest.fileCount} | Time: ${result.durationMs}ms`,
          );
          console.log(`   Categories: ${result.manifest.categories.join(", ")}`);

          const pruned = await pruneBackups(effectiveConfig, {
            info: (m: string) => console.log(m),
          });
          if (pruned.length > 0) {
            console.log(`   Pruned ${pruned.length} old backup(s)`);
          }
        });

      cmd
        .command("restore <file>")
        .description("Restore from an encrypted backup")
        .option("-p, --passphrase <pass>", "Decryption passphrase")
        .option(
          "-c, --categories <cats>",
          "Comma-separated categories to restore",
        )
        .option("--dry-run", "Preview without writing files")
        .action(async (file: string, opts: any) => {
          const pass = opts.passphrase ?? process.env.OPENCLAW_BACKUP_PASSPHRASE;
          if (!pass) {
            console.error("Error: passphrase required");
            process.exit(1);
          }

          const cats = opts.categories?.split(",");
          console.log(
            opts.dryRun ? "Previewing restore..." : "Restoring backup...",
          );
          const result = await restoreBackup(
            file,
            pass,
            config,
            { categories: cats, dryRun: opts.dryRun },
            { info: (m: string) => console.log(m) },
          );

          console.log(
            `\n${opts.dryRun ? "📋 Preview" : "✅ Restored"}: ${result.fileCount} files from ${result.restoredCategories.join(", ")}`,
          );
          if (!opts.dryRun) {
            console.log(
              "Restart the gateway to apply config changes: sudo supervisorctl restart openclaw",
            );
          }
        });

      cmd
        .command("list")
        .description("List backup archives")
        .action(async () => {
          const backups = await listBackups(config.backupDir);
          if (backups.length === 0) {
            console.log("No backups found.");
            return;
          }
          console.log(`Backups in ${config.backupDir}:\n`);
          for (const b of backups) {
            console.log(
              `  ${b.filename}  ${(b.sizeBytes / 1024 / 1024).toFixed(1)}MB  ${b.createdAt.toISOString()}`,
            );
          }
        });

      cmd
        .command("prune")
        .description("Remove old backups per retention policy")
        .action(async () => {
          const pruned = await pruneBackups(config, {
            info: (m: string) => console.log(m),
          });
          console.log(
            pruned.length > 0
              ? `Pruned ${pruned.length} backup(s)`
              : "Nothing to prune",
          );
        });
    },
    { commands: ["backup"] },
  );

  // ─── Auto-reply command ────────────────────────────────────────────────

  api.registerCommand({
    name: "backup",
    description: "Show backup status",
    handler: async () => {
      const backups = await listBackups(config.backupDir);
      const last = backups[0];
      const enabled = CATEGORIES.filter((c) => config.categories[c.id])
        .map((c) => c.id)
        .join(", ");

      return {
        text: last
          ? `📦 Last backup: ${last.filename}\n📏 ${(last.sizeBytes / 1024 / 1024).toFixed(1)}MB | ${last.createdAt.toISOString()}\n📂 ${backups.length} total in ${config.backupDir}\n🗂 Categories: ${enabled}`
          : `📦 No backups yet.\n🗂 Categories: ${enabled}\n\nAsk me to create one, or run: openclaw backup create -p <passphrase>`,
      };
    },
  });

  logger.info("[backup] Plugin loaded — openclaw backup create|restore|list|prune");
}
