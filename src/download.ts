/**
 * Ark Download Server — Temporary HTTP download links for backup archives.
 *
 * Flow:
 * 1. After backup_create, a one-time download token is generated
 * 2. An HTTP route is registered on the gateway: /ark/download/<token>
 * 3. If nginx is detected, a temporary location block is added to proxy the route
 * 4. After expiry (default 10 min), the token is invalidated and nginx config removed
 *
 * The nginx config is written to /etc/nginx/conf.d/ark-download-<token>.conf
 * using a `location = /ark/download/<token>` block that proxies to the gateway port.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile, unlink, stat, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";

const execFileAsync = promisify(execFileCb);

// ─── Types ───────────────────────────────────────────────────────────────

interface DownloadToken {
  token: string;
  filePath: string;
  createdAt: number;
  expiresAt: number;
  oneTime: boolean;
  consumed: boolean;
  nginxConfPath: string | null;
}

interface DownloadServerOptions {
  gatewayPort: number;
  expiryMs?: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const NGINX_CONF_DIR = "/etc/nginx/conf.d";
const ARK_ROUTE_PREFIX = "/ark/download";

// ─── State ───────────────────────────────────────────────────────────────

const activeTokens = new Map<string, DownloadToken>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── Nginx Detection & Management ────────────────────────────────────────

const NGINX_BIN_CANDIDATES = ["/usr/sbin/nginx", "/usr/bin/nginx", "/usr/local/bin/nginx", "nginx"];

let resolvedNginxBin: string | null = null;

async function findNginxBin(): Promise<string | null> {
  if (resolvedNginxBin) return resolvedNginxBin;
  for (const candidate of NGINX_BIN_CANDIDATES) {
    try {
      await execFileAsync(candidate, ["-v"]);
      resolvedNginxBin = candidate;
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function isNginxInstalled(): Promise<boolean> {
  return (await findNginxBin()) !== null;
}

async function isNginxRunning(): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", "nginx"]);
    return true;
  } catch {
    return false;
  }
}

async function canWriteNginxConf(): Promise<boolean> {
  try {
    await access(NGINX_CONF_DIR);
    // Test write by checking if we can sudo
    await execFileAsync("sudo", ["-n", "test", "-w", NGINX_CONF_DIR]);
    return true;
  } catch {
    return false;
  }
}

function buildNginxConf(token: string, gatewayPort: number): string {
  // We use a separate server block snippet that gets included.
  // Since conf.d is typically included inside the http {} block,
  // we add a location via a map + match approach.
  // Actually, conf.d snippets in most nginx setups are included inside http{}.
  // We need to add a location to an existing server block.
  // Safest approach: use a standalone conf file with an upstream match.
  //
  // Better approach: write a small conf that defines a server on a specific
  // internal port, then... no, that's overengineered.
  //
  // Simplest correct approach: use nginx's include from within a server block.
  // But conf.d is included at http{} level, not server{} level on most distros.
  //
  // Most portable approach: write a full server block on port 80 that only
  // matches this exact path, then proxy_pass to gateway.
  // Problem: conflicts with existing port 80 server.
  //
  // Actual simplest approach: write a snippet to /etc/nginx/snippets/ark-download.conf
  // and require the user to include it... no, that's not automatic.
  //
  // OK — the best approach for Ubuntu/Debian is to write the conf into
  // the default site's location blocks. But we can't safely modify existing
  // server blocks.
  //
  // Final approach: Use a separate server block on a different port (e.g., 18790)
  // that proxies to gateway. Or better — just add a location block to the
  // default server via an include directive.
  //
  // PRAGMATIC approach: Write a standalone server on port 443/80 with
  // exact location matching. Nginx allows multiple server blocks on the same
  // port — it uses server_name to distinguish. We'll use the wildcard.

  return `# Ark temporary download proxy — auto-generated, auto-removed
# Token: ${token}
# Expires: ${new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString()}

server {
    listen 80;
    listen [::]:80;
    server_name _;

    location = ${ARK_ROUTE_PREFIX}/${token} {
        proxy_pass http://127.0.0.1:${gatewayPort}${ARK_ROUTE_PREFIX}/${token};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
`;
}

async function addNginxRoute(token: string, gatewayPort: number, logger: DownloadServerOptions["logger"]): Promise<string | null> {
  const hasNginx = await isNginxInstalled();
  if (!hasNginx) {
    logger?.info("[ark-download] nginx not installed — skipping proxy config");
    return null;
  }

  const running = await isNginxRunning();
  if (!running) {
    logger?.info("[ark-download] nginx not running — skipping proxy config");
    return null;
  }

  const canWrite = await canWriteNginxConf();
  if (!canWrite) {
    logger?.warn("[ark-download] cannot write to nginx conf.d (no sudo) — skipping proxy config");
    return null;
  }

  const confPath = `${NGINX_CONF_DIR}/ark-download-${token.slice(0, 8)}.conf`;
  const conf = buildNginxConf(token, gatewayPort);

  try {
    // Write config via sudo tee
    await new Promise<void>((resolve, reject) => {
      const proc = execFileCb("sudo", ["tee", confPath], (err) => {
        if (err) reject(err);
        else resolve();
      });
      proc.stdin?.write(conf);
      proc.stdin?.end();
    });

    const nginxBin = resolvedNginxBin ?? "nginx";

    // Test nginx config before reload
    try {
      await execFileAsync("sudo", [nginxBin, "-t"]);
    } catch (testErr: any) {
      logger?.error(`[ark-download] nginx config test failed — removing: ${testErr.stderr ?? testErr.message}`);
      await execFileAsync("sudo", ["rm", "-f", confPath]).catch(() => {});
      return null;
    }

    // Reload nginx
    await execFileAsync("sudo", [nginxBin, "-s", "reload"]);
    logger?.info(`[ark-download] nginx proxy added: ${confPath}`);
    return confPath;
  } catch (err: any) {
    logger?.error(`[ark-download] failed to add nginx route: ${err.message}`);
    await execFileAsync("sudo", ["rm", "-f", confPath]).catch(() => {});
    return null;
  }
}

async function removeNginxRoute(confPath: string, logger: DownloadServerOptions["logger"]): Promise<void> {
  try {
    await execFileAsync("sudo", ["rm", "-f", confPath]);
    // Test config is still valid
    const nginxBin = resolvedNginxBin ?? "nginx";
    try {
      await execFileAsync("sudo", [nginxBin, "-t"]);
    } catch {
      // Config test failed — nothing we can do, the file is already removed
    }
    await execFileAsync("sudo", [nginxBin, "-s", "reload"]);
    logger?.info(`[ark-download] nginx proxy removed: ${confPath}`);
  } catch (err: any) {
    logger?.warn(`[ark-download] failed to remove nginx route: ${err.message}`);
  }
}

// ─── Token Management ────────────────────────────────────────────────────

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

async function invalidateToken(token: string, logger: DownloadServerOptions["logger"]): Promise<void> {
  const entry = activeTokens.get(token);
  if (!entry) return;

  // Clear expiry timer
  const timer = expiryTimers.get(token);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(token);
  }

  // Remove nginx config
  if (entry.nginxConfPath) {
    await removeNginxRoute(entry.nginxConfPath, logger);
  }

  activeTokens.delete(token);
  logger?.info(`[ark-download] token invalidated: ${token.slice(0, 8)}...`);
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function createDownloadLink(
  filePath: string,
  opts: DownloadServerOptions,
): Promise<{ token: string; url: string; expiresAt: number; hasNginxProxy: boolean }> {
  const { gatewayPort, expiryMs = DEFAULT_EXPIRY_MS, logger } = opts;

  // Validate file exists
  await stat(filePath);

  const token = generateToken();
  const expiresAt = Date.now() + expiryMs;

  const entry: DownloadToken = {
    token,
    filePath,
    createdAt: Date.now(),
    expiresAt,
    oneTime: true,
    consumed: false,
    nginxConfPath: null,
  };

  activeTokens.set(token, entry);

  // Schedule auto-cleanup
  const timer = setTimeout(() => {
    invalidateToken(token, logger).catch(() => {});
  }, expiryMs);
  timer.unref(); // Don't block process exit
  expiryTimers.set(token, timer);

  const url = `${ARK_ROUTE_PREFIX}/${token}`;

  logger?.info(`[ark-download] link created: ${url} (expires in ${expiryMs / 1000}s)`);

  return {
    token,
    url,
    expiresAt,
    hasNginxProxy: true, // permanent nginx proxy assumed
  };
}

/**
 * Create the HTTP request handler for download routes.
 * Register this with api.registerHttpRoute for each created token,
 * or use a single handler with registerHttpHandler.
 */
export function createDownloadHandler(
  logger?: DownloadServerOptions["logger"],
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Only handle /ark/download/<token>
    if (!pathname.startsWith(`${ARK_ROUTE_PREFIX}/`)) {
      return false;
    }

    const token = pathname.slice(ARK_ROUTE_PREFIX.length + 1);
    if (!token) {
      res.statusCode = 404;
      res.end("Not Found");
      return true;
    }

    const entry = activeTokens.get(token);

    // Token not found or expired
    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("Link expired or not found.");
      return true;
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      await invalidateToken(token, logger);
      res.statusCode = 410;
      res.setHeader("Content-Type", "text/plain");
      res.end("Download link has expired.");
      return true;
    }

    // Check already consumed (one-time)
    if (entry.oneTime && entry.consumed) {
      await invalidateToken(token, logger);
      res.statusCode = 410;
      res.setHeader("Content-Type", "text/plain");
      res.end("Download link has already been used.");
      return true;
    }

    // Serve the file
    try {
      const fileStat = await stat(entry.filePath);
      const filename = basename(entry.filePath);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", fileStat.size);
      res.setHeader("Cache-Control", "no-store");

      const stream = createReadStream(entry.filePath);
      stream.pipe(res);

      stream.on("end", () => {
        entry.consumed = true;
        logger?.info(`[ark-download] file served: ${filename} (${(fileStat.size / 1024 / 1024).toFixed(1)}MB)`);
        // Invalidate after serving (one-time)
        if (entry.oneTime) {
          invalidateToken(token, logger).catch(() => {});
        }
      });

      stream.on("error", (err) => {
        logger?.error(`[ark-download] stream error: ${err.message}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("File read error.");
        }
      });

      return true;
    } catch (err: any) {
      logger?.error(`[ark-download] file not found: ${entry.filePath}`);
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("Backup file not found on server.");
      return true;
    }
  };
}

/**
 * Clean up all active tokens and nginx configs. Call on plugin shutdown.
 */
export async function cleanupAllDownloads(logger?: DownloadServerOptions["logger"]): Promise<void> {
  for (const [token] of activeTokens) {
    await invalidateToken(token, logger);
  }
}
