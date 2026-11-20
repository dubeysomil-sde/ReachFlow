# Runtime verification (do not run on the currently blocked machine)

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
npx wrangler d1 migrations apply reachflow --local
npx wrangler d1 migrations list reachflow --local
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
runtime to profile worst-case mock and MIME workloads, including an 8-recipient
batch with the maximum 1.5 MiB PDF; confirm no per-recipient work grows
unboundedly. Before production sending, deploy only to an explicitly approved
test environment, run a controlled test, and inspect Cloudflare Worker
invocation CPU-time metrics/logs for the send-batch route. Verify a margin
below 10 ms under the largest supported payload and recipient batch. If metrics
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
   recipient whose address is the sender's own address. Do not use a bulk
   list.
4. Inspect the resolved sender, recipient, subject, body, and attachment in
   the review screen. Confirm the test send once.
5. Verify the resulting Gmail message and the corresponding recipient state
   (`SENT`, with a provider message ID) in campaign history and D1. Never
   manually reset or automatically retry `UNKNOWN`.
6. Revert to `EMAIL_MODE=MOCK` when the controlled test is complete and
   inspect logs for leaked credentials, tokens, or message content.

Real D1, Worker runtime/CPU, Google OAuth, and Gmail behavior remain unverified
until these steps are performed in an authorized environment.
