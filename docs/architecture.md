# ReachFlow architecture

ReachFlow is a single-origin application: the Cloudflare Worker routes `/api/*`
to the API and serves the Angular build through its static-assets binding for
other paths. `backend/wrangler.jsonc` configures `run_worker_first` for `/api/*`
and SPA fallback for assets. This configuration was reviewed statically; no
Worker or assets runtime was started here.

## Database schema

| Table | Purpose and constraints |
|---|---|
| `users` | Google identity; unique Google ID and email; `USER`/`ADMIN` role and `ACTIVE`/`DISABLED` status checks. |
| `connected_email_accounts` | Gmail metadata and encrypted refresh-token fields; unique per user/email; `GMAIL` provider and connection-status checks. |
| `email_templates` | User-owned templates, unique by `(user_id, template_name)`. |
| `campaigns` | User-owned campaign and aggregate counters; optional template becomes `NULL` when deleted; status check. |
| `campaign_recipients` | Individual message data and send state, unique by `(campaign_id, recipient_email)`; supports idempotent recipient-level transitions. |
| `invitations` | Email-bound, expiring, single-use invitations; only the unique token hash is stored. |
| `app_settings` | Key/value settings; migration seeds `registration_mode=INVITE_ONLY`. |

Foreign-key delete behavior is explicit: user-owned email accounts, templates,
and campaigns cascade on user deletion; campaign recipients cascade with their
campaign; campaign template references become `NULL` when a template is
deleted; an invitation's inviter reference restricts user deletion. Foreign
keys are enabled by the Node SQLite test adapter.

Timestamps are UTC ISO-8601 text. Indexes cover campaign lookup by user and
creation time, recipient status by campaign, templates by user, and
invitations by email. There is no resume-file storage table, raw invitation
token column, or plaintext Gmail credential column.

The migration is exercised against Node 24's built-in `node:sqlite` in-memory
database, including uniqueness, checks, foreign-key behavior, and user
scoping. That verifies SQLite SQL behavior, not Cloudflare D1.

## Backend boundaries

- `Database` is the small `prepare/bind/first/all/run/batch` subset used by the
  application. `D1DatabaseAdapter` wraps D1; tests use a `node:sqlite`
  adapter with the same migrations. Application SQL uses bound parameters.
- `GoogleClient` separates authorization URL, code exchange, refresh, user
  info, Gmail send, and revoke. The Worker uses a fetch implementation; tests
  use a fake. No test contacts Google.
- `shared/core/` is the single source for recipient parsing, template
  rendering, MIME construction, AES-GCM encryption, and invitation hashing.
  Both backend and Angular import these modules; there are no duplicate copies.
- `EMAIL_MODE` is `MOCK` unless explicitly set to `GMAIL`. The Angular
  development environment defaults to its browser-only `MockApi`; the Angular
  production build replaces it with `HttpApi` for same-origin `/api` calls.
- Sessions are HMAC-signed, HttpOnly, Secure, SameSite=Lax cookies. Mutating
  API requests require both the matching CSRF cookie/header and an exact
  same-origin `Origin`; active-user status is queried on authenticated
  requests.
- Resume data is sent from the browser as base64 per batch, checked for PDF
  MIME type, `%PDF-` magic bytes and a 1.5 MiB decoded limit, then passed to
  the MIME builder. It is not persisted.

## Free-plan request budget

Sending is client-driven and the server clamps each call to **8 recipients**.
The cap is intentionally below Cloudflare's free-plan limits of 50 D1 queries
and 50 external subrequests per invocation.

| Path through one send-batch call | D1 statements/queries | External requests |
|---|---:|---:|
| Mark stale `PROCESSING` recipients `UNKNOWN` | 1 | 0 |
| Check daily reservations and atomically claim recipients | 2 | 0 |
| Fetch connected account in `GMAIL` mode | 1 | 0 |
| Optional rotated refresh-token persistence | 0 or 1 | 0 |
| Per claimed recipient: Gmail send + individual status update | 8 D1 updates | up to 8 Gmail sends |
| Recompute campaign counters/status and count remaining | 2 | 0 |
| Refresh Google access token once in `GMAIL` mode | 0 | 1 |
| **Maximum successful batch** | **14** (or **15** with token rotation) | **9** |

The actual D1 count is 13 in `MOCK` mode and 14/15 in `GMAIL` mode without/with
refresh-token rotation. The table counts the daily reservation query and claim
separately; the claim statement repeats the reservation count inside its
atomic SQL. There are at most 8 individual delivery calls, one refresh call
per batch, and no other external request in the send path. Error paths that
fail to find/refresh the sender mark at most 8 rows and recompute campaign
state, remaining below both limits.

Campaign creation is capped at 49 recipients because its atomic D1 batch has
one campaign insert plus one row insert per recipient (50 statements total).
Admin screens use separate requests rather than fan-out inside a Worker
invocation. Quota reservation is repeated atomically during claiming so
concurrent batches cannot claim beyond the configured per-user daily limit.

## Delivery state

Rows move from `PENDING` to `PROCESSING` before a provider call, then to
`SENT` or `FAILED` after its outcome. Only `FAILED` rows are retryable.
`PROCESSING` rows older than five minutes become `UNKNOWN`, never automatically
resent, because a provider may have accepted a message before a timeout.
`SENT` rows are never reset by retry. Campaign aggregate counts are refreshed
from recipient rows.

The 10 ms Worker CPU budget has not been measured. MIME encoding cost for a
1.5 MiB PDF and a full 8-recipient batch must be checked on a working Worker
runtime before enabling real sending.

See [deployment.md](deployment.md), [google-oauth-setup.md](google-oauth-setup.md),
and [runtime-verification.md](runtime-verification.md) for later manual steps.
