# Migration Guide 🚢

Step-by-step guide for migrating your OpenClaw installation to a new system using Ark.

## Prerequisites

- Ark plugin installed on the **source** system
- OpenClaw installed on the **target** system
- A way to transfer files between systems (scp, rsync, USB, etc.)

## Step 1: Create a Backup (Source System)

### Via Telegram
```
/ark backup my-migration-passphrase
```

### Via CLI
```bash
openclaw backup create -p "my-migration-passphrase"
```

### Selective backup (optional)
Only back up what you need:
```bash
openclaw backup create -p "my-passphrase" -c config,wallet,brain,workspace
```

Note the output path (e.g., `~/.openclaw/backups/openclaw-backup-2026-02-11T01-00-00.ocbak`).

## Step 2: Transfer the Archive

```bash
# From source to target
scp ~/.openclaw/backups/openclaw-backup-*.ocbak user@new-server:~/
```

## Step 3: Install OpenClaw (Target System)

Follow the standard OpenClaw installation:
```bash
# Install OpenClaw
curl -fsSL https://install.openclaw.ai | bash

# Install Ark plugin
openclaw plugins install @quackstro/ark
```

## Step 4: Restore (Target System)

### Preview first (dry-run)
```bash
openclaw backup restore ~/openclaw-backup-2026-02-11T01-00-00.ocbak -p "my-migration-passphrase" --dry-run
```

### Full restore
```bash
openclaw backup restore ~/openclaw-backup-2026-02-11T01-00-00.ocbak -p "my-migration-passphrase"
```

### Selective restore
```bash
# Only restore config and workspace
openclaw backup restore ~/backup.ocbak -p "my-passphrase" -c config,workspace
```

## Step 5: Post-Restore

### Reinstall plugin dependencies
```bash
cd ~/.openclaw/extensions/doge-wallet && npm install
cd ~/.openclaw/extensions/brain && npm install
cd ~/.openclaw/extensions/ark && npm install
# ... repeat for other plugins
```

### Restart the gateway
```bash
sudo supervisorctl restart openclaw
```

### Verify
```
/ark status
/wallet status
```

## What Gets Migrated

| Category | Includes | Notes |
|----------|----------|-------|
| Config | `openclaw.json` | API keys, model settings, channel config |
| Credentials | OAuth tokens | May need re-auth if tokens expired |
| Wallet | Keystore + audit log | Encrypted keys transfer safely |
| Brain | LanceDB stores + pending actions | Full brain state |
| Doc-RAG | Documents + embeddings | Full document store |
| Cron | Job definitions + history | Jobs resume on restart |
| Extensions | Plugin source code | `node_modules` excluded — reinstall |
| Workspace | All agent workspaces (main + custom) | Auto-discovers `workspace-*` dirs |
| Devices | Paired device configs | May need re-pairing |
| Identity | Agent identity | Preserves agent name/persona |
| Telegram | Update offsets per account | Prevents reprocessing old messages |
| Agents | Agent session state | Session continuity |
| Subagents | Subagent run history | Run state preservation |
| Log Monitor | Cursor + issue registry | Monitoring state continuity |

## What Doesn't Transfer

- **node_modules/** — reinstall with `npm install` per plugin
- **.git/** — re-clone or `git init` if needed
- **System configs** — supervisor, systemd, crontab (set up manually)
- **Swap/OS settings** — recreate on target
- **Running state** — sessions, active connections reset on restart

## Troubleshooting

### "Decryption failed — wrong passphrase or corrupted archive"
- Double-check passphrase (case-sensitive, spaces matter)
- Verify file wasn't truncated during transfer: `ls -la backup.ocbak`

### "Invalid backup file — wrong magic header"
- File is not an `.ocbak` archive, or was corrupted
- Try re-transferring with `scp -C` (compression) disabled

### Plugins not loading after restore
- Run `npm install` in each plugin directory
- Check `openclaw plugins doctor` for issues
- Verify `openclaw.json` has the correct plugin entries

### Wallet locked after restore
- Expected — unlock with `/wallet unlock <passphrase>`
- The wallet passphrase is separate from the backup passphrase
