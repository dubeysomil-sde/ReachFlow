# Manual Cloudflare deployment (future)

This is a runbook only. No Cloudflare resources have been created or changed,
and no deployment has been run. Verify current Cloudflare dashboard labels and
account limits before proceeding.

## Prepare the application

1. Review the migrations and run backend tests, backend typecheck, frontend
   tests, and Angular production build.
2. Set `APP_BASE_URL` to the final HTTPS origin. Configure Google OAuth
   redirect URLs to match `/api/auth/google/callback` and
   `/api/auth/gmail/callback` exactly.
3. Generate independent, random secrets for `SESSION_SECRET` (at least 32
   characters) and `TOKEN_ENCRYPTION_KEY` (base64 for 32 random bytes). Keep
   them in a secure password manager until entering them into Cloudflare.
4. Choose `EMAIL_MODE=MOCK` initially. Do not enable `GMAIL` until OAuth
   verification, Gmail consent, security review, quota review, and a controlled
   self-send have succeeded.

## Create and bind D1

1. In the intended Cloudflare account, create a D1 database for the intended
   environment and note its database name and ID.
2. Update the `DB` binding and `database_id` in `backend/wrangler.jsonc` to
   that database. Never deploy the all-zero placeholder ID.
3. Apply and verify migrations from a trusted deployment environment, after
   reviewing the exact account and target:

   ```powershell
   Set-Location backend
   npx wrangler d1 migrations apply reachflow --remote
   npx wrangler d1 migrations list reachflow --remote
   ```

4. Confirm the schema and registration-mode seed in the intended D1 database.
   Do not assume the Node SQLite tests are a D1 verification.

## Build and deploy the single Worker

The Worker serves the Angular static build and `/api/*` from the same origin.
The Wrangler asset directory is `../frontend/dist/frontend/browser`, with
`ASSETS` binding, `run_worker_first` for `/api/*`, and SPA fallback elsewhere.

When configuring a Cloudflare Workers Build for this repository, use the
repository root so both `shared/` and `frontend/` are available to the Worker
bundle:

- Install/build command:

  ```sh
  npm ci --prefix backend && npm ci --prefix frontend && npm --prefix frontend run build
  ```

- Deploy command:

  ```sh
  cd backend && npx wrangler deploy
  ```

Ensure the build command succeeds before the deploy command. Configure the
`DB` binding in the dashboard or Wrangler configuration and add Worker
secrets/variables in the correct environment:

| Variable | Secret? | Initial value/notes |
|---|---|---|
| `EMAIL_MODE` | No | `MOCK` |
| `APP_BASE_URL` | No | Deployed HTTPS origin |
| `DAILY_SEND_LIMIT` | No | `100` unless deliberately changed |
| `ADMIN_EMAILS` | No | Comma-separated verified bootstrap emails |
| `GOOGLE_CLIENT_ID` | Sensitive configuration | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret |
| `SESSION_SECRET` | Yes | Random secret, at least 32 characters |
| `TOKEN_ENCRYPTION_KEY` | Yes | Base64-encoded random 32-byte key |

Use the dashboard's secret facility for sensitive values. Never store real
secrets in Git, build logs, or plaintext configuration. Do not enable
`EMAIL_MODE=GMAIL` until the Google setup and real-send verification guide has
been completed.

## Verify after deployment

1. Confirm `GET https://<origin>/api/health` returns HTTP 200 and
   `{"status":"UP","application":"ReachFlow"}`.
2. Confirm a non-API path serves the Angular single-page application and that
   the API remains same-origin.
3. Complete the runtime, auth, database, and controlled-send checks in
   [runtime-verification.md](runtime-verification.md).
4. Review D1/Worker usage, CPU time, logs, quotas, OAuth consent status, and
   rollback steps before inviting users.

Health and static-asset responses alone do not prove D1 or Gmail functionality.
