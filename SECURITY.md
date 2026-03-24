# CLASHD-27 Secrets Management

## Where keys live

All secrets are stored in ONE file:

```
/home/greenbanaanas/.secrets/clashd27.env
```

- Directory: `chmod 700` (owner-only access)
- File: `chmod 600` (owner read/write only)

The app loads this file at startup via `dotenv`. PM2 does NOT inject keys.

## Rules

1. **Never paste keys into terminal commands** (they end up in `.bash_history`)
2. **Never commit `.env` files** — `.gitignore` blocks them
3. **Never `export OPENAI_API_KEY=...`** in your shell profile
4. **Never pass keys via PM2 `--env`** flags

## How to edit keys

```bash
nano /home/greenbanaanas/.secrets/clashd27.env
```

Then restart the app:

```bash
pm2 restart clashd27-bot
```

## How to rotate keys

1. Generate a new key at the provider's dashboard
2. Edit `/home/greenbanaanas/.secrets/clashd27.env` — replace the old value
3. `pm2 restart clashd27-bot`
4. Verify: `cd ~/clashd27 && node tools/verify-secrets.js`
5. Revoke the old key at the provider's dashboard

## Verification

```bash
cd ~/clashd27
node tools/verify-secrets.js   # checks key presence + OpenAI connectivity
npm run doctor                  # full health check
```
