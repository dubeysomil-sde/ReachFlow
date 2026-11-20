# ReachFlow

ReachFlow is a multi-user personalized bulk-email application. The repository
contains an Angular 22 frontend, a Cloudflare Worker API, D1 migrations, and
shared TypeScript core modules. The frontend defaults to **MOCK mode** so the
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
“MOCK MODE — no real emails are sent.” No backend, account, or credentials are
needed. Use `npm --prefix frontend start -- --port 4201` if port 4200 is busy.
The Angular production build replaces this development setting with `HTTP`,
so the deployed single-origin app calls its `/api/*` Worker endpoints.

## Run the Worker (when workerd is available)

Copy `backend/.dev.vars.example` to `backend/.dev.vars` (for example,
`Copy-Item backend/.dev.vars.example backend/.dev.vars`), replace the local
placeholder secrets, and leave `EMAIL_MODE=MOCK`. From the repository root:

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

## Layout

```text
ReachFlow/
├── backend/       Worker API, D1 migrations, Node tests and local vars example
├── docs/          Architecture, progress, OAuth and verification guides
├── frontend/      Angular application and mock/HTTP API implementations
└── shared/core/   Shared recipient, template, MIME and crypto modules
```
