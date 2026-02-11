/**
 * Core backup engine — creates encrypted tar.gz archives.
 *
 * Archive format: AES-256-GCM encrypted tar.gz
 * Header: OCBAK1 (6 bytes) + salt (32 bytes) + iv (16 bytes) + authTag (16 bytes)
 * Body: encrypted tar.gz stream
 *
 * Key derivation: PBKDF2 with SHA-512, 600,000 iterations
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { Readable, PassThrough, Transform } from "node:stream";
import { homedir } from "node:os";

import { BackupConfig, CATEGORIES } from "./config.js";

const MAGIC = Buffer.from("OCBAK1");
const SALT_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 600_000;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

export interface BackupManifest {
  version: "1";
  createdAt: string;
  hostname: string;
  categories: string[];
  fileCount: number;
  totalBytes: number;
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
  sizeBytes: number;
  durationMs: number;
}

export interface RestoreResult {
  manifest: BackupManifest;
  restoredCategories: string[];
  fileCount: number;
  durationMs: number;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha512");
}

/**
 * Simple tar packer — writes POSIX tar format.
 * We roll our own to avoid external deps. Only handles files (no symlinks/devices).
 */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  // name (100 bytes)
  header.write(name.slice(0, 99), 0, "utf-8");
  // mode (8 bytes)
  header.write("0000644\0", 100, "utf-8");
  // uid/gid
  header.write("0001000\0", 108, "utf-8");
  header.write("0001000\0", 116, "utf-8");
  // size (12 bytes, octal)
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf-8");
  // mtime
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, "utf-8");
  // typeflag '0' = regular file
  header.write("0", 156, "utf-8");
  // magic
  header.write("ustar\0", 257, "utf-8");
  header.write("00", 263, "utf-8");
  // Compute checksum
  header.write("        ", 148, "utf-8"); // blank checksum field
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += header[i]!;
  header.write(chksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf-8");
  return header;
}

/**
 * Collect all files from given paths, returning [relativeName, absolutePath] pairs.
 */
async function collectFiles(
  paths: string[],
  prefix: string,
): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = [];

  async function walk(dir: string, relBase: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // skip unreadable dirs
    }
    for (const entry of entries) {
      // Skip node_modules, .git, and large caches
      if (entry === "node_modules" || entry === ".git" || entry === ".cache") continue;
      const abs = join(dir, entry);
      try {
        const s = await stat(abs);
        if (s.isFile()) {
          files.push([join(prefix, relBase, entry), abs]);
        } else if (s.isDirectory()) {
          await walk(abs, join(relBase, entry));
        }
      } catch {
        // skip inaccessible
      }
    }
  }

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const s = await stat(p);
    if (s.isFile()) {
      files.push([join(prefix, basename(p)), p]);
    } else if (s.isDirectory()) {
      await walk(p, "");
    }
  }

  return files;
}

/**
 * Create an encrypted backup archive.
 */
export async function createBackup(
  passphrase: string,
  config: BackupConfig,
  logger?: { info: (msg: string) => void },
): Promise<BackupResult> {
  const start = Date.now();
  const ocDir = resolve(homedir(), ".openclaw");
  // Try to find workspace
  const workspace = existsSync(resolve(homedir(), "clawd"))
    ? resolve(homedir(), "clawd")
    : resolve(ocDir, "workspace");

  await mkdir(config.backupDir, { recursive: true });

  // Collect files per enabled category
  const enabledCats = CATEGORIES.filter((c) => config.categories[c.id]);
  const allFiles: Array<[string, string]> = [];

  for (const cat of enabledCats) {
    const paths = cat.paths(ocDir, workspace);
    const catFiles = await collectFiles(paths, cat.id);
    allFiles.push(...catFiles);
    logger?.info(`[backup] ${cat.label}: ${catFiles.length} files`);
  }

  // Build manifest
  const manifest: BackupManifest = {
    version: "1",
    createdAt: new Date().toISOString(),
    hostname: (await import("node:os")).hostname(),
    categories: enabledCats.map((c) => c.id),
    fileCount: allFiles.length,
    totalBytes: 0,
  };

  // Build tar in memory (for simplicity; we could stream but backups should be <100MB)
  const chunks: Buffer[] = [];

  // Write manifest as first file
  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2));
  chunks.push(tarHeader("manifest.json", manifestJson.length));
  chunks.push(manifestJson);
  const pad1 = 512 - (manifestJson.length % 512);
  if (pad1 < 512) chunks.push(Buffer.alloc(pad1));

  for (const [name, absPath] of allFiles) {
    try {
      const content = await readFile(absPath);
      manifest.totalBytes += content.length;
      chunks.push(tarHeader(name, content.length));
      chunks.push(content);
      const pad = 512 - (content.length % 512);
      if (pad < 512) chunks.push(Buffer.alloc(pad));
    } catch {
      // Skip unreadable files
    }
  }

  // Tar end-of-archive marker (two 512-byte zero blocks)
  chunks.push(Buffer.alloc(1024));

  const tarBuf = Buffer.concat(chunks);

  // Gzip
  const { gzipSync } = await import("node:zlib");
  const gzipped = gzipSync(tarBuf, { level: 6 });

  // Encrypt
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Write file: MAGIC + salt + iv + authTag + ciphertext
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `openclaw-backup-${ts}.ocbak`;
  const outPath = join(config.backupDir, filename);

  const output = Buffer.concat([MAGIC, salt, iv, authTag, encrypted]);
  await writeFile(outPath, output);

  // Update manifest with final byte count
  manifest.totalBytes = tarBuf.length;

  const result: BackupResult = {
    path: outPath,
    manifest,
    sizeBytes: output.length,
    durationMs: Date.now() - start,
  };

  logger?.info(`[backup] Created ${filename} (${(output.length / 1024 / 1024).toFixed(1)}MB, ${allFiles.length} files)`);

  return result;
}

/**
 * Decrypt and restore from a backup archive.
 */
export async function restoreBackup(
  archivePath: string,
  passphrase: string,
  config: BackupConfig,
  options: { categories?: string[]; dryRun?: boolean } = {},
  logger?: { info: (msg: string) => void },
): Promise<RestoreResult> {
  const start = Date.now();
  const encrypted = await readFile(archivePath);

  // Verify magic
  if (!encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Invalid backup file — wrong magic header");
  }

  let offset = MAGIC.length;
  const salt = encrypted.subarray(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = encrypted.subarray(offset, offset + IV_LEN);
  offset += IV_LEN;
  const authTag = encrypted.subarray(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const ciphertext = encrypted.subarray(offset);

  // Decrypt
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let gzipped: Buffer;
  try {
    gzipped = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted archive");
  }

  // Decompress
  const { gunzipSync } = await import("node:zlib");
  const tar = gunzipSync(gzipped);

  // Parse tar
  const ocDir = resolve(homedir(), ".openclaw");
  const workspace = existsSync(resolve(homedir(), "clawd"))
    ? resolve(homedir(), "clawd")
    : resolve(ocDir, "workspace");

  let manifest: BackupManifest | null = null;
  const restoredCategories = new Set<string>();
  let fileCount = 0;
  let pos = 0;

  const filterCats = options.categories
    ? new Set(options.categories)
    : null;

  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    // Check for end-of-archive (zero block)
    if (header.every((b) => b === 0)) break;

    const name = header.subarray(0, 100).toString("utf-8").replace(/\0/g, "");
    const sizeStr = header.subarray(124, 136).toString("utf-8").replace(/\0/g, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    pos += 512;

    const content = tar.subarray(pos, pos + size);
    pos += size;
    // Skip to next 512-byte boundary
    const remainder = size % 512;
    if (remainder > 0) pos += 512 - remainder;

    if (name === "manifest.json") {
      manifest = JSON.parse(content.toString("utf-8"));
      continue;
    }

    // Category is the first path segment
    const catId = name.split("/")[0]!;
    if (filterCats && !filterCats.has(catId)) continue;

    // Resolve output path
    const catDef = CATEGORIES.find((c) => c.id === catId);
    if (!catDef) continue;

    const relPath = name.slice(catId.length + 1); // strip "catId/"
    const basePaths = catDef.paths(ocDir, workspace);
    // Use first base path
    const base = basePaths[0]!;
    let outPath: string;

    // If the base is a file (like openclaw.json), write directly to it
    // The tar entry will be "config/openclaw.json" so relPath = "openclaw.json"
    if (!relPath) {
      outPath = base;
    } else if (base.match(/\.[a-z]+$/i)) {
      // Base is a file path (has extension) — write to base directly, ignore relPath
      outPath = base;
    } else {
      outPath = resolve(base, relPath);
    }

    if (options.dryRun) {
      logger?.info(`[restore] (dry-run) ${outPath}`);
    } else {
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, content);
    }

    restoredCategories.add(catId);
    fileCount++;
  }

  return {
    manifest: manifest!,
    restoredCategories: [...restoredCategories],
    fileCount,
    durationMs: Date.now() - start,
  };
}

/**
 * List existing backups in the backup directory.
 */
export async function listBackups(
  backupDir: string,
): Promise<Array<{ filename: string; path: string; sizeBytes: number; createdAt: Date }>> {
  if (!existsSync(backupDir)) return [];
  const entries = await readdir(backupDir);
  const backups: Array<{ filename: string; path: string; sizeBytes: number; createdAt: Date }> = [];

  for (const entry of entries) {
    if (!entry.endsWith(".ocbak")) continue;
    const p = join(backupDir, entry);
    const s = await stat(p);
    backups.push({ filename: entry, path: p, sizeBytes: s.size, createdAt: s.mtime });
  }

  return backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Prune old backups based on retention policy.
 */
export async function pruneBackups(
  config: BackupConfig,
  logger?: { info: (msg: string) => void },
): Promise<string[]> {
  const backups = await listBackups(config.backupDir);
  const pruned: string[] = [];
  const now = Date.now();
  const maxAge = config.retention.maxAgeDays * 86400_000;

  // By age
  for (const b of backups) {
    if (now - b.createdAt.getTime() > maxAge) {
      await unlink(b.path);
      pruned.push(b.filename);
      logger?.info(`[backup] Pruned (age): ${b.filename}`);
    }
  }

  // By count (re-list after age pruning)
  const remaining = await listBackups(config.backupDir);
  if (remaining.length > config.retention.maxBackups) {
    const toRemove = remaining.slice(config.retention.maxBackups);
    for (const b of toRemove) {
      await unlink(b.path);
      pruned.push(b.filename);
      logger?.info(`[backup] Pruned (count): ${b.filename}`);
    }
  }

  return pruned;
}
