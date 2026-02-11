# Ark Command Reference 🚢

Complete reference for all Ark slash commands and agent tools.

---

## Slash Commands (Auto-reply, No LLM)

### `/ark`
Show backup status overview.

```
🚢 Ark Status
━━━━━━━━━━━━━━━━━━━━━━
📦 Last: openclaw-backup-2026-02-11T01-00-00.ocbak
📏 12.3MB | 2026-02-11T01:00:00.000Z
📂 2 total
🗂 Categories: config, credentials, wallet, brain, docrag, cron, extensions, workspace, devices, identity
```

---

### `/ark backup <passphrase>`
Create an encrypted backup of all enabled categories.

**Requirements:**
- Passphrase must be at least 8 characters

```
/ark backup my-secure-pass-2026
```

```
✅ Backup created!
📦 openclaw-backup-2026-02-11T01-00-00.ocbak
📏 12.3MB | 847 files | 3200ms
🗂 config, credentials, wallet, brain, docrag, cron, extensions, workspace, devices, identity
```

> ⚠️ **Security note:** The passphrase is visible in chat. On Telegram, delete the message after the backup completes. A future version may auto-delete.

---

### `/ark list`
List all backup archives with sizes and dates.

```
🚢 Ark Backups (3)
━━━━━━━━━━━━━━━━━━━━━━
  openclaw-backup-2026-02-11T01-00-00.ocbak
    12.3MB · 2026-02-11T01:00:00.000Z
  openclaw-backup-2026-02-10T00-00-00.ocbak
    11.8MB · 2026-02-10T00:00:00.000Z
  openclaw-backup-2026-02-09T00-00-00.ocbak
    11.5MB · 2026-02-09T00:00:00.000Z
```

---

### `/ark restore`
Shows restore instructions. Restore requires agent tools or CLI for safety (confirmation, selective categories, dry-run).

---

### `/ark prune`
Remove old backups per retention policy (default: max 5 backups, max 30 days).

```
🗑 Pruned 2 backup(s): openclaw-backup-2026-01-01.ocbak, openclaw-backup-2026-01-05.ocbak
```

---

### `/ark help`
Show all available commands.

```
🚢 Ark Commands
━━━━━━━━━━━━━━━━━━━━━━
  /ark — Status overview
  /ark backup <passphrase> — Create encrypted backup
  /ark list — List all backups
  /ark restore — Restore instructions
  /ark prune — Remove old backups
  /ark help — This message

🔐 Archives use AES-256-GCM encryption.
📂 Stored in: ~/.openclaw/backups/
```

---

## Agent Tools

These tools are available for conversational use and sub-agent automation.

### `backup_create`
Create an encrypted backup.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `passphrase` | string | ✅ | Encryption passphrase (8+ chars) |
| `categories` | string[] | ❌ | Specific categories to include (default: all enabled) |

**Example:**
> "Create a backup with passphrase test-backup-2026"
> "Back up only config and wallet with passphrase mypass123"

---

### `backup_restore`
Restore from an encrypted backup archive.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `archivePath` | string | ✅ | Path to `.ocbak` file |
| `passphrase` | string | ✅ | Decryption passphrase |
| `categories` | string[] | ❌ | Categories to restore (default: all) |
| `dryRun` | boolean | ❌ | Preview without writing files |

**Example:**
> "Restore from the latest backup with passphrase test-backup-2026"
> "Dry-run restore of just the workspace"

---

### `backup_list`
List all backup archives.

**Example:**
> "List my backups"
> "Show ark backups"

---

### `backup_status`
Show plugin status, retention policy, and last backup info.

**Example:**
> "Show backup status"
> "Ark status"

---

## CLI Commands

Available via `openclaw backup` on the command line.

### `openclaw backup create`
```bash
openclaw backup create -p "my-passphrase"
openclaw backup create -p "my-passphrase" -c config,wallet,brain
```

| Flag | Description |
|------|-------------|
| `-p, --passphrase` | Encryption passphrase (or `OPENCLAW_BACKUP_PASSPHRASE` env) |
| `-c, --categories` | Comma-separated categories to include |

---

### `openclaw backup restore <file>`
```bash
openclaw backup restore ./backup.ocbak -p "my-passphrase"
openclaw backup restore ./backup.ocbak -p "my-passphrase" -c config,workspace
openclaw backup restore ./backup.ocbak -p "my-passphrase" --dry-run
```

| Flag | Description |
|------|-------------|
| `-p, --passphrase` | Decryption passphrase |
| `-c, --categories` | Comma-separated categories to restore |
| `--dry-run` | Preview without writing files |

---

### `openclaw backup list`
```bash
openclaw backup list
```

---

### `openclaw backup prune`
```bash
openclaw backup prune
```
