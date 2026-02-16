# Ark Architecture 🚢

## Overview

Ark is an encrypted backup & restore plugin for OpenClaw. It creates portable `.ocbak` archives containing all the data needed to recreate an OpenClaw installation on a new system.

## Archive Format

```
┌─────────────────────────────────┐
│ OCBAK1    (6 bytes magic)       │
│ Salt      (32 bytes random)     │
│ IV        (16 bytes random)     │
│ AuthTag   (16 bytes GCM tag)    │
│ ┌─────────────────────────────┐ │
│ │  AES-256-GCM encrypted:    │ │
│ │  ┌───────────────────────┐  │ │
│ │  │  gzip compressed:     │  │ │
│ │  │  ┌─────────────────┐  │  │ │
│ │  │  │  POSIX tar:      │  │  │ │
│ │  │  │  manifest.json   │  │  │ │
│ │  │  │  config/...      │  │  │ │
│ │  │  │  wallet/...      │  │  │ │
│ │  │  │  brain/...       │  │  │ │
│ │  │  │  workspace/...   │  │  │ │
│ │  │  │  ...             │  │  │ │
│ │  │  └─────────────────┘  │  │ │
│ │  └───────────────────────┘  │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

## Encryption

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key derivation:** PBKDF2-SHA512, 600,000 iterations
- **Salt:** 32 bytes random per archive
- **IV:** 16 bytes random per archive
- **Auth tag:** 16 bytes (prevents tampering)

The high iteration count makes brute-force attacks impractical while keeping backup creation under a few seconds on modern hardware.

## Backup Categories

Each category maps to specific paths on the filesystem:

| Category | Source Path | Description |
|----------|------------|-------------|
| `config` | `~/.openclaw/openclaw.json` | Main config (API keys, channel tokens, model settings) |
| `credentials` | `~/.openclaw/credentials/` | OAuth tokens, provider auth profiles |
| `wallet` | `~/.openclaw/doge/` | DOGE wallet keystore, UTXOs, audit log |
| `brain` | `~/.openclaw/brain/` | Brain LanceDB stores, pending actions |
| `docrag` | `~/.openclaw/docrag/` | Ingested documents, embeddings, uploads |
| `cron` | `~/.openclaw/cron/` | Cron job definitions, run history |
| `extensions` | `~/.openclaw/extensions/` | All installed plugins (source + node_modules skipped) |
| `workspace` | `~/clawd/` + `~/.openclaw/workspace-*/` | All agent workspaces (auto-discovered) |
| `devices` | `~/.openclaw/devices/` | Paired device configurations |
| `identity` | `~/.openclaw/identity/` | Agent identity data |
| `telegram` | `~/.openclaw/telegram/` | Telegram update offsets (prevents reprocessing) |
| `agents` | `~/.openclaw/agents/` | Agent session state |
| `subagents` | `~/.openclaw/subagents/` | Subagent run state |
| `log-monitor` | `~/.openclaw/log-monitor/` | Log monitor cursor and issue registry |

### Excluded from archives
- `node_modules/` directories (reinstall after restore)
- `.git/` directories (re-clone or re-init)
- `.cache/` directories

## Tar Implementation

Ark includes a minimal POSIX tar packer (no external dependencies). It handles regular files only — no symlinks, devices, or special files. This keeps the plugin dependency-free and the archive portable.

## Retention Policy

Ark automatically prunes old backups after each create:

1. **Age-based:** Delete backups older than `maxAgeDays` (default: 30)
2. **Count-based:** Keep at most `maxBackups` (default: 5), pruning oldest first

Pruning runs after every `backup_create` tool call and `/ark backup` command.

## Manifest

Every archive starts with a `manifest.json` containing:

```json
{
  "version": "1",
  "createdAt": "2026-02-11T01:00:00.000Z",
  "hostname": "ubuntu-server",
  "categories": ["config", "credentials", "wallet", "brain", ...],
  "fileCount": 847,
  "totalBytes": 12345678
}
```

The manifest is read during restore to show backup metadata before extracting.

## Restore Behavior

- **Selective restore:** Only extract specific categories
- **Dry-run:** Preview all files that would be written without touching disk
- **Overwrite:** Existing files are overwritten (no merge)
- **Directory creation:** Missing parent directories are created automatically
- **Config reload:** Gateway must be restarted after restore to pick up config changes

## File Delivery

Ark uses two complementary delivery mechanisms to get backup archives to the user:

### 1. Telegram Direct Send (MEDIA: token)

When `backup_create` completes and the archive is under 50MB, the tool response instructs the agent to include a `MEDIA:` line with the archive path. OpenCore's delivery pipeline parses this token and sends the file via the Telegram Bot API's `sendDocument` method, delivering the `.ocbak` archive as a downloadable document directly in the chat.

- **Size limit:** Telegram allows file uploads up to 50MB.
- **Mime type handling:** `.ocbak` files have no standard mime type, so the delivery pipeline's fallback path routes them to `sendDocument`.

### 2. Download Button (HTTPS via nginx proxy)

For all backups, Ark generates a temporary one-time download link and renders it as a **Telegram inline URL button**.

**Flow:**
1. `/ark backup` generates a random 64-char hex token
2. Registers an HTTP handler at `/ark/download/<token>` on the gateway (port 18789)
3. A permanent nginx `location /ark/download/` block proxies HTTPS requests from the public domain to the gateway
4. The download URL (`https://<public-host>/ark/download/<token>`) is returned as a `channelData.telegram.buttons` inline URL button
5. After 10 minutes (or after one download), the token is invalidated and the in-memory entry is deleted

**Nginx setup (permanent, added once to the HTTPS server block):**
```nginx
location /ark/download/ {
    proxy_pass http://127.0.0.1:18789;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

**Public hostname** is resolved from `OPENCLAW_PUBLIC_HOST` env var, falling back to the configured sslip.io domain.

**Safety features:**
- One-time use tokens (invalidated after first download)
- 10-minute auto-expiry via `setTimeout`
- No persistent state — all tokens are in-memory, cleared on restart
- HTTPS-only — download links use the server's SSL certificate

## Passphrase Security

Slash commands (`/ark backup`, `/ark restore`) **auto-delete** the user's message from Telegram chat immediately after receiving it. This prevents passphrases from persisting in chat history.

- Uses the Telegram Bot API `deleteMessage` endpoint directly
- Resolves the correct bot token per `accountId` (supports multi-account setups)
- A progress message ("🚢 Backup started — this may take a moment...") is sent immediately so the user has feedback while the backup runs
- The `backup_create` and `backup_restore` agent tools are registered as stubs that redirect the LLM to instruct the user to use slash commands instead

## Security Considerations

- Archives contain **sensitive data** (API keys, wallet keys, OAuth tokens)
- Always use a strong passphrase (8+ characters enforced, longer recommended)
- Store `.ocbak` files securely — treat them like private keys
- `/ark backup` and `/ark restore` messages are auto-deleted from Telegram (passphrase protection)
- The passphrase is never stored — losing it means losing the backup
