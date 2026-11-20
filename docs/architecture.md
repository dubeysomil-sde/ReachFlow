# ReachFlow architecture

The Cloudflare Worker serves `/api/*` and the Angular static build from one
origin. The asset configuration runs the Worker first for API paths and uses
SPA fallback for other paths. This has been checked statically, not on workerd.

## Data

The database identifiers and API routes are unchanged. The screens call a
group of emails a **Send**, settings **Sender details**, email addresses and
individual messages **Receiver details**, and past sends **History**.
Technical identifiers below are storage names, not screen labels.

| Table | Purpose |
|---|---|
| `users` | Unique Google identity and email; checked roles and active/disabled status. |
| `connected_email_accounts` | Sender details and AES-GCM encrypted refresh tokens; unique per user/email. |
| `email_templates` | Saved messages, unique by `(user_id, template_name)`. |
| `campaigns` | Sends, owner, counters and optional saved-message reference. |
| `campaign_recipients` | Receivers, final subjects/messages, and individual email results; unique by `(campaign_id, recipient_email)`. |
| `invitations` | Email-bound, expiring, single-use invites. Only the token hash is stored. |
| `app_settings` | Settings; starts with `registration_mode=INVITE_ONLY`. |
| `daily_send_counts` | Successful sends per user and UTC date; unique `(user_id, day)`. |

Migration 0001 creates the original seven tables. Migration 0002 adds daily
counts and backfills them from existing successful email rows. Neither
migration contains transaction-control or PRAGMA statements.

Deletion uses explicit foreign keys. Removing a user cascades to their saved
messages, sends, receivers, connected accounts and daily counts. Invite references
to the issuing user are `RESTRICT`, so account removal explicitly deletes
their issued invites in the same database batch as the user. Removing a saved
message sets its reference in History to `NULL`. Removing a send cascades to
its receivers, but never to daily counts.

All event timestamps use UTC ISO text. `daily_send_counts.day` uses
`YYYY-MM-DD`. Indexes cover sends by owner/date, receivers by send/status, saved
messages by owner, and invites by email.

## Message rules

`shared/core/templateRenderer.ts` is used by both Angular and the server.
Only `[Name]`, `[Company]`, `[Role]` and `[JobId]` are special.
Name and Company stay unresolved when missing; each receiver needs both values.
In message mode, a line with a missing Role or JobId is removed only if it has
no Name or Company blank. Otherwise the line stays, empty optional blanks and
parentheses are removed, spacing is tidied, and the renderer returns the sentence
for a nonblocking **Please check the message** note. Extra empty lines collapse.
Subject mode never removes the subject. It tidies empty optional blanks and
returns a nonblocking **Please check the subject** note.

Each receiver's Role and Job ID start with the Receiver details shared values. Subjects are
always visible. Unedited subjects follow the current saved-message text and
receiver details; edited subjects remain unchanged until reset with confirmation.
An automatically filled, unedited message also follows the current details. Manual message
edits remain until replacement is confirmed.

The server validates final subject/message text again and rejects unfinished
blanks, empty subjects, and CR/LF in subjects. Other text is literal. Receivers
with missing details are excluded from review and sending, with an explicit note.
Existing `use_custom_subject`, `custom_subject`
and `final_subject` columns are reused.

## Backend boundaries and safety

- `Database` covers `prepare/bind/first/all/run/batch`. D1 has a real adapter;
  Node tests use an in-memory SQLite adapter with the same migrations and
  foreign keys enabled. All data values are bound parameters.
- `GoogleClient` separates Google/Gmail calls from request logic. Tests use
  fake Google responses, never real provider calls.
- The single `shared/core/` copy contains parsing, rendering, MIME and crypto.
- Angular development defaults to `MockApi` and shows **TEST MODE - no real
  emails are sent**. Production replaces the API factory with an HTTP-only
  factory; the browser mock implementation is excluded from the compiled bundle.
  The banner also reflects the server email mode reported by who-am-I.
  Only explicit local development permits a default MOCK mode. Production
  requires EMAIL_MODE, HTTPS APP_BASE_URL and all four Google/session/encryption
  values, otherwise returning a clear configuration error.
- HMAC-signed sessions are HttpOnly, Secure and SameSite=Lax. Active-user
  status is checked on every authenticated request, once per API invocation.
  Signed payloads include issued-at, expiry and first-sign-in time. Persistent
  cookies last 30 days, renew below 15 days remaining, and never go beyond
  180 days from first sign-in. Logout clears them; SESSION_SECRET rotation
  signs everyone out. Auth is not kept in localStorage (test sign-in is
  memory-only). Changes require a matching CSRF cookie/header and exact
  same-origin Origin.
- PDF files stay in browser memory. Each batch validates the file's type,
  `%PDF-` magic and 1.5 MiB decoded limit. No file is stored.
- Account removal first blocks new send claims, revokes connected tokens,
  then deletes data. Already-invalid tokens count as revoked. Network/server
  revocation failures leave the account disabled and data available for an
  admin to finish removal; the error explains this.
- Gmail invalid_grant (or a send authorization rejection) marks the connection
  REVOKED, releases this batch's unsent PROCESSING rows back to PENDING, and
  stops the client loop without ending the sign-in session. Reconnect then
  Continue sending uses the same atomic PENDING-only claim. Token-refresh
  transport failures also release unsent claims without counting them as sent.
  Successfully persisted SENT rows and uncertain UNKNOWN rows are never released.
  A PDF must be selected again after a reload; it is not persisted.

## Daily limit and send budget

Successful-email status and the daily counter increment are committed in one
atomic database batch. The conditional increment only counts a row still in
`PROCESSING`. A failed database write rolls back both; an uncertain result is
not made retryable. Completed History is never used as the quota ledger.
Current `PROCESSING` and uncertain `UNKNOWN` rows also reserve capacity
conservatively. An atomic claim repeats the daily-ledger and reservation check
so parallel requests cannot over-claim. It trims a batch to the available
capacity and never claims `SENT` or `UNKNOWN`.

The hard cap is **8 receivers per send-batch call**. Estimated maximum statements
for one successful 8-receiver request:

| Work | D1 statements | External calls |
|---|---:|---:|
| Session user and owned send lookup | 2 | 0 |
| Mark stale sending rows, read daily availability, atomic claim | 3 | 0 |
| Load sender and optionally save a rotated refresh token | 1 or 2 | 0 |
| Refresh access token once | 0 | 1 |
| Send each email, increment daily ledger and record result | 16 | 8 |
| Recompute totals and count waiting emails | 2 | 0 |
| **Total, including token rotation** | **25** | **9** |

Test-mode server sending omits the sender/token work: 23 statements, no
external calls. These counts are below 50 D1 queries and 50 external
subrequests, but do not prove CPU compliance. Creation is limited to 45 receivers
(46 batch inserts plus session/optional saved-message lookup stays below 50).
Selected History deletion handles up to 45 IDs per request to stay within
D1's bound-parameter budget; Delete all uses owner-scoped SQL instead.

Only failed emails can be tried again. Sending rows older than five minutes
become `UNKNOWN` on the next batch attempt and are never automatically resent.
History deletion is blocked with HTTP 409, **Stop it first**, while a send is
active. Single, selected and all deletions are owner-scoped; selected/all
deletions refuse the operation if any selected send is active.

The 10 ms Worker CPU budget, D1 adapter behavior and real Google/Gmail calls
remain unverified. In particular, profile an 8-receiver batch with a maximum
PDF before enabling real sending.

See [deployment.md](deployment.md), [google-oauth-setup.md](google-oauth-setup.md)
and [runtime-verification.md](runtime-verification.md).
