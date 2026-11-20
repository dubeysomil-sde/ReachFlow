# Google OAuth and Gmail API setup (manual)

This is a future setup guide. No Google Cloud project, OAuth client, consent
screen, test user, or Gmail API configuration has been created. Google console
labels may change; verify them before setup.

## Create an OAuth client for sign-in

1. In Google Cloud Console, create or select a project dedicated to ReachFlow.
2. Open **APIs & Services → OAuth consent screen** (or the current Google
   Auth Platform equivalent). Configure the app name, support email, audience,
   developer contact, and privacy-policy/homepage links required for the
   chosen audience.
3. Keep the consent screen in **Testing** while developing. Add only approved
   Google accounts as test users. Testing mode limits access to those users.
4. Create an OAuth 2.0 **Web application** client. Add the exact origins and
   redirect URLs for each environment. For local Worker development the
   configured URLs are:

   ```text
   Authorized JavaScript origin: http://localhost:4200
   Authorized redirect URI:     http://localhost:4200/api/auth/google/callback
   Authorized redirect URI:     http://localhost:4200/api/auth/gmail/callback
   ```

   These local URLs assume the Worker is exposed at the application origin.
   If the development proxy uses a different origin, use that exact public
   origin consistently in `APP_BASE_URL`, Google Console and the browser.
   Production must use HTTPS and its own exact callback URIs.
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `APP_BASE_URL` only in
   ignored local `.dev.vars` or the appropriate Cloudflare environment.
   Never paste credentials into source, committed docs, screenshots, or logs.

Sign-in requests only `openid`, `email`, and `profile`, with authorization
code flow, state, and PKCE. The email must be Google-verified. Existing active
users can sign in; new users are subject to `registration_mode` and an
email-bound invite unless registration is `PUBLIC`. A verified email
listed in `ADMIN_EMAILS` is bootstrapped as `ADMIN` only on first registration
and may register while Invite only is enabled without an invite. No other new
account bypasses the invite rule, and existing users are never auto-promoted.

## Enable Gmail sending separately

1. In the same Cloud project, enable **Gmail API**.
2. The separate Connect Gmail flow requests
   `https://www.googleapis.com/auth/gmail.send`, uses offline access and
   consent, and stores the refresh token only after AES-256-GCM encryption.
   The token encryption key must be configured before this flow can succeed.
   If Google supplies no refresh token, connection fails with a visible error;
   it is not shown as a new connected sender.
3. Keep `EMAIL_MODE=MOCK` until a controlled verification is approved. The
   browser mock never invokes Google and does not send email.
4. If testing actual Gmail calls, use only explicitly approved test accounts
   and send a single message to the account owner. Confirm the sender identity,
   exact receiver's address, subject, message, and attachment before approving the send.

## Testing-mode token expiry and public verification

For an OAuth consent configuration with **External** audience in **Testing**,
Google may expire refresh tokens after **7 days** when non-basic scopes are
requested. The Gmail send scope is non-basic, so test refresh tokens may stop
working after that period and require the sender to reconnect. This is a Google
testing-mode restriction, not a ReachFlow retry condition; failed authorization
must be surfaced and should not trigger automatic resending of an uncertain
message.

On `invalid_grant`, ReachFlow marks Gmail access revoked but keeps the app
session. Unsent emails remain Waiting. Reconnect Gmail, then use **Continue
sending** in History; Sent and uncertain results are not retried. After a
redirect/reload, reselect the PDF if the original send had one. Account removal
accepts Google's already-invalid token response as completed revocation;
network/server revocation failures still block removal.

Before any public release, verify Google's current verification requirements
for the selected audience and requested Gmail scope. Expect to provide a
verified domain, public homepage and privacy policy, scope justification,
consent-screen branding, and any required security assessment or verification
evidence. Do not assume Testing mode or an unverified app is appropriate for
general users. Follow Google's current policies and approval process.

No Google or Gmail interaction has been verified as part of this repository's
local tests.
