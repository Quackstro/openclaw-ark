# @quackstro/openclaw-backup 📦

Encrypted backup & restore plugin for OpenClaw. Migrate your entire setup — configs, plugins, brain data, wallet, workspace — to a new system in one command.

## Features

- **AES-256-GCM encryption** with PBKDF2 key derivation (600K iterations)
- **Selective backup/restore** — choose which categories to include
- **10 backup categories**: config, credentials, wallet, brain, doc-rag, cron, extensions, workspace, devices, identity
- **Retention policy** — auto-prune old backups by count or age
- **Agent tools** — `backup_create`, `backup_restore`, `backup_list`, `backup_status`
- **CLI commands** — `openclaw backup create|restore|list|prune`
- **Auto-reply** — `/backup` shows quick status
- **Zero external dependencies** — uses Node.js built-in crypto, zlib, and a minimal tar implementation

## Install

```bash
openclaw plugins install @quackstro/openclaw-backup
```

Or clone locally:
```bash
cd ~/.openclaw/extensions
git clone https://github.com/Quackstro/openclaw-backup backup
cd backup && npm install && npm run build
```

## Usage

### CLI

```bash
# Create a backup (all categories)
openclaw backup create -p "my-secure-passphrase"

# Create with specific categories only
openclaw backup create -p "my-passphrase" -c config,wallet,brain

# List backups
openclaw backup list

# Restore (all categories)
openclaw backup restore ./backups/openclaw-backup-2026-02-11.ocbak -p "my-passphrase"

# Restore specific categories only
openclaw backup restore ./backup.ocbak -p "my-passphrase" -c config,workspace

# Dry-run restore (preview without writing)
openclaw backup restore ./backup.ocbak -p "my-passphrase" --dry-run

# Prune old backups per retention policy
openclaw backup prune
```

### Agent (conversational)

> "Create a backup with passphrase 'hunter2'"
> "Show backup status"
> "Restore from the latest backup"
> "List my backups"

### Auto-reply

```
/backup
```

## Configuration

```json5
{
  plugins: {
    entries: {
      backup: {
        enabled: true,
        config: {
          backupDir: "~/.openclaw/backups",
          categories: {
            config: true,
            credentials: true,
            wallet: true,
            brain: true,
            docrag: true,
            cron: true,
            extensions: true,
            workspace: true,
            devices: true,
            identity: true
          },
          retention: {
            maxBackups: 5,
            maxAgeDays: 30
          },
          notifications: {
            enabled: true,
            channel: "telegram",
            target: "your-chat-id"
          }
        }
      }
    }
  }
}
```

## Backup Categories

| Category | Contains | Sensitive |
|---|---|---|
| `config` | `openclaw.json` (API keys, channel tokens) | 🔐 Yes |
| `credentials` | OAuth tokens, provider credentials | 🔐 Yes |
| `wallet` | DOGE keystore, UTXOs, audit log | 🔐 Yes |
| `brain` | Brain stores (LanceDB), pending actions | No |
| `docrag` | Ingested documents + embeddings | No |
| `cron` | Cron job definitions + run history | No |
| `extensions` | Installed plugins (source code) | No |
| `workspace` | Agent workspace (AGENTS.md, memory/, scripts/) | Mixed |
| `devices` | Paired device configs | No |
| `identity` | Agent identity data | No |

## Archive Format

```
OCBAK1 (6 bytes magic)
Salt   (32 bytes — random)
IV     (16 bytes — random)
AuthTag(16 bytes — GCM auth tag)
Body   (AES-256-GCM encrypted tar.gz)
```

Key derivation: PBKDF2-SHA512, 600,000 iterations.

## Migration Workflow

1. **On old system**: `openclaw backup create -p "migrate-2026"`
2. **Copy** the `.ocbak` file to the new system
3. **On new system**: Install OpenClaw, then `openclaw backup restore ./file.ocbak -p "migrate-2026"`
4. **Restart**: `sudo supervisorctl restart openclaw`

## License

MIT — Quackstro LLC
