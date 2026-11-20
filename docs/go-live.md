# Go-live runbook (prepare only)

Nothing in this guide has been executed. Run it later from the repository root
in Windows PowerShell 5.1 on an approved machine. Do not run Wrangler on the
current blocked machine. Creating resources and deploying may affect billing;
check the account and free-plan limits first.

## 1. Check the code, then sign in to Cloudflare

Use the committed lockfiles and project-local Wrangler. No global installation
is needed. These are future commands, not instructions to bypass Windows rules.

```powershell
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix frontend test -- --watch=false
npm --prefix frontend run build
node --test frontend\test\production.test.mjs
npm --prefix backend exec -- wrangler login
npm --prefix backend exec -- wrangler whoami
```

Confirm the intended Cloudflare account before continuing.

## 2. Create D1, record its ID, and apply both migrations

```powershell
npm --prefix backend exec -- wrangler d1 create reachflow --config backend\wrangler.jsonc
```

Copy the returned `database_id` (not any token). In IntelliJ, edit
`backend\wrangler.jsonc`: keep binding `DB`, set `database_name` to `reachflow`,
and replace the example `database_id` with the returned ID. Do not deploy the
example ID. The following commands assume that edit is saved:

```powershell
npm --prefix backend exec -- wrangler d1 migrations apply reachflow --remote --config backend\wrangler.jsonc
npm --prefix backend exec -- wrangler d1 migrations list reachflow --remote --config backend\wrangler.jsonc
```

Confirm both `0001_initial_schema.sql` and `0002_daily_send_counts.sql` are
applied. Node SQLite tests are not proof that these D1 operations succeed.

## 3. First deploy and discover the HTTPS origin

```powershell
npm run deploy
```

This root script builds Angular in production and invokes project-local
Wrangler with the backend config. Copy the `https://reachflow-api.<your-subdomain>.workers.dev`
URL printed by deploy. It is also shown in Cloudflare Dashboard > Workers &
Pages > reachflow-api > Settings > Domains & Routes. If workers.dev is disabled,
enable it in the intended account or choose your intended HTTPS custom domain
before configuring Google.

The initial API deliberately returns HTTP 503 with the missing configuration
name until all required settings and secrets are present. This is not a
successful auth/database/email check. Do not invite users yet.

## 4. Configure Google and the exact callback URLs

Follow [google-oauth-setup.md](google-oauth-setup.md): create a Web application
OAuth client, enable Gmail API, use consent-screen Testing mode, and add your
own admin/sender Google addresses as test users. Use the chosen origin without
a trailing slash:

```powershell
$AppBaseUrl = 'https://reachflow-api.YOUR-SUBDOMAIN.workers.dev'
```

Register **both** authorized redirect URIs in the Google OAuth client:

```text
https://reachflow-api.YOUR-SUBDOMAIN.workers.dev/api/auth/google/callback
https://reachflow-api.YOUR-SUBDOMAIN.workers.dev/api/auth/gmail/callback
```

The exact paths are `/api/auth/google/callback` for sign-in and
`/api/auth/gmail/callback` for connecting Gmail. Origins, paths, HTTPS and
trailing slashes must match. Sign-in asks only for identity; Connect Gmail
separately asks for `gmail.send`, offline access and consent.

## 5. Generate and safely keep the two independent secrets

In a private PowerShell window on a trusted machine, use the cryptographic
random generator, **not Get-Random**:

```powershell
function New-ReachFlowSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes)
    } finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}
$SessionSecret = New-ReachFlowSecret
$EncryptionKey = New-ReachFlowSecret
```

`SESSION_SECRET` is a string of at least 32 characters (this produces 44).
`TOKEN_ENCRYPTION_KEY` is standard base64 encoding of exactly 32 random bytes
for AES-256-GCM (also 44 characters). They must be generated independently.
Save their values in an approved password manager using your private local
workflow; do not print them in shared terminals, logs, screenshots or recordings.
Never paste secrets into chat or commit them. Never use the example key.

Keep the encryption key somewhere safe: losing it means everyone must reconnect
Gmail, and old encrypted tokens cannot be recovered. Changing `SESSION_SECRET`
signs everyone out immediately. Rotating the encryption key is not a session
rotation and needs a deliberate token migration/reconnection plan.

## 6. Put all four secrets into the intended Worker

Each command prompts for its value. Enter it privately when prompted; do not
put secret values on command lines or in committed vars. Google supplies the
client ID and client secret; use the two generated values for the other prompts.

```powershell
npm --prefix backend exec -- wrangler secret put GOOGLE_CLIENT_ID --config backend\wrangler.jsonc
npm --prefix backend exec -- wrangler secret put GOOGLE_CLIENT_SECRET --config backend\wrangler.jsonc
npm --prefix backend exec -- wrangler secret put SESSION_SECRET --config backend\wrangler.jsonc
npm --prefix backend exec -- wrangler secret put TOKEN_ENCRYPTION_KEY --config backend\wrangler.jsonc
Remove-Variable SessionSecret, EncryptionKey
```

Do not delete the password-manager copies. Do not put
`ENVIRONMENT=development` in the deployed Worker. Missing ENVIRONMENT is treated
as production; only local `.dev.vars` should opt into development defaults.
Production requires an explicit email mode and valid HTTPS origin plus all four
secret values. It never silently defaults to MOCK.

## 7. Set non-secret vars and redeploy

In `backend\wrangler.jsonc`, add this top-level `vars` object, replacing the
origin and bootstrap email with your intended values. Keep the existing
assets and D1 binding:

```json
"vars": {
  "ENVIRONMENT": "production",
  "EMAIL_MODE": "GMAIL",
  "DAILY_SEND_LIMIT": "20",
  "APP_BASE_URL": "https://reachflow-api.YOUR-SUBDOMAIN.workers.dev",
  "ADMIN_EMAILS": "your-verified-admin-address@example.com"
}
```

These are configuration values, not secret tokens. ADMIN_EMAILS is a
comma-separated allowlist. It bootstraps **new** verified accounts only;
existing users are never silently promoted. An allowlisted new admin can
register while registration remains Invite only, so no public signup window
or manual SQL promotion is necessary.

```powershell
npm run deploy
Invoke-RestMethod "$AppBaseUrl/api/health"
```

A healthy response is only a health check, not proof of Google, Gmail or D1.
The deployment uses same-origin secure cookies; do not split the frontend and
API across origins.

## 8. First sign-in and controlled verification

1. Open the HTTPS app, choose **Sign in with Google**, and use the exact
   Google-verified address in ADMIN_EMAILS. Confirm Admin is available and
   registration is still Invite only.
2. On **Connect your Gmail to send emails**, connect the intended sender.
   The Gmail address must appear in Sender details. A missing refresh token is
   an error, never a successful connection.
3. Perform the checks in [runtime-verification.md](runtime-verification.md),
   including D1 migrations, cookie persistence/renewal, the 180-day cap,
   CPU usage, deletes/daily limit, and one real email to yourself.
4. In Google's Testing mode, Gmail refresh tokens may expire after about
   seven days. Reconnect Gmail, then use **Continue sending** in History;
   only Waiting emails are sent, never Sent or uncertain results.

Do not open registration or increase the daily limit until the live checks,
OAuth verification requirements and Worker CPU budget are resolved.
