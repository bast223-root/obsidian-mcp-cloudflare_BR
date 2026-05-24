# Deployment

This guide covers two scenarios:

1. **[First-time deployment](#first-time-deployment)** — you are deploying this Worker to your own Cloudflare account from scratch.
2. **[Routine operations](#routine-operations)** — you already have a deploy and want to push a code change, rotate the password, roll back, etc.

For per-version change history, see [CHANGELOG.md](./CHANGELOG.md).

---

## First-time deployment

What you'll end up with:

- An R2 bucket holding your Obsidian vault as plain `.md` files (no encryption, no proprietary format).
- Remotely Save plugin running on every Obsidian device, syncing bidirectionally with that bucket.
- A Cloudflare Worker at a URL of your choosing, exposing 16 MCP tools over OAuth.
- Claude.ai connected as an MCP client.

Estimated time: 30–60 minutes (mostly waiting on DNS and your first Obsidian sync).

### Prerequisites

- A Cloudflare account with **R2 enabled** (free tier is fine — 10 GB storage + 1M Class A ops/month is plenty for a personal vault). Enable R2 from dash → R2 → "Enable R2".
- A domain on Cloudflare DNS (optional — you can use a `*.workers.dev` subdomain instead).
- Node.js 22+ and npm.
- An existing Obsidian vault on at least one device.
- A Claude.ai account that supports custom MCP connectors.

### 1. Clone and install

```bash
git clone https://github.com/dszp/obsidian-mcp-cloudflare.git
cd obsidian-mcp
npm install
```

> **Heads-up:** project paths with **spaces or special characters** can trigger a `vitest-pool-workers` module-resolution bug for the MCP SDK. The bug doesn't affect production deploys — only the test suite. The `test/_test-worker.ts` stub works around it. If `npm test` fails with `No such module ".../ajv/dist/core"`, move the project to a path without spaces.

### 2. Authenticate wrangler

```bash
npx wrangler login
npx wrangler whoami
```

Note the account id printed by `whoami` — you'll paste it into `.env` next. (If you operate multiple Cloudflare accounts, the setup script will explicitly verify the right one is selected before doing anything destructive.)

### 3. Configure `.env`

```bash
cp .env.example .env
$EDITOR .env
```

Fill in:

- **`CLOUDFLARE_ACCOUNT_ID`** — from `npx wrangler whoami`.
- **`MCP_HOSTNAME`** — the hostname this Worker should serve from (e.g. `mcp.example.com`). Must be a DNS name on a zone in the same Cloudflare account. Wrangler provisions the DNS record and TLS cert on first deploy. If you don't have a custom domain, leave blank and edit `wrangler.example.jsonc` to remove the `routes` block (you'll get a `*.workers.dev` URL instead).
- **`R2_BUCKET_NAME`** — globally unique within your Cloudflare account; lowercase letters, digits, hyphens; 3–63 chars. The setup script will create this bucket.

The optional vars (`VAULT_PREFIX`, `DAILY_NOTE_PATH_TEMPLATE`, `PERMALINK_BASE_URL`) have sensible defaults; see comments in `.env.example`.

Leave `OAUTH_KV_ID` blank on first run — the setup script creates the KV namespace and writes the id back.

### 4. Run setup

```bash
npm run setup
```

This will:

1. Verify `npx wrangler whoami` returns the account id in your `.env` (refuses to continue otherwise — guards against the wrong-Cloudflare-account footgun).
2. Create the R2 bucket if it doesn't already exist.
3. Create the `OAUTH_KV` namespace if `OAUTH_KV_ID` isn't already in `.env`, then append the new id to `.env`.
4. Substitute placeholders in `wrangler.example.jsonc` and write `wrangler.jsonc`.

Idempotent. Safe to re-run any time `.env` changes.

### 5. Set the OAuth password

```bash
npx wrangler secret put AUTH_PASSWORD
```

When prompted, paste a long random password. This is what you'll type on the consent screen each time you (re)connect Claude.ai. Save it in a password manager.

Optionally set the upload token to enable the direct file-upload endpoint (large images / mobile photos — see README's "Uploading large images / mobile photos"):

```bash
npx wrangler secret put UPLOAD_TOKEN
```

Paste a second long random string. Leave it unset to keep the `/upload` endpoint and `create_upload_link` tool disabled.

### 6. Test and dry-run

```bash
npx wrangler types
npm test
npx wrangler deploy --dry-run --outdir=dist
```

Expect tests to pass. The dry-run should list bindings matching your `.env`:

- `MCP_OBJECT` (Durable Object)
- `OAUTH_KV` (your KV id)
- `VAULT` (your bucket name)
- `VAULT_PREFIX`, `DAILY_NOTE_PATH_TEMPLATE`, `PERMALINK_BASE_URL` (environment variables)

### 7. Deploy

```bash
npx wrangler deploy
```

Or in one shot (re-runs setup first):

```bash
npm run deploy:fresh
```

Expected output ends with:

```
Deployed obsidian-mcp triggers (X.YZ sec)
  <your hostname> (custom domain)
Current Version ID: <uuid>
```

Record the Version ID — it's how you reference this build for rollbacks.

### 8. Verify the deployment

```bash
dig <MCP_HOSTNAME> +short
```

Should return two Cloudflare anycast IPs (typically `104.21.*` and `172.67.*`). If empty, DNS is still propagating — wait up to 30 minutes, or flush local DNS (see [Troubleshooting](#troubleshooting)).

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<MCP_HOSTNAME>/
# Returns 404 — no root route, correct.
```

Open `https://<MCP_HOSTNAME>/authorize?response_type=code&client_id=test&redirect_uri=http://localhost&state=x&scope=` in a browser. You should see the password form. (It will reject `test` as an unknown client — that's fine; you just want to confirm the page renders.)

### 9. Generate an R2 API token for Remotely Save

In the Cloudflare dashboard:

1. R2 → **Manage R2 API Tokens** → **Create API token**.
2. **Permissions:** Object Read & Write.
3. **Specify bucket:** select your `R2_BUCKET_NAME` only (don't grant access to other buckets).
4. **TTL:** "Forever" is fine for personal use, or set an expiry if you prefer.
5. Click Create. **Copy the Access Key ID, Secret Access Key, and the S3 API endpoint URL.** The Secret is shown only once — save it now.

The endpoint URL looks like `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`.

### 10. Configure Remotely Save in Obsidian (per device)

Do this on every Obsidian device you want to sync.

1. **Install:** Settings → Community plugins → Browse → "Remotely Save" → Install → Enable.
2. **Configure** (Settings → Remotely Save):
   - Remote service: **S3 or compatible**
   - Endpoint: `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`
   - Region: `auto`
   - Bucket: your `R2_BUCKET_NAME`
   - Access Key ID / Secret: from step 9
   - **S3 URL style: Path-style** (R2 requires this)
   - **Remote Prefix:** must match `VAULT_PREFIX` in your `.env` (default empty)
   - **Encryption: OFF** — do not set a password here. See [Critical caveats](#critical-caveats) below.
   - Sync interval: 5 min (default)
3. Click the Remotely Save ribbon icon to do the initial upload. Watch for errors at the bottom of the screen.

Repeat on every other device using the **same Obsidian vault name** (Remotely Save uses the vault name to determine the local-to-remote mapping by default).

#### Optionally sync `.obsidian/` config across devices

Enable Remotely Save's **"Sync Configurations Folder"** option to keep bookmarks, hotkeys, and plugin enablement consistent. Then add these patterns to **"Skip paths by regex"** to avoid syncing files that should stay per-device or contain secrets:

```
^\.obsidian/workspace(-mobile)?\.json$
^\.obsidian/plugins/remotely-save/data\.json$
^\.obsidian/core-plugins-migration\.json$
```

Why each is excluded:

- `workspace.json` / `workspace-mobile.json` — per-device pane layout, will fight you across devices.
- `plugins/remotely-save/data.json` — contains your R2 access key and secret; never sync it.
- `core-plugins-migration.json` — device-local migration state.

Add any other plugin's `data.json` you don't want shared (especially plugins that store API keys).

### 11. Connect Claude.ai

1. Open Claude.ai → Settings → Connectors (or Integrations / MCP, depending on UI version) → **Add custom MCP server**.
2. URL: `https://<MCP_HOSTNAME>/mcp`.
3. Claude.ai will redirect you to `https://<MCP_HOSTNAME>/authorize`. Enter the password you set in step 5.
4. After authorization, Claude.ai is connected.

Smoke test in a new conversation: "list my notes". Claude should call `list_notes` and return the `.md` paths Remotely Save uploaded in step 10. Try reading a note. Try appending to today's daily note — after Remotely Save's next sync (≤ 5 min), the new content should appear in Obsidian on your other devices.

### Critical caveats

These will silently break the system if you ignore them.

#### End-to-end encryption in Remotely Save must be OFF

If you set a password in Remotely Save's encryption settings, every filename and body in R2 is encrypted with openssl/rclone crypt. The Worker has no key — all MCP tools will return empty results or errors. The R2 bucket is private and the MCP endpoint is OAuth-protected; you don't need plugin-level encryption on top of that.

#### `VAULT_PREFIX` must match Remotely Save's "Remote Prefix" exactly

These are independent settings that must agree. If they don't, the Worker looks at the wrong key prefix and sees no notes.

#### Concurrent-write conflict window

If the MCP server writes a note while a device has an unsynced local edit to the same file, Remotely Save resolves the conflict by timestamp — one version is lost. Mitigations:

- Keep the 5-minute sync interval on every device.
- Don't edit a file on a device that hasn't synced recently if you also expect Claude to modify it.

### Cost expectations (rough)

- R2: free up to 10 GB stored, 1M Class A ops/month, 10M Class B ops/month. A personal vault under a few thousand notes will fit comfortably in the free tier.
- Workers: free up to 100k requests/day. Even a heavily-used MCP connection won't approach this.
- KV: free up to 100k reads/day, 1k writes/day. OAuthProvider stores tokens and grant records here; for a single user, usage is negligible.
- DNS: free.

Expected monthly bill on a single-user vault: $0.

---

## Routine operations

For an already-deployed Worker, running from the project directory:

### Pre-flight checklist for any deploy

1. **Confirm Cloudflare account.**
   ```bash
   npx wrangler whoami
   ```
   Must match the account id in your `.env`. If not, `npx wrangler logout && npx wrangler login` and pick the right account.

2. **Type check.**
   ```bash
   npx tsc --noEmit
   ```

3. **Run tests.**
   ```bash
   npm test
   ```
   If any test fails, do not deploy.

4. **Dry-run the deploy.**
   ```bash
   npx wrangler deploy --dry-run --outdir=dist
   ```
   Confirm the bindings shown match expectations.

### Standard deploy

```bash
npx wrangler deploy
```

Record the Version ID printed at the end.

### Post-deploy verification

```bash
dig <MCP_HOSTNAME> +short
curl -s -o /dev/null -w "%{http_code}\n" https://<MCP_HOSTNAME>/
```

Open `https://<MCP_HOSTNAME>/authorize?response_type=code&client_id=test&redirect_uri=http://localhost&state=x&scope=` and confirm the password form renders.

Then ask Claude.ai (in any conversation): "list my notes". Verify the tool call succeeds.

### Rotating the OAuth password

```bash
npx wrangler secret put AUTH_PASSWORD
```

Effect:

- New value is live on the next request.
- Existing Claude.ai sessions continue to work because they hold a bearer token issued before the rotation.
- To force re-auth, empty the `OAUTH_KV` namespace: dashboard → Workers & Pages → KV → `OAUTH_KV` → delete keys (or delete and recreate the namespace; update `OAUTH_KV_ID` in `.env` and `npm run setup` + `wrangler deploy` if you do).

### Rollback

Cloudflare keeps version history for Workers automatically.

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

Rollback does not affect the R2 bucket or KV namespace contents (data is preserved), only the Worker code.

### Tail live logs

```bash
npx wrangler tail
```

Observability is also enabled in `wrangler.jsonc`: dashboard → Workers & Pages → `obsidian-mcp` → Logs / Metrics.

### Reconfiguring (changing bucket / hostname / KV namespace)

Edit `.env`, then:

```bash
npm run setup        # regenerates wrangler.jsonc
npx wrangler deploy
```

For bucket or KV-namespace renames you'll also need to migrate the data (see [Re-provisioning resources](#re-provisioning-resources-rare) below).

### Re-provisioning resources (rare)

#### R2 bucket

```bash
# WARNING: bucket must be empty first
npx wrangler r2 bucket delete <old-bucket-name>
npx wrangler r2 bucket create <new-bucket-name>
```

Update `R2_BUCKET_NAME` in `.env`, run `npm run setup`, and redeploy. All Remotely Save clients on every device must do a full re-sync (the new bucket is empty). Also regenerate the R2 API token used by Remotely Save and update it in each device's plugin settings.

#### KV namespace

```bash
npx wrangler kv namespace delete --namespace-id <old-id>
```

Then clear `OAUTH_KV_ID` in `.env` and rerun `npm run setup` — it will create a fresh namespace and write the new id back. Redeploy. All Claude.ai connections must re-authenticate (tokens were stored in the old KV).

### Local development

```bash
echo 'AUTH_PASSWORD=local-dev-only' > .dev.vars
npm run dev
```

Wrangler listens on `http://127.0.0.1:8787`. The dev server uses the real R2 bucket and KV namespace by default. To force local-only storage, add `--local` (note: R2 in `--local` mode is empty and ephemeral).

To exercise the MCP endpoint:

```bash
npx @modelcontextprotocol/inspector
```

Then enter `http://127.0.0.1:8787/mcp` in the Inspector UI and walk through the Quick OAuth Flow.

---

## Troubleshooting

### `Hostname '<host>' already has externally managed DNS records`

A DNS record for the hostname exists outside of the Worker custom-domain system (e.g., a manual proxied CNAME you created earlier). `custom_domain: true` cannot coexist with one.

**Fix:** Delete the existing DNS record (Cloudflare dashboard → DNS for the zone → find the row → delete) and rerun `npx wrangler deploy`. Wrangler will auto-create the record this time.

### After deleting DNS records, the hostname still doesn't resolve

Local resolvers cache the negative response. Cloudflare zone SOA negative TTL is 1800s = 30 min.

**Fix (macOS):**

```bash
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

Then `dig <hostname> +short` to verify. If still empty, your machine may use a custom DNS proxy (NextDNS, Cloudflare WARP, AdGuard, etc.) — restart that proxy too. As a last resort, temporarily point your DNS at `1.1.1.1`.

### Wrangler reports "Worker has access to" but Cloudflare API errors out

The Worker upload succeeded but a follow-up API call (DNS, route, secret) failed. Re-run `npx wrangler deploy` — the upload step is idempotent and the API call will retry.

### Tests pass locally but the deployed Worker errors

Likely a runtime-only issue invisible to local tests because of the `test/_test-worker.ts` stub. Common causes:

- A new dependency that breaks in workerd (check `npx wrangler tail` immediately after a request).
- Missing secret (e.g., added a new env var to `wrangler.jsonc` `vars` but the code expects it as a secret).

Use `npx wrangler tail` to stream live logs while reproducing the error.

### Bundle size or compatibility errors

If `wrangler deploy` complains about bundle size (the deployed bundle is ~375 KiB gzipped; the limit is 10 MB compressed for paid plans) or compatibility, check `compatibility_date` and `compatibility_flags` in `.env` / `wrangler.example.jsonc`. Bumping the date may be required for new SDK versions.

### New tool isn't showing up after deploy

See the README's gotchas under "Durable Object holds the old code" and "Claude Code caches the MCP tool list" — two independent caches that must each be cleared.
