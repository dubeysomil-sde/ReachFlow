# ReachFlow

ReachFlow is a multi-user bulk-email application with a message for each receiver. The repository
contains an Angular 22 frontend, a Cloudflare Worker API, D1 migrations, and
shared TypeScript core modules. The frontend defaults to **test mode** so the
complete client workflow can be exercised without Google, Gmail, Cloudflare,
or a running Worker.

## Requirements

- Node.js 24.15+ (Node 24 LTS line) and npm 11
- Dependencies installed from the committed lockfiles

Wrangler is a project-local backend dependency. Do not install it globally.
The local `workerd.exe` runtime is blocked on this Windows machine (`spawn
EPERM`); do not reinstall Wrangler or change Windows/npm security settings.

## Install

Run from the repository root:

```powershell
npm --prefix frontend ci
npm --prefix backend ci
```

For frontend-only development, install just `frontend/`.

## Run the frontend

```powershell
npm --prefix frontend start
```

Open `http://localhost:4200`. The default `MOCK` API keeps demo data in browser
local storage, simulates batches of five with occasional failures, and displays
“TEST MODE - no real emails are sent.” No backend, account, or credentials are
needed. Use `npm --prefix frontend start -- --port 4201` if port 4200 is busy.
The Angular production build replaces this development setting with `HTTP`,
so the deployed single-origin app calls its `/api/*` Worker endpoints.

## Run the Worker (when workerd is available)

Copy `backend/.dev.vars.example` to `backend/.dev.vars` (for example,
`Copy-Item backend\.dev.vars.example backend\.dev.vars`), replace the local
example secrets, and leave `EMAIL_MODE=MOCK`. From the repository root:

```powershell
npm --prefix backend run dev
```

The Worker is configured for `http://127.0.0.1:8787`. The Angular development
server proxies `/api` there, but **the Worker and proxy cannot currently be
tested on this machine** because `workerd.exe` fails with `spawn EPERM`. Do not
run Wrangler here. The Angular app remains usable in its default mock mode.

The deployed architecture is a single Worker serving the Angular static build
and `/api/*`; Wrangler assets are configured to run API routes first and use
SPA fallback for other paths. See [docs/deployment.md](docs/deployment.md).

## Checks

These commands do not start Wrangler or contact external services:

```powershell
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix frontend test -- --watch=false
npm --prefix frontend run build
```

Backend tests apply the repository migrations to Node 24's built-in in-memory
`node:sqlite` adapter and use a fake Google client. This is not a D1, Cloudflare
Worker, Google OAuth, or Gmail runtime test. Follow
[docs/runtime-verification.md](docs/runtime-verification.md) later, from an
environment where workerd is allowed.

## Configuration and security

Local Worker variables are documented in `backend/.dev.vars.example`; copy it
to the gitignored `backend/.dev.vars`. Never commit `.dev.vars` or real
credentials. Email mode defaults to `MOCK`; real Gmail sending requires
explicit `EMAIL_MODE=GMAIL`, configured Google OAuth, and a separately
connected sender. No real email is sent by the default frontend.

Google Cloud setup is documented in [docs/google-oauth-setup.md](docs/google-oauth-setup.md).
No authentication or email provider has been exercised against a real account.
The ordered future deployment commands are in [docs/go-live.md](docs/go-live.md).
`npm run deploy` builds Angular and deploys with project-local Wrangler; do not
run it on this machine.

Sessions use persistent HttpOnly, Secure, SameSite=Lax cookies for 30 days.
When fewer than 15 days remain they renew, up to 180 days from first sign-in.
After that, sign in again. Changing `SESSION_SECRET` signs everyone out.
No live authentication data is stored in localStorage. Browser test sign-in is
memory-only; its sample workspace data remains in localStorage.

Sign-in and Gmail connection stay separate. First connect Gmail before sending.
If Gmail access expires, the app keeps your login, leaves unsent emails Waiting
and asks you to reconnect. Then use **Continue sending** in History. Already
Sent emails are never sent again. Google's consent-screen Testing mode may
require Gmail reconnection about every seven days.

Production requires explicit EMAIL_MODE and APP_BASE_URL, GOOGLE_CLIENT_ID,
GOOGLE_CLIENT_SECRET, SESSION_SECRET and TOKEN_ENCRYPTION_KEY. Missing or invalid
required configuration returns a clear HTTP 503, not a silent MOCK fallback.
Only local `.dev.vars` should set `ENVIRONMENT=development`.

## Layout

```text
ReachFlow/
├── backend/       Worker API, D1 migrations, Node tests and local vars example
├── docs/          Architecture, progress, OAuth and verification guides
├── frontend/      Angular application and mock/HTTP API implementations
└── shared/core/   Shared email parsing, message, MIME and crypto modules
```

## Writing and managing emails

- **Sender details** holds your sending Gmail account, default subject and
  message, saved messages, **Load sample**, and optional PDF resume.
  Use only `[Name]`, `[Company]`, `[Role]` and `[JobId]` as blanks.
- **Receiver details** holds email addresses, optional Role and Job ID values
  for all receivers, and each receiver's own name, company, subject and message.
  Name and Company need a value. A receiver with missing details is not sent an
  email; ready receivers can still be reviewed and sent.
- **Role and Job ID are optional.** In messages, a line with an empty optional
  blank disappears unless it also uses Name or Company. Mixed lines stay,
  with empty blanks and empty parentheses tidied, and show **Please check the message**
  with the affected sentence. Extra blank lines collapse.
- The subject always fills itself in. Empty optional blanks are removed without
  removing the subject; **Please check the subject** is a reminder, not a block.
  A completely empty subject blocks that receiver.
  Unedited subjects and messages follow the defaults; edits stay as written.
  **Use default subject** asks before replacing an edit. Review shows the exact email text.
- A gentle note says when you last emailed a receiver, based on History.
  Removing History also removes that note.
- Delete one item, selected items (up to 45 at once), or all of History.
  Stop active sends first. Deleting a saved message keeps its History.
  Emails already sent stay in your Gmail Sent folder.
- The account menu can delete your account and data after you type `DELETE`.
  Gmail is disconnected first. Admins can remove other users and delete invites.

Migration `0002_daily_send_counts.sql` adds permanent per-user UTC-day totals.
Deleting History does not reset the daily email limit. These totals disappear
only when their user is removed. Apply **both** migrations before running the
updated API; see the runtime guide for the later D1 checks.
