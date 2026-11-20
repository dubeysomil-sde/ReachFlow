# ReachFlow progress

## Phase 5

- [x] Persistent sliding sessions and frontend sign-in restoration.
- [x] Recoverable Gmail connection and Waiting-only continuation.
- [x] Production mock exclusion, required configuration and go-live runbook.
- [x] Backend/frontend tests, typechecks, Angular production build and browser checks.

Implementation milestone: 54 backend tests, backend typecheck, 19 Angular
tests, frontend typecheck, production build and the production-bundle mock
exclusion scan passed. Browser checks below use intercepted local API fixtures,
not the Worker or real Google/Gmail.

### Phase 5 final verification

- Backend: 54 Node tests passed with the SQLite adapter and fake Google/fetch.
  Covered cookie flags, 30-day expiry, 15-day renewal threshold, original
  180-day cap, logout, secret rotation, tampering, deleted/disabled users,
  offline consent, missing refresh tokens, refresh/send invalid_grant recovery,
  reconnect/Waiting-only continuation and invalid-token deletion.
- Frontend: 19 Angular tests passed, including loading before who-am-I,
  HTTP-only login and Gmail connection screen, 401 handling and stopping the
  batch loop. Both TypeScript checks and Angular production build passed.
  One post-build Node scan passed: no browser mock sign-in implementation,
  demo identity or demo auth route in the production bundle.
- Browser: production static Angular files with intercepted local HTTP
  fixtures showed loading before signed-in restoration, the separate Gmail
  connection screen, connected sender address and seven-day reminder,
  Gmail-expiry message, reconnect and Continue sending, and Google-only login.
  The only browser console/network failure was the deliberately injected
  HTTP 409 used to test Gmail expiry. No actual provider or Worker was used.
- Screenshots were opened and visually checked: `phase5-connect.png` and
  `phase5-login.png` in the session `files` directory. Layout and text were
  readable without clipping. Temporary QA scripts/server were removed/stopped.
- Added `docs/go-live.md` and the root deploy script; neither deploy nor any
  Wrangler command was executed. No dependencies or cloud resources added.
  Database schema and existing API paths are unchanged.
- Still unverified: real Google OAuth/Gmail/revocation, D1 behavior, persistent
  cookies in the deployed HTTPS environment, Worker runtime/CPU and deployment.
  Existing cookies without the new issued-at/first-sign-in fields require one
  new Google sign-in after updating. Losing the encryption key requires Gmail
  reconnection; rotating SESSION_SECRET signs everyone out.

## Phase 4b

- [x] Simplify square-bracket blanks and separate subject/message handling.
- [x] Rename and arrange Sender details and Receiver details; update wording, tests and docs.
- [x] Run all tests, typechecks and Angular build; verify Gmail-address receiver flow in the browser.

Implementation and final checks: 46 backend tests, backend typecheck, 14 Angular
tests, frontend typecheck and Angular production build passed. No dependencies,
database identifiers, API routes or runtime configuration changes.

Browser test mode: entered a Gmail receiver address and typed Company manually
with Role and Job ID empty. The company sentence stayed, the optional-only lines
disappeared, the subject filled itself, and the subject review note did not block
sending. The mixed Company/Role/Job ID regression retained its sentence, removed
empty parentheses and displayed the sentence in a message review note. A
browser-only test send finished and reached History. Admin wording was checked;
Receiver details fit a 375px viewport. No console errors or failed requests.
Sender and receiver screenshots were opened and visually checked after correcting
the moved resume section's layout.

Screenshots in
`C:\Users\sodubey\.copilot\session-state\b04e60db-c1fd-4d7c-999a-a718b2705a31\files\`:
`phase4b-sender.png`, `phase4b-receiver.png`.

Still unverified: D1 runtime, Worker runtime/CPU and deployed assets, real
Google OAuth/Gmail and token revocation. No Wrangler/workerd commands or cloud
resources were used. The temporary browser and QA dev server were stopped.

## Phase 4

- [x] Milestone 1: optional blanks, safe deletion and permanent daily counts; 44 backend tests, backend typecheck, 7 frontend tests and Angular build passed.
- [x] Milestone 2: per-receiver subjects and optional fields, plain words, delete controls and test API parity; 44 backend tests, backend typecheck, 11 frontend tests and Angular build passed.
- [x] Milestone 3: docs, browser cold/referral/edit/delete walk and screenshots; final checks passed.

### Phase 4 final checks

- Backend: 45 Node tests passed using in-memory `node:sqlite` and fake Google. Backend TypeScript check passed.
- Frontend: 13 Angular tests passed. Frontend TypeScript check and Angular production build passed.
- Migration 0002 applied after 0001 in SQLite; backfill, uniqueness and user-delete cascade passed. SQL files contain no transaction-control or PRAGMA statements.
- Browser test mode: a cold email with no Role/Job ID, a referral with both, an edited subject, a prior-email note, and single History deletion passed. No console errors or failed requests. Mobile History fit a 375px viewport without horizontal scrolling. Screenshots were opened and visually checked.
- Screenshots are session artifacts in `C:\Users\sodubey\.copilot\session-state\b04e60db-c1fd-4d7c-999a-a718b2705a31\files\`: `phase4-cold.png`, `phase4-referral.png`, `phase4-history.png`, `phase4-mobile.png`.
- No dependencies added. No Wrangler/workerd commands, cloud resources, real Google calls or real email sends.
- Remaining unverified: D1 migration/runtime behavior, Worker runtime and CPU usage, deployed routing, real OAuth/Gmail and token revocation.
- Operational detail: a Gmail revocation failure leaves account data intact and the account disabled; an admin must finish removal. Successful removal revokes the token, removes owned data, and clears the session.

- [x] Milestone 1 — Shared modules live once in `shared/core`; backend tests/typecheck and frontend tests/build passed. Frontend Vitest uses a single thread to avoid Windows process-worker timeouts.
- [x] Milestone 2 — Added Database and GoogleClient interfaces, D1 and Node SQLite adapters, config, auth/session/CSRF/invites/admin, saved-message and send APIs. Backend API tests use SQLite and fake Google. Backend tests/typecheck passed.
- [x] Milestone 3 — Added `MOCK`/HTTP frontend APIs and login, invite, sender/receiver details, review, History and admin screens. Frontend tests/build passed.
- [x] Milestone 4 — Updated setup/OAuth/runtime/deployment/architecture docs and `.dev.vars.example`; final checks and browser mock-flow verification passed.

## Constraints to keep

- Never invoke Wrangler or workerd in this environment; the local executable is blocked with `spawn EPERM`.
- Never claim real D1, Worker runtime, Google, or Gmail testing.
- Do not create cloud resources or change npm/Windows security configuration.
- Sending uses client-driven batches of at most 8 receivers and never stores uploaded resume files.

## Phase 3 verification record

- Backend: 37 Node tests passed with `node:sqlite` and fake Google; TypeScript typecheck passed.
- Frontend: 7 Vitest tests passed; Angular production build passed.
- Browser: Angular dev server returned HTTP 200; test sign-in, saved message, personal preview, test send, History, admin settings and invite creation were walked. No browser console errors or failed requests. Mobile viewport (375px) had no horizontal overflow.
- Production build: Angular build passed and the generated bundle selects `HttpApi`; `ng serve` remains on browser-only `MockApi`.
- Screenshot: session artifact `C:\Users\sodubey\.copilot\session-state\b04e60db-c1fd-4d7c-999a-a718b2705a31\files\reachflow-mock.png`.
- Still unverified: Wrangler/workerd runtime, Cloudflare D1 behavior, Worker CPU use, real Google OAuth, real Gmail sending, and deployed static assets.
