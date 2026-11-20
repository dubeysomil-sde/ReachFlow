# Runtime verification (do not run on the currently blocked machine)

For the ordered remote go-live preparation, use [go-live.md](go-live.md).
These remain future checks, not results from this machine.

## Phase 5 session and Gmail recovery checks

- Inspect the live session cookie: HttpOnly, Secure, SameSite=Lax, Path=/ and
  Max-Age=2592000 at sign-in. Close/reopen the browser and confirm the app restores
  the signed-in workspace without showing the login screen first.
- On a controlled test deployment with a test clock or controlled signed test
  sessions, check renewal below 15 days remaining, no renewal at exactly 15,
  expiry at 30 days without use, and the 180-day first-sign-in cap. Do not edit
  production cookie payloads or weaken production validation to speed this up.
  The local Node tests cover these clock boundaries but not browser/D1 behavior.
- Logout must clear the cookie. Disable/delete the user and confirm the next
  request is blocked. Rotate SESSION_SECRET in a disposable deployment and
  confirm old sessions fail. Keep the token-encryption key unchanged.
- Confirm production bundles contain no browser mock implementation with
  `node --test frontend\test\production.test.mjs` after the production build.
  The live login offers only **Sign in with Google**.
- First sign-in should show **Connect your Gmail to send emails**. Confirm
  offline consent, refresh-token storage and the connected address in Sender
  details. Missing refresh tokens must show an error.
- On a disposable test account, revoke Gmail access. Start/continue a send and
  confirm the connection becomes REVOKED, login remains active, unsent rows stay
  Waiting, and the exact reconnection message appears. Reconnect and use
  **Continue sending** in History; Sent and uncertain rows must never be resent.
  Reattach the original PDF after a redirect/reload if the send needs it.
- Test account/admin deletion with an already-invalid token (succeeds), then
  with simulated Google network/server failure (data remains, account disabled).
- Remove each required production secret in a disposable deployment and confirm
  a clear HTTP 503 naming only the missing setting, never its value. Restore
  configuration before checking Google or sending any email.

This runbook is for a Windows or Linux development environment where Wrangler's
local `workerd` runtime is allowed. The current machine's `workerd.exe` fails
with `spawn EPERM`. Do not reinstall Wrangler, change endpoint-security
settings, or run these commands here. None of the commands below has been run
as part of this work.

## Install and apply local migrations

From the repository root:

```powershell
npm --prefix backend ci
npm --prefix frontend ci
```

In a PowerShell terminal, change into `backend` and apply the checked-in
migrations to Wrangler's local D1 emulator:

```powershell
Set-Location backend
npx wrangler d1 migrations apply reachflow-local --local
npx wrangler d1 migrations list reachflow-local --local
```

Review the selected local database name and migration list. Do not add
`--remote` for this local check.

## Start the single Worker and check the API/assets

Build Angular first; the Worker serves the resulting static directory:

```powershell
Set-Location ..
npm --prefix frontend run build
Set-Location backend
npx wrangler dev --ip 127.0.0.1 --port 8787
```

In another PowerShell terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
Invoke-WebRequest http://127.0.0.1:8787/ -UseBasicParsing
```

The health JSON must be `status=UP` and `application=ReachFlow`; the root
response must contain the Angular app shell. Then exercise same-origin sign-in
and mock sending only if the Worker config and local test credentials are
intentionally set up. Do not treat HTTP 200 on health as evidence of D1
functionality.

## Check CPU and D1 usage before enabling real sends

The free-plan CPU limit is 10 ms per invocation. A local wall-clock duration
is not Cloudflare CPU time and cannot prove that limit. First use the local
runtime to profile worst-case test-mode and MIME workloads, including an 8-receiver
batch with the maximum 1.5 MiB PDF; confirm no per-receiver work grows
unboundedly. Before production sending, deploy only to an explicitly approved
test environment, run a controlled test, and inspect Cloudflare Worker
invocation CPU-time metrics/logs for the send-batch route. Verify a margin
below 10 ms under the largest supported payload and group size. If metrics
do not expose the required detail, use Cloudflare's documented tracing or
observability tooling; do not infer CPU time from client latency.

Likewise, confirm actual D1 query/statement and external subrequest usage
against Cloudflare's current limits. `docs/architecture.md` documents the
expected query and request counts, but those counts have only been reviewed
statically and against the SQLite-backed tests.

## One controlled Gmail send (only after separate approval)

1. Complete [google-oauth-setup.md](google-oauth-setup.md), use a verified
   test sender, and configure the exact callback URLs and Worker secrets.
2. Keep the environment restricted to approved test users and set
   `DAILY_SEND_LIMIT=1`.
3. Configure `EMAIL_MODE=GMAIL`, connect the sender, and prepare one
   receiver whose address is the sender's own address. Do not use a bulk
   list.
4. Inspect the resolved sender, receiver's address, subject, message, and attachment in
   the review screen. Confirm the test send once.
5. Verify the resulting Gmail message and the corresponding receiver's state
   (`SENT`, with a provider message ID) in History and D1. Never
   manually reset or automatically retry `UNKNOWN`.
6. Revert to `EMAIL_MODE=MOCK` when the controlled test is complete and
   inspect logs for leaked credentials, tokens, or message content.

Real D1, Worker runtime/CPU, Google OAuth, and Gmail behavior remain unverified
until these steps are performed in an authorized environment.

## Phase 4 checks on a working runtime

Before starting the updated API, confirm both numbered migrations appear in
the migration list. Migration `0002_daily_send_counts.sql` must run after 0001.
On an existing D1 test database, verify its totals match prior successful
emails by UTC day. Confirm no migration uses transaction-control or PRAGMA
statements. Node SQLite checks do not prove D1 migration compatibility.

Use the signed-in browser with its session, Origin and CSRF header; do not
copy cookies or tokens into terminal history or logs. Keep server
`EMAIL_MODE=MOCK` for these deletion checks:

1. Write a cold email with Role and Job ID empty, then a referral with both
   filled. On Sender details, load the sample. On Receiver details, enter a Gmail
   address, fill Company manually, and leave Role and Job ID empty.
   The company sentence must stay, optional-only lines must disappear, and the
   subject must fill itself with a nonblocking review note. Check all four
   combinations of optional values and mixed required/optional sentences.
   Edit a subject, change the defaults in Sender details, verify the edit stays,
   and confirm reset. Clearing a subject or Name/Company blocks only that receiver.
2. With two separate test users, check the routes below. Cross-user History
   or message deletion must fail. Stop active sends before deletion.
3. Verify `DELETE /api/campaigns/:id`, `DELETE /api/campaigns` with JSON
   `{ "ids": ["..."] }`, and the same route with `{ "all": true }`.
   A selected active send must give HTTP 409 with `Stop it first`; selected
   deletion must not partially remove the other items.
4. Delete a saved message through `DELETE /api/templates/:id`. Its History
   and final email text must remain readable.
5. Set a small `DAILY_SEND_LIMIT` (for example 2), send one test-mode email,
   delete its History, then ask for a batch of 8. Only one more may be
   processed. Delete History again and verify the next attempt gives 429.
   Read the two-count ledger row directly in the D1 dashboard. Verify a new
   UTC day has its own total, and parallel calls do not exceed the limit.
6. Confirm the already-emailed note appears from History and disappears
   after that History item is removed.
7. Test `DELETE /api/auth/account` with `{ "confirmation": "DELETE" }` on a
   disposable user. Wrong confirmation must fail. Active sends must block it.
   For an explicitly approved Google test account only, confirm the token is
   revoked, session cookie cleared, and data removed from all owned tables,
   including daily counts and invites issued by that user. A token-revocation
   failure must be visible and must not silently delete the account.
8. As an admin, check `DELETE /api/admin/invitations/:id` and
   `DELETE /api/admin/users/:id`. Removing another user must delete all their
   data and disconnect Gmail; removing the signed-in admin through this route
   must be refused.

For the local single-Worker browser flow, set `APP_BASE_URL` and Google callback
URLs to the exact browser origin (`http://localhost:8787` when opening the
local Worker directly). Use a production Angular build for `HttpApi`; the
normal Angular dev server stays on browser-only test mode. This setup, D1,
CPU measurements and real Google/Gmail remain unverified here.
