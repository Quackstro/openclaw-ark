/**
 * OpenClaw Backup Plugin — Entry Point
 *
 * Registers:
 * - Agent tools: backup_create, backup_restore, backup_list, backup_status
 * - CLI commands: openclaw backup create|restore|list|prune
 * - Auto-reply command: /backup
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Type } from "@sinclair/typebox";
import { parseConfig, CATEGORIES } from "./src/config.js";
import { createBackup, restoreBackup, listBackups, pruneBackups } from "./src/engine.js";
import { createDownloadLink, createDownloadHandler, cleanupAllDownloads } from "./src/download.js";

export default function register(api: any) {
  const logger = api.logger ?? console;
  const rawCfg = api.config?.plugins?.entries?.ark?.config ?? {};
  const config = parseConfig(rawCfg);

  // ─── Resolve gateway port for download links ───────────────────────────
  const gatewayPort: number =
    api.config?.gateway?.port ??
    (process.env.OPENCLAW_GATEWAY_PORT ? parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10) : 18789);

  // ─── Resolve Telegram bot token for message deletion ──────────────────
  const telegramAccounts = (api.config?.channels?.telegram as any)?.accounts ?? {};
  const defaultBotToken: string | undefined =
    (Object.values(telegramAccounts).find((a: any) => a?.botToken) as any)?.botToken ??
    api.config?.channels?.telegram?.botToken;

  async function deleteTelegramMessage(chatId: string, messageId: string): Promise<boolean> {
    if (!defaultBotToken || !chatId || !messageId) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${defaultBotToken}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn(`[ark] deleteMessage failed (${res.status})`);
        return false;
      }
      return true;
    } catch (err: any) {
      logger.warn(`[ark] deleteMessage error: ${err.message}`);
      return false;
    }
  }

  // ─── Register HTTP handler for download routes ─────────────────────────
  const downloadHandler = createDownloadHandler(logger);
  api.registerHttpHandler?.((req: any, res: any) => downloadHandler(req, res));

  // ─── Agent Tools ───────────────────────────────────────────────────────

  api.registerTool({
    name: "backup_create",
    label: "Create Backup",
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
    async execute(_toolCallId: string, params: { passphrase: string; categories?: string[] }) {
      if (params.passphrase.length < 8) {
        return {
          content: [{ type: "text", text: "Error: Passphrase must be at least 8 characters." }],
          details: { error: "passphrase_too_short" },
        };
      }

      const effectiveConfig = params.categories
        ? {
            ...config,
            categories: Object.fromEntries(
              CATEGORIES.map((c) => [c.id, params.categories!.includes(c.id)]),
            ),
          }
        : config;

      const result = await createBackup(params.passphrase, effectiveConfig, logger);
      const pruned = await pruneBackups(effectiveConfig, logger);

      const sizeMB = result.sizeBytes / 1024 / 1024;
      const TELEGRAM_UPLOAD_LIMIT_MB = 50;

      // Generate a temporary download link
      let downloadInfo: { url: string; expiresAt: number; hasNginxProxy: boolean } | null = null;
      try {
        downloadInfo = await createDownloadLink(result.path, {
          gatewayPort,
          expiryMs: 10 * 60 * 1000, // 10 minutes
          logger,
        });
      } catch (dlErr: any) {
        logger.warn(`[ark] failed to create download link: ${dlErr.message}`);
      }

      // Build download URL
      let downloadUrl: string | null = null;
      let downloadExpiresIn = 0;
      if (downloadInfo) {
        downloadExpiresIn = Math.round((downloadInfo.expiresAt - Date.now()) / 60000);
        const publicHost = process.env.OPENCLAW_PUBLIC_HOST || "20-51-254-213.sslip.io";
        downloadUrl = `https://${publicHost}${downloadInfo.url}`;
      }

      // Build MEDIA: line for Telegram if under limit
      const mediaLine = sizeMB <= TELEGRAM_UPLOAD_LIMIT_MB
        ? `MEDIA: ${result.path}`
        : null;

      const summary = [
        `✅ Backup created: ${result.path}`,
        `📏 Size: ${sizeMB.toFixed(1)}MB | Files: ${result.manifest.fileCount}`,
        `🗂 Categories: ${result.manifest.categories.join(", ")}`,
        `⏱ Duration: ${result.durationMs}ms`,
        pruned.length > 0 ? `🗑 Pruned ${pruned.length} old backup(s)` : "",
        sizeMB > TELEGRAM_UPLOAD_LIMIT_MB ? `⚠️ Backup exceeds ${TELEGRAM_UPLOAD_LIMIT_MB}MB Telegram upload limit.` : "",
        mediaLine ? `\n📎 Send the file via Telegram by including this line verbatim in your reply:\n${mediaLine}` : "",
        downloadUrl ? `\n📥 Download link (${downloadExpiresIn}min, one-time): ${downloadUrl}` : "",
      ].filter(Boolean).join("\n");

      // Build inline URL button for download link (rendered by Telegram, LLM can't strip it)
      const buttons = downloadUrl
        ? [[{ text: `📥 Download Backup (${downloadExpiresIn}min)`, url: downloadUrl }]]
        : undefined;

      return {
        content: [{ type: "text", text: summary }],
        channelData: buttons ? { telegram: { buttons } } : undefined,
        details: {
          path: result.path,
          sizeBytes: result.sizeBytes,
          sizeMB: sizeMB.toFixed(1),
          fileCount: result.manifest.fileCount,
          categories: result.manifest.categories,
          durationMs: result.durationMs,
          pruned: pruned.length > 0 ? pruned : undefined,
          downloadUrl: downloadInfo?.url ?? null,
          downloadExpiresAt: downloadInfo?.expiresAt ?? null,
          hasNginxProxy: downloadInfo?.hasNginxProxy ?? false,
        },
      };
    },
  });

  api.registerTool({
    name: "backup_restore",
    label: "Restore Backup",
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
    async execute(_toolCallId: string, params: {
      archivePath: string;
      passphrase: string;
      categories?: string[];
      dryRun?: boolean;
    }) {
      try {
        const result = await restoreBackup(
          params.archivePath,
          params.passphrase,
          config,
          { categories: params.categories, dryRun: params.dryRun },
          logger,
        );

        const prefix = params.dryRun ? "📋 Dry run" : "✅ Restore complete";
        const summary = [
          `${prefix}: ${result.fileCount} files from ${result.restoredCategories.join(", ")}`,
          `📅 Backup created: ${result.manifest.createdAt}`,
          `🖥 Original host: ${result.manifest.hostname}`,
          `⏱ Duration: ${result.durationMs}ms`,
          !params.dryRun ? "\n⚠️ Restart gateway to apply config changes." : "",
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text", text: summary }],
          details: {
            manifest: result.manifest,
            restoredCategories: result.restoredCategories,
            fileCount: result.fileCount,
            durationMs: result.durationMs,
            dryRun: !!params.dryRun,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ Restore failed: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  api.registerTool({
    name: "backup_list",
    label: "List Backups",
    description: "List existing backup archives with sizes and dates.",
    parameters: Type.Object({}),
    async execute() {
      const backups = await listBackups(config.backupDir);

      if (backups.length === 0) {
        return {
          content: [{ type: "text", text: `📦 No backups found in ${config.backupDir}` }],
          details: { backupDir: config.backupDir, count: 0, backups: [] },
        };
      }

      const lines = backups.map(
        (b) =>
          `  ${b.filename}  ${(b.sizeBytes / 1024 / 1024).toFixed(1)}MB  ${b.createdAt.toISOString()}`,
      );
      const text = `📦 Backups in ${config.backupDir} (${backups.length}):\n\n${lines.join("\n")}`;

      return {
        content: [{ type: "text", text }],
        details: {
          backupDir: config.backupDir,
          count: backups.length,
          backups: backups.map((b) => ({
            filename: b.filename,
            sizeMB: (b.sizeBytes / 1024 / 1024).toFixed(1),
            createdAt: b.createdAt.toISOString(),
          })),
        },
      };
    },
  });

  api.registerTool({
    name: "backup_status",
    label: "Backup Status",
    description:
      "Show backup plugin status: config, last backup, retention policy, available categories.",
    parameters: Type.Object({}),
    async execute() {
      const backups = await listBackups(config.backupDir);
      const lastBackup = backups[0];
      const enabled = CATEGORIES.filter((c) => config.categories[c.id]).map(
        (c) => `${c.id} (${c.label}${c.sensitive ? " 🔐" : ""})`,
      );

      const lines = [
        `📦 Backup Plugin Status`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `📂 Dir: ${config.backupDir}`,
        `🗂 Categories: ${enabled.join(", ")}`,
        `🔄 Retention: ${config.retention.maxBackups} backups, ${config.retention.maxAgeDays} days`,
        `📊 Total backups: ${backups.length}`,
        lastBackup
          ? `📅 Last: ${lastBackup.filename} (${(lastBackup.sizeBytes / 1024 / 1024).toFixed(1)}MB, ${lastBackup.createdAt.toISOString()})`
          : `📅 Last: none`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          backupDir: config.backupDir,
          enabledCategories: enabled,
          retention: config.retention,
          totalBackups: backups.length,
          lastBackup: lastBackup
            ? {
                filename: lastBackup.filename,
                sizeMB: (lastBackup.sizeBytes / 1024 / 1024).toFixed(1),
                createdAt: lastBackup.createdAt.toISOString(),
              }
            : null,
        },
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
        .option("-c, --categories <cats>", "Comma-separated categories to include")
        .action(async (opts: any) => {
          const pass = opts.passphrase ?? process.env.OPENCLAW_BACKUP_PASSPHRASE;
          if (!pass) {
            console.error("Error: passphrase required (--passphrase or OPENCLAW_BACKUP_PASSPHRASE env)");
            process.exit(1);
          }
          if (pass.length < 8) {
            console.error("Error: passphrase must be at least 8 characters");
            process.exit(1);
          }

          const cats = opts.categories?.split(",");
          const effectiveConfig = cats
            ? { ...config, categories: Object.fromEntries(CATEGORIES.map((c) => [c.id, cats.includes(c.id)])) }
            : config;

          console.log("Creating backup...");
          const result = await createBackup(pass, effectiveConfig, { info: (m: string) => console.log(m) });
          console.log(`\n✅ Backup created: ${result.path}`);
          console.log(`   Size: ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB | Files: ${result.manifest.fileCount} | Time: ${result.durationMs}ms`);
          console.log(`   Categories: ${result.manifest.categories.join(", ")}`);

          const pruned = await pruneBackups(effectiveConfig, { info: (m: string) => console.log(m) });
          if (pruned.length > 0) console.log(`   Pruned ${pruned.length} old backup(s)`);
        });

      cmd
        .command("restore <file>")
        .description("Restore from an encrypted backup")
        .option("-p, --passphrase <pass>", "Decryption passphrase")
        .option("-c, --categories <cats>", "Comma-separated categories to restore")
        .option("--dry-run", "Preview without writing files")
        .action(async (file: string, opts: any) => {
          const pass = opts.passphrase ?? process.env.OPENCLAW_BACKUP_PASSPHRASE;
          if (!pass) { console.error("Error: passphrase required"); process.exit(1); }

          const cats = opts.categories?.split(",");
          console.log(opts.dryRun ? "Previewing restore..." : "Restoring backup...");
          const result = await restoreBackup(file, pass, config, { categories: cats, dryRun: opts.dryRun }, { info: (m: string) => console.log(m) });
          console.log(`\n${opts.dryRun ? "📋 Preview" : "✅ Restored"}: ${result.fileCount} files from ${result.restoredCategories.join(", ")}`);
          if (!opts.dryRun) console.log("Restart the gateway to apply config changes: sudo supervisorctl restart openclaw");
        });

      cmd
        .command("list")
        .description("List backup archives")
        .action(async () => {
          const backups = await listBackups(config.backupDir);
          if (backups.length === 0) { console.log("No backups found."); return; }
          console.log(`Backups in ${config.backupDir}:\n`);
          for (const b of backups) {
            console.log(`  ${b.filename}  ${(b.sizeBytes / 1024 / 1024).toFixed(1)}MB  ${b.createdAt.toISOString()}`);
          }
        });

      cmd
        .command("prune")
        .description("Remove old backups per retention policy")
        .action(async () => {
          const pruned = await pruneBackups(config, { info: (m: string) => console.log(m) });
          console.log(pruned.length > 0 ? `Pruned ${pruned.length} backup(s)` : "Nothing to prune");
        });
    },
    { commands: ["backup"] },
  );

  // ─── Auto-reply command: /ark ────────────────────────────────────────

  api.registerCommand({
    name: "ark",
    description: "🚢 Ark backup & restore — /ark [backup|restore|list|status|help]",
    acceptsArgs: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() ?? "";
      const parts = args.split(/\s+/);
      const subCmd = (parts[0] ?? "").toLowerCase();
      const subArgs = parts.slice(1).join(" ");

      switch (subCmd) {
        case "":
        case "status": {
          const backups = await listBackups(config.backupDir);
          const last = backups[0];
          const enabled = CATEGORIES.filter((c) => config.categories[c.id]).map((c) => c.id).join(", ");
          return {
            text: last
              ? `🚢 Ark Status\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Last: ${last.filename}\n📏 ${(last.sizeBytes / 1024 / 1024).toFixed(1)}MB | ${last.createdAt.toISOString()}\n📂 ${backups.length} total\n🗂 Categories: ${enabled}`
              : `🚢 Ark Status\n━━━━━━━━━━━━━━━━━━━━━━\n📦 No backups yet.\n🗂 Categories: ${enabled}\n\nUse /ark backup <passphrase> to create one.`,
          };
        }

        case "backup":
        case "create": {
          const passphrase = subArgs.trim();
          if (!passphrase || passphrase.length < 8) {
            return { text: "⚠️ Usage: /ark backup <passphrase>\nPassphrase must be at least 8 characters." };
          }

          // Delete the user's message immediately — it contains the passphrase
          if (ctx.chatId && ctx.messageId) {
            deleteTelegramMessage(ctx.chatId, ctx.messageId).catch(() => {});
          }

          try {
            const result = await createBackup(passphrase, config, logger);
            const pruned = await pruneBackups(config, logger);
            const sizeMB = result.sizeBytes / 1024 / 1024;

            // Generate download link
            let downloadInfo: { url: string; expiresAt: number; hasNginxProxy: boolean } | null = null;
            try {
              downloadInfo = await createDownloadLink(result.path, {
                gatewayPort,
                expiryMs: 10 * 60 * 1000,
                logger,
              });
              logger.info(`[ark] download link created: ${JSON.stringify(downloadInfo)}`);
            } catch (dlErr: any) {
              logger.error(`[ark] download link failed: ${dlErr.message}\n${dlErr.stack}`);
            }

            const text = [
              `✅ Backup created!`,
              `📦 ${result.path.split("/").pop()}`,
              `📏 ${sizeMB.toFixed(1)}MB | ${result.manifest.fileCount} files | ${result.durationMs}ms`,
              `🗂 ${result.manifest.categories.join(", ")}`,
              pruned.length > 0 ? `🗑 Pruned ${pruned.length} old backup(s)` : "",
            ].filter(Boolean).join("\n");

            // Build download button if link available
            logger.info(`[ark] downloadInfo: ${JSON.stringify(downloadInfo)}`);
            const reply: any = { text };
            if (downloadInfo) {
              const expiresIn = Math.round((downloadInfo.expiresAt - Date.now()) / 60000);
              const publicHost = process.env.OPENCLAW_PUBLIC_HOST || "20-51-254-213.sslip.io";
              const fullUrl = `https://${publicHost}${downloadInfo.url}`;
              reply.channelData = {
                telegram: {
                  buttons: [[{ text: `📥 Download Backup (${expiresIn}min)`, url: fullUrl }]],
                },
              };
            }

            return reply;
          } catch (err: any) {
            return { text: `❌ Backup failed: ${err.message}` };
          }
        }

        case "list": {
          const backups = await listBackups(config.backupDir);
          if (backups.length === 0) return { text: "📦 No backups found." };
          const lines = backups.map(
            (b) => `  ${b.filename}\n    ${(b.sizeBytes / 1024 / 1024).toFixed(1)}MB · ${b.createdAt.toISOString()}`,
          );
          return { text: `🚢 Ark Backups (${backups.length})\n━━━━━━━━━━━━━━━━━━━━━━\n${lines.join("\n")}` };
        }

        case "restore": {
          return {
            text: "⚠️ Restore requires the agent tools for safety.\n\nAsk me: \"Restore from the latest backup with passphrase <pass>\"\n\nOr use CLI: openclaw backup restore <file> -p <pass>",
          };
        }

        case "prune": {
          try {
            const pruned = await pruneBackups(config, logger);
            return {
              text: pruned.length > 0
                ? `🗑 Pruned ${pruned.length} backup(s): ${pruned.join(", ")}`
                : "✅ Nothing to prune.",
            };
          } catch (err: any) {
            return { text: `❌ Prune failed: ${err.message}` };
          }
        }

        case "help":
          return {
            text: [
              "🚢 Ark Commands",
              "━━━━━━━━━━━━━━━━━━━━━━",
              "  /ark — Status overview",
              "  /ark backup <passphrase> — Create encrypted backup",
              "  /ark list — List all backups",
              "  /ark restore — Restore instructions",
              "  /ark prune — Remove old backups",
              "  /ark help — This message",
              "",
              "🔐 Archives use AES-256-GCM encryption.",
              "📂 Stored in: ~/.openclaw/backups/",
            ].join("\n"),
          };

        default:
          return { text: `🚢 Unknown command: "${subCmd}"\nTry /ark help` };
      }
    },
  });

  logger.info("[ark] Plugin loaded — openclaw backup create|restore|list|prune");
}
