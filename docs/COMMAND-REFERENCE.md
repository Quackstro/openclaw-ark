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
🗂 Categories: config, credentials, wallet, brain, docrag, cron, extensions, workspace, devices, identity, telegram, agents, subagents, log-monitor
```

---

### `/ark backup <passphrase>`
Create an encrypted backup of all enabled categories.

**Requirements:**
- Passphrase must be at least 8 characters

**Security:**
- Your message containing the passphrase is **auto-deleted** from the chat immediately
- A progress message ("🚢 Backup started — this may take a moment...") is sent while the backup runs
- The result includes a clickable **📥 Download Backup** button with a one-time HTTPS link (10-minute expiry)

```
✅ Backup created!
📦 openclaw-backup-2026-02-11T01-00-00.ocbak
📏 12.3MB | 847 files | 3200ms
🗂 config, credentials, wallet, brain, docrag, cron, extensions, workspace, devices, identity
[📥 Download Backup (10min)]   ← inline button
```

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

### `/ark restore <passphrase>`
Restore from the **latest** backup archive.

### `/ark restore <filename> <passphrase>`
Restore from a **specific** backup archive. Use `/ark list` to see available filenames.

**Security:**
- Your message containing the passphrase is **auto-deleted** from the chat immediately

```
✅ Restore complete!
📦 openclaw-backup-2026-02-11T01-00-00.ocbak
📂 847 files from config, credentials, wallet, brain, ...
📅 Backup created: 2026-02-11T01:00:00.000Z
⏱ Duration: 1200ms

⚠️ Restart gateway to apply config changes.
```

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
  /ark restore <passphrase> — Restore from latest backup
  /ark restore <file> <passphrase> — Restore specific backup
  /ark list — List all backups
  /ark prune — Remove old backups
  /ark help — This message

🔐 Archives use AES-256-GCM encryption.
📂 Stored in: ~/.openclaw/backups/
```

---

## Agent Tools

Read-only tools are available for conversational use. Backup and restore operations require slash commands for passphrase security — the agent will redirect you if you ask conversationally.

### `backup_create` (redirect)
Not callable — instructs the agent to direct you to `/ark backup <passphrase>`.

### `backup_restore` (redirect)
Not callable — instructs the agent to direct you to `/ark restore <passphrase>`.

> **Why?** Passphrases typed as natural language remain in Telegram chat history. Slash command messages are auto-deleted immediately, keeping your passphrase out of the conversation.

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
