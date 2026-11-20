import { decryptSecret, encryptSecret, generateInvitationToken, hashToken } from '../../../shared/core/crypto.ts';
import { buildRawMessage } from '../../../shared/core/mimeBuilder.ts';
import { parseRecipient } from '../../../shared/core/recipientParser.ts';
import { assertSendable, renderTemplate } from '../../../shared/core/templateRenderer.ts';
import type { AppConfig } from '../config.ts';
import {
  clearOAuthCookie,
  clearSessionCookies,
  createOAuthStateCookie,
  createPkceChallenge,
  createRandomToken,
  createSessionCookie,
  csrfCookie,
  csrfMatches,
  readOAuthState,
  readSession,
} from '../auth/session.ts';
import { all, first, run, type Database, type PreparedStatement } from '../db/database.ts';
import type { CampaignRecipientRow, CampaignRow, ConnectedEmailAccountRow, EmailTemplateRow, UserRow } from '../db/types.ts';
import type { GoogleClient } from '../google/googleClient.ts';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
const MAX_BODY_CHARS = 2_250_000;
const MAX_CAMPAIGN_RECIPIENTS = 49;
const MAX_SEND_BATCH = 8;
const MAX_RESUME_BYTES = 1_572_864;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_SCOPES = ['openid', 'email', 'profile'];
const GMAIL_SCOPES = [
  ...LOGIN_SCOPES,
  'https://www.googleapis.com/auth/gmail.send',
];

export interface ApiDependencies {
  db: Database;
  google: GoogleClient;
  config: AppConfig;
  now?: () => number;
}

class ApiError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
  ) {
    super(message);
    this.status = status;
  }
}

interface TemplatePayload {
  template_name: string;
  default_subject: string;
  default_body: string;
}

interface CampaignRecipientInput {
  email: string;
  recipient_name?: string;
  recipient_company?: string;
  recipient_role?: string;
  recipient_job_id?: string;
  use_custom_subject?: boolean;
  custom_subject?: string;
  final_subject?: string;
  final_body?: string;
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(JSON_HEADERS);
  if (headers) new Headers(headers).forEach((value, key) => responseHeaders.append(key, value));
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > MAX_BODY_CHARS) throw new ApiError(413, 'Request is too large');
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new ApiError(413, 'Request is too large');
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'Invalid request body');
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Invalid JSON body');
  }
}

function stringValue(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ApiError(400, `Invalid ${field}`);
  }
  return value;
}

function assertNoHeaderBreaks(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new ApiError(400, `Invalid ${field}`);
}

function getNow(dependencies: ApiDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function isoNow(dependencies: ApiDependencies): string {
  return new Date(getNow(dependencies)).toISOString();
}

function isSecure(config: AppConfig): boolean {
  return true;
}

function redirectUri(config: AppConfig, path: string): string {
  return `${config.appBaseUrl}${path}`;
}

function randomId(): string {
  return crypto.randomUUID();
}

function makeErrorRedirect(config: AppConfig, code: string): string {
  const url = new URL(config.appBaseUrl);
  url.searchParams.set('auth_error', code);
  return url.toString();
}

function ensureSameOrigin(request: Request, config: AppConfig): void {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(config.appBaseUrl).origin) {
    throw new ApiError(403, 'Request origin is not allowed');
  }
  if (!csrfMatches(request)) throw new ApiError(403, 'CSRF validation failed');
}

async function requireUser(
  request: Request,
  dependencies: ApiDependencies,
): Promise<UserRow> {
  const user = await readSession(
    request,
    dependencies.db,
    dependencies.config.sessionSecret,
    getNow(dependencies),
  );
  if (!user) throw new ApiError(401, 'Sign-in required');
  return user;
}

function requireAdmin(user: UserRow): void {
  if (user.role !== 'ADMIN') throw new ApiError(403, 'Administrator access required');
}

function parseTemplate(body: Record<string, unknown>): TemplatePayload {
  return {
    template_name: stringValue(body.template_name, 'template name', 120).trim(),
    default_subject: stringValue(body.default_subject, 'subject', 998),
    default_body: stringValue(body.default_body, 'body', 100_000),
  };
}

function validateRecipientInput(
  input: CampaignRecipientInput,
  defaultSubject: string,
  defaultBody: string,
): Omit<CampaignRecipientRow, 'id' | 'campaign_id' | 'sending_status' | 'attempt_count' | 'gmail_message_id' | 'error_message' | 'sent_at' | 'created_at' | 'updated_at'> {
  if (!input || typeof input !== 'object') throw new ApiError(400, 'Invalid recipient');
  let parsed: ReturnType<typeof parseRecipient>;
  try {
    parsed = parseRecipient(stringValue(input.email, 'recipient email', 254));
  } catch {
    throw new ApiError(400, 'Invalid recipient email');
  }
  if (input.use_custom_subject !== undefined && typeof input.use_custom_subject !== 'boolean') {
    throw new ApiError(400, 'Invalid custom subject flag');
  }
  const recipientName = typeof input.recipient_name === 'string' ? input.recipient_name : parsed.firstName;
  const recipientCompany = typeof input.recipient_company === 'string' ? input.recipient_company : parsed.company;
  const recipientRole = typeof input.recipient_role === 'string' ? input.recipient_role : '';
  const recipientJobId = typeof input.recipient_job_id === 'string' ? input.recipient_job_id : '';
  for (const [field, value] of [['name', recipientName], ['company', recipientCompany], ['role', recipientRole], ['job id', recipientJobId]] as const) {
    if (value.length > 500) throw new ApiError(400, `Invalid recipient ${field}`);
  }
  const useCustomSubject = input.use_custom_subject === true;
  const customSubject = typeof input.custom_subject === 'string' ? input.custom_subject : null;
  const finalSubject = typeof input.final_subject === 'string'
    ? input.final_subject
    : useCustomSubject && customSubject !== null
      ? customSubject
      : renderTemplate(defaultSubject, {
          Name: recipientName,
          Company: recipientCompany,
          Role: recipientRole,
          JobId: recipientJobId,
        }).text;
  const finalBody = typeof input.final_body === 'string'
    ? input.final_body
    : renderTemplate(defaultBody, {
        Name: recipientName,
        Company: recipientCompany,
        Role: recipientRole,
        JobId: recipientJobId,
      }).text;

  assertNoHeaderBreaks(finalSubject, 'subject');
  if (finalSubject.length > 998 || finalBody.length > 100_000) {
    throw new ApiError(400, 'Rendered message is too large');
  }
  try {
    assertSendable(finalSubject, finalBody);
  } catch {
    throw new ApiError(400, 'Subject or body contains unresolved placeholders');
  }
  return {
    recipient_email: parsed.email,
    recipient_name: recipientName || null,
    recipient_company: recipientCompany || null,
    recipient_role: recipientRole || null,
    recipient_job_id: recipientJobId || null,
    use_custom_subject: useCustomSubject ? 1 : 0,
    custom_subject: customSubject,
    final_subject: finalSubject,
    final_body: finalBody,
  };
}

function validateResume(input: unknown): { filename: string; base64: string } | null {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'Invalid resume attachment');
  }
  const attachment = input as Record<string, unknown>;
  const filename = stringValue(attachment.filename, 'attachment filename', 255);
  const contentType = stringValue(attachment.contentType, 'attachment content type', 100);
  const base64 = stringValue(attachment.base64, 'attachment data', 2_100_000);
  if (/[\r\n]/.test(filename) || contentType !== 'application/pdf') {
    throw new ApiError(400, 'Resume must be a PDF with a valid filename');
  }
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new ApiError(400, 'Invalid resume data');
  }
  const bytesLength = Math.floor(normalized.replace(/=+$/, '').length * 3 / 4);
  if (bytesLength > MAX_RESUME_BYTES) throw new ApiError(413, 'Resume exceeds 1.5 MB');
  let decoded: string;
  try {
    decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  } catch {
    throw new ApiError(400, 'Invalid resume data');
  }
  if (!decoded.startsWith('%PDF-')) throw new ApiError(400, 'Resume is not a valid PDF');
  return { filename, base64: normalized };
}

async function beginGoogleLogin(
  request: Request,
  dependencies: ApiDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const invite = url.searchParams.get('invite');
  let inviteHash: string | undefined;
  if (invite) inviteHash = await hashToken(invite);
  const state = createRandomToken(32);
  const verifier = createRandomToken(48);
  const challenge = await createPkceChallenge(verifier);
  const payload = {
    state,
    verifier,
    purpose: 'LOGIN' as const,
    exp: Math.floor(getNow(dependencies) / 1000) + 600,
    ...(inviteHash ? { inviteHash } : {}),
  };
  const callback = redirectUri(dependencies.config, '/api/auth/google/callback');
  const location = dependencies.google.authorizationUrl({
    redirectUri: callback,
    state,
    codeChallenge: challenge,
    scopes: LOGIN_SCOPES,
  });
  return redirect(location, [
    await createOAuthStateCookie(payload, dependencies.config.sessionSecret, isSecure(dependencies.config)),
  ]);
}

async function completeGoogleLogin(
  request: Request,
  dependencies: ApiDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has('error')) {
    return redirect(makeErrorRedirect(dependencies.config, 'google_sign_in_failed'), [
      clearOAuthCookie(isSecure(dependencies.config)),
    ]);
  }
  const code = url.searchParams.get('code');
  const stateValue = url.searchParams.get('state');
  const oauthState = await readOAuthState(request, dependencies.config.sessionSecret, getNow(dependencies));
  if (!code || !stateValue || !oauthState || oauthState.purpose !== 'LOGIN' || oauthState.state !== stateValue) {
    return redirect(makeErrorRedirect(dependencies.config, 'invalid_oauth_state'), [
      clearOAuthCookie(isSecure(dependencies.config)),
    ]);
  }

  try {
    const tokens = await dependencies.google.exchangeCode(
      code,
      redirectUri(dependencies.config, '/api/auth/google/callback'),
      oauthState.verifier,
    );
    const googleUser = await dependencies.google.userInfo(tokens.accessToken);
    if (!googleUser.emailVerified) throw new Error('Unverified Google account');

    let user = await first<UserRow>(
      dependencies.db,
      `SELECT id, google_id, email, name, profile_picture, role, status, created_at, updated_at
       FROM users WHERE google_id = ?`,
      googleUser.id,
    );
    if (!user) {
      const emailOwner = await first<{ id: string }>(
        dependencies.db,
        'SELECT id FROM users WHERE email = ?',
        googleUser.email,
      );
      if (emailOwner) return redirect(makeErrorRedirect(dependencies.config, 'account_conflict'), [
        clearOAuthCookie(isSecure(dependencies.config)),
      ]);

      const registration = await first<{ value: string }>(
        dependencies.db,
        `SELECT value FROM app_settings WHERE key = 'registration_mode'`,
      );
      if (registration?.value !== 'PUBLIC') {
        if (!oauthState.inviteHash) {
          return redirect(makeErrorRedirect(dependencies.config, 'invitation_required'), [
            clearOAuthCookie(isSecure(dependencies.config)),
          ]);
        }
        const invitation = await first<{ id: string }>(
          dependencies.db,
          `UPDATE invitations SET used_at = ?
           WHERE id = (
             SELECT id FROM invitations
             WHERE invitation_token_hash = ? AND lower(email) = ?
               AND used_at IS NULL AND expires_at > ?
             LIMIT 1
           )
           AND used_at IS NULL
           RETURNING id`,
          isoNow(dependencies),
          oauthState.inviteHash,
          googleUser.email,
          isoNow(dependencies),
        );
        if (!invitation) {
          return redirect(makeErrorRedirect(dependencies.config, 'invalid_invitation'), [
            clearOAuthCookie(isSecure(dependencies.config)),
          ]);
        }
      }

      const role = dependencies.config.adminEmails.has(googleUser.email) ? 'ADMIN' : 'USER';
      await run(
        dependencies.db,
        `INSERT INTO users (id, google_id, email, name, profile_picture, role)
         VALUES (?, ?, ?, ?, ?, ?)`,
        randomId(),
        googleUser.id,
        googleUser.email,
        googleUser.name,
        googleUser.picture,
        role,
      );
      user = await first<UserRow>(
        dependencies.db,
        `SELECT id, google_id, email, name, profile_picture, role, status, created_at, updated_at
         FROM users WHERE google_id = ?`,
        googleUser.id,
      );
    }
    if (!user || user.status !== 'ACTIVE') {
      return redirect(makeErrorRedirect(dependencies.config, 'account_disabled'), [
        clearOAuthCookie(isSecure(dependencies.config)),
      ]);
    }

    const csrf = createRandomToken(24);
    return redirect(dependencies.config.appBaseUrl, [
      await createSessionCookie(user.id, dependencies.config.sessionSecret, isSecure(dependencies.config), getNow(dependencies)),
      csrfCookie(csrf, isSecure(dependencies.config)),
      clearOAuthCookie(isSecure(dependencies.config)),
    ]);
  } catch {
    return redirect(makeErrorRedirect(dependencies.config, 'google_sign_in_failed'), [
      clearOAuthCookie(isSecure(dependencies.config)),
    ]);
  }
}

async function beginGmailConnect(
  request: Request,
  user: UserRow,
  dependencies: ApiDependencies,
): Promise<Response> {
  const state = createRandomToken(32);
  const verifier = createRandomToken(48);
  const challenge = await createPkceChallenge(verifier);
  const callback = redirectUri(dependencies.config, '/api/auth/gmail/callback');
  const location = dependencies.google.authorizationUrl({
    redirectUri: callback,
    state,
    codeChallenge: challenge,
    scopes: GMAIL_SCOPES,
    accessType: 'offline',
    prompt: 'consent',
  });
  const cookie = await createOAuthStateCookie(
    {
      state,
      verifier,
      purpose: 'GMAIL',
      userId: user.id,
      exp: Math.floor(getNow(dependencies) / 1000) + 600,
    },
    dependencies.config.sessionSecret,
    isSecure(dependencies.config),
  );
  return redirect(location, [cookie]);
}

async function completeGmailConnect(
  request: Request,
  dependencies: ApiDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const user = await requireUser(request, dependencies);
  const oauthState = await readOAuthState(request, dependencies.config.sessionSecret, getNow(dependencies));
  if (
    !oauthState ||
    oauthState.purpose !== 'GMAIL' ||
    oauthState.userId !== user.id ||
    oauthState.state !== url.searchParams.get('state') ||
    !url.searchParams.get('code')
  ) {
    return redirect(makeErrorRedirect(dependencies.config, 'invalid_gmail_oauth_state'), [
      clearOAuthCookie(isSecure(dependencies.config)),
    ]);
  }

  try {
    const tokens = await dependencies.google.exchangeCode(
      url.searchParams.get('code')!,
      redirectUri(dependencies.config, '/api/auth/gmail/callback'),
      oauthState.verifier,
    );
    if (!tokens.refreshToken) throw new Error('Google did not return a refresh token');
    const googleUser = await dependencies.google.userInfo(tokens.accessToken);
    const encrypted = await encryptSecret(tokens.refreshToken, dependencies.config.tokenEncryptionKey);
    const timestamp = isoNow(dependencies);
    await run(
      dependencies.db,
      `INSERT INTO connected_email_accounts
        (id, user_id, provider, email_address, encrypted_refresh_token, token_iv,
         key_version, scopes, connection_status, created_at, updated_at)
       VALUES (?, ?, 'GMAIL', ?, ?, ?, ?, ?, 'CONNECTED', ?, ?)
       ON CONFLICT(user_id, email_address) DO UPDATE SET
         encrypted_refresh_token = excluded.encrypted_refresh_token,
         token_iv = excluded.token_iv,
         key_version = excluded.key_version,
         scopes = excluded.scopes,
         connection_status = 'CONNECTED',
         updated_at = excluded.updated_at`,
      randomId(),
      user.id,
      googleUser.email,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyVersion,
      GMAIL_SCOPES.join(' '),
      timestamp,
      timestamp,
    );
    return redirect(dependencies.config.appBaseUrl, [clearOAuthCookie(isSecure(dependencies.config))]);
  } catch {
    return redirect(makeErrorRedirect(dependencies.config, 'gmail_connect_failed'), [
      clearOAuthCookie(isSecure(dependencies.config)),
    ]);
  }
}

async function handleAuth(
  request: Request,
  path: string,
  dependencies: ApiDependencies,
): Promise<Response> {
  if (request.method === 'GET' && path === '/api/auth/google/start') {
    return beginGoogleLogin(request, dependencies);
  }
  if (request.method === 'GET' && path === '/api/auth/google/callback') {
    return completeGoogleLogin(request, dependencies);
  }
  if (request.method === 'GET' && path === '/api/auth/csrf') {
    const token = createRandomToken(24);
    return json({ csrfToken: token }, 200, {
      'Set-Cookie': csrfCookie(token, isSecure(dependencies.config)),
    });
  }
  if (request.method === 'GET' && path === '/api/auth/me') {
    const user = await readSession(
      request,
      dependencies.db,
      dependencies.config.sessionSecret,
      getNow(dependencies),
    );
    return json({ user: user ? publicUser(user) : null, emailMode: dependencies.config.emailMode });
  }
  if (request.method === 'POST' && path === '/api/auth/logout') {
    const response = json({ ok: true });
    for (const cookie of clearSessionCookies(isSecure(dependencies.config))) {
      response.headers.append('Set-Cookie', cookie);
    }
    return response;
  }
  if (request.method === 'GET' && path === '/api/auth/gmail/connect') {
    const user = await requireUser(request, dependencies);
    if (!dependencies.config.googleClientId || !dependencies.config.googleClientSecret) {
      throw new ApiError(503, 'Google OAuth is not configured');
    }
    return beginGmailConnect(request, user, dependencies);
  }
  if (request.method === 'GET' && path === '/api/auth/gmail/callback') {
    return completeGmailConnect(request, dependencies);
  }
  if (request.method === 'GET' && path === '/api/auth/gmail') {
    const user = await requireUser(request, dependencies);
    const accounts = await all<Pick<ConnectedEmailAccountRow, 'id' | 'email_address' | 'connection_status' | 'created_at'>>(
      dependencies.db,
      `SELECT id, email_address, connection_status, created_at
       FROM connected_email_accounts WHERE user_id = ? ORDER BY created_at`,
      user.id,
    );
    return json({ accounts });
  }
  if (request.method === 'POST' && path === '/api/auth/gmail/disconnect') {
    const user = await requireUser(request, dependencies);
    const body = await readJson(request);
    const accountId = stringValue(body.accountId, 'account id', 100);
    const account = await first<ConnectedEmailAccountRow>(
      dependencies.db,
      `SELECT * FROM connected_email_accounts
       WHERE id = ? AND user_id = ? AND connection_status = 'CONNECTED'`,
      accountId,
      user.id,
    );
    if (!account) throw new ApiError(404, 'Connected account not found');
    const refreshToken = await decryptSecret(
      {
        ciphertext: account.encrypted_refresh_token,
        iv: account.token_iv,
        keyVersion: account.key_version,
      },
      dependencies.config.tokenEncryptionKey,
    );
    await dependencies.google.revokeToken(refreshToken);
    await run(
      dependencies.db,
      `UPDATE connected_email_accounts
       SET connection_status = 'REVOKED', updated_at = ? WHERE id = ? AND user_id = ?`,
      isoNow(dependencies),
      accountId,
      user.id,
    );
    return json({ ok: true });
  }
  throw new ApiError(404, 'Route not found');
}

function publicUser(user: UserRow): Pick<UserRow, 'id' | 'email' | 'name' | 'profile_picture' | 'role'> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    profile_picture: user.profile_picture,
    role: user.role,
  };
}

async function handleAdmin(
  request: Request,
  path: string,
  user: UserRow,
  dependencies: ApiDependencies,
): Promise<Response> {
  requireAdmin(user);
  if (request.method === 'GET' && path === '/api/admin/settings') {
    const setting = await first<{ value: string }>(
      dependencies.db,
      `SELECT value FROM app_settings WHERE key = 'registration_mode'`,
    );
    const counts = await first<{ users: number; campaigns: number; invitations: number }>(
      dependencies.db,
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM campaigns) AS campaigns,
        (SELECT COUNT(*) FROM invitations) AS invitations`,
    );
    return json({ registrationMode: setting?.value ?? 'INVITE_ONLY', counts });
  }
  if (request.method === 'POST' && path === '/api/admin/registration-mode') {
    const body = await readJson(request);
    const mode = stringValue(body.mode, 'registration mode', 20);
    if (mode !== 'INVITE_ONLY' && mode !== 'PUBLIC') throw new ApiError(400, 'Invalid registration mode');
    await run(
      dependencies.db,
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('registration_mode', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      mode,
      isoNow(dependencies),
    );
    return json({ registrationMode: mode });
  }
  if (request.method === 'POST' && path === '/api/admin/invitations') {
    const body = await readJson(request);
    const email = stringValue(body.email, 'email', 254).trim().toLowerCase();
    try {
      parseRecipient(email);
    } catch {
      throw new ApiError(400, 'Invalid email address');
    }
    const lifetimeDays = body.lifetimeDays === undefined ? 7 : Number(body.lifetimeDays);
    if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 30) {
      throw new ApiError(400, 'Invitation lifetime must be 1 to 30 days');
    }
    const token = generateInvitationToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(getNow(dependencies) + lifetimeDays * 86400_000).toISOString();
    const id = randomId();
    await run(
      dependencies.db,
      `INSERT INTO invitations (id, email, invitation_token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      email,
      tokenHash,
      user.id,
      expiresAt,
    );
    return json({
      invitation: {
        id,
        email,
        expiresAt,
        link: `${dependencies.config.appBaseUrl}/?invite=${encodeURIComponent(token)}`,
      },
    }, 201);
  }
  if (request.method === 'GET' && path === '/api/admin/invitations') {
    const invitations = await all(
      dependencies.db,
      `SELECT id, email, invited_by, expires_at, used_at, created_at
       FROM invitations ORDER BY created_at DESC LIMIT 500`,
    );
    return json({ invitations });
  }
  if (request.method === 'GET' && path === '/api/admin/users') {
    const users = await all(
      dependencies.db,
      `SELECT id, email, name, role, status, created_at
       FROM users ORDER BY created_at DESC LIMIT 500`,
    );
    return json({ users });
  }
  const statusMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
  if (request.method === 'POST' && statusMatch) {
    const body = await readJson(request);
    const status = stringValue(body.status, 'user status', 20);
    if (status !== 'ACTIVE' && status !== 'DISABLED') throw new ApiError(400, 'Invalid user status');
    const changes = await run(
      dependencies.db,
      'UPDATE users SET status = ?, updated_at = ? WHERE id = ?',
      status,
      isoNow(dependencies),
      decodeURIComponent(statusMatch[1]),
    );
    if (!changes) throw new ApiError(404, 'User not found');
    return json({ ok: true });
  }
  throw new ApiError(404, 'Route not found');
}

async function handleTemplates(
  request: Request,
  path: string,
  user: UserRow,
  dependencies: ApiDependencies,
): Promise<Response> {
  if (path === '/api/templates' && request.method === 'GET') {
    const templates = await all<EmailTemplateRow>(
      dependencies.db,
      `SELECT * FROM email_templates WHERE user_id = ? ORDER BY updated_at DESC`,
      user.id,
    );
    return json({ templates });
  }
  if (path === '/api/templates' && request.method === 'POST') {
    const body = await readJson(request);
    const template = parseTemplate(body);
    if (!template.template_name) throw new ApiError(400, 'Template name is required');
    const id = randomId();
    const now = isoNow(dependencies);
    await run(
      dependencies.db,
      `INSERT INTO email_templates
        (id, user_id, template_name, default_subject, default_body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      template.template_name,
      template.default_subject,
      template.default_body,
      now,
      now,
    );
    return json({ template: { id, user_id: user.id, ...template, created_at: now, updated_at: now } }, 201);
  }
  const match = path.match(/^\/api\/templates\/([^/]+)$/);
  if (!match) throw new ApiError(404, 'Route not found');
  const id = decodeURIComponent(match[1]);
  if (request.method === 'PUT') {
    const body = await readJson(request);
    const template = parseTemplate(body);
    const changes = await run(
      dependencies.db,
      `UPDATE email_templates
       SET template_name = ?, default_subject = ?, default_body = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      template.template_name,
      template.default_subject,
      template.default_body,
      isoNow(dependencies),
      id,
      user.id,
    );
    if (!changes) throw new ApiError(404, 'Template not found');
    return json({ ok: true });
  }
  if (request.method === 'DELETE') {
    const changes = await run(
      dependencies.db,
      'DELETE FROM email_templates WHERE id = ? AND user_id = ?',
      id,
      user.id,
    );
    if (!changes) throw new ApiError(404, 'Template not found');
    return json({ ok: true });
  }
  throw new ApiError(405, 'Method not allowed');
}

async function getOwnedCampaign(
  db: Database,
  campaignId: string,
  userId: string,
): Promise<CampaignRow | null> {
  return first<CampaignRow>(
    db,
    'SELECT * FROM campaigns WHERE id = ? AND user_id = ?',
    campaignId,
    userId,
  );
}

async function handleCampaigns(
  request: Request,
  path: string,
  user: UserRow,
  dependencies: ApiDependencies,
): Promise<Response> {
  if (path === '/api/campaigns' && request.method === 'GET') {
    const campaigns = await all<CampaignRow>(
      dependencies.db,
      'SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC LIMIT 200',
      user.id,
    );
    return json({ campaigns });
  }
  if (path === '/api/campaigns' && request.method === 'POST') {
    const body = await readJson(request);
    const campaignName = stringValue(body.campaign_name, 'campaign name', 160).trim();
    if (!campaignName) throw new ApiError(400, 'Campaign name is required');
    if (!Array.isArray(body.recipients) || body.recipients.length < 1 || body.recipients.length > MAX_CAMPAIGN_RECIPIENTS) {
      throw new ApiError(400, `Campaigns must contain 1 to ${MAX_CAMPAIGN_RECIPIENTS} recipients`);
    }
    const templateId = body.template_id === null || body.template_id === undefined
      ? null
      : stringValue(body.template_id, 'template id', 100);
    let template: EmailTemplateRow | null = null;
    if (templateId) {
      template = await first<EmailTemplateRow>(
        dependencies.db,
        'SELECT * FROM email_templates WHERE id = ? AND user_id = ?',
        templateId,
        user.id,
      );
      if (!template) throw new ApiError(404, 'Template not found');
    }
    const defaultSubject = stringValue(
      template?.default_subject ?? body.default_subject,
      'subject',
      998,
    );
    const defaultBody = stringValue(
      template?.default_body ?? body.default_body,
      'body',
      100_000,
    );
    const recipients = body.recipients.map((recipient) =>
      validateRecipientInput(recipient as CampaignRecipientInput, defaultSubject, defaultBody),
    );
    if (new Set(recipients.map((recipient) => recipient.recipient_email)).size !== recipients.length) {
      throw new ApiError(400, 'Duplicate recipient email');
    }
    const id = randomId();
    const now = isoNow(dependencies);
    const statements: PreparedStatement[] = [
      dependencies.db.prepare(
        `INSERT INTO campaigns
          (id, user_id, template_id, campaign_name, total_recipients, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, user.id, templateId, campaignName, recipients.length, now),
      ...recipients.map((recipient) =>
        dependencies.db.prepare(
          `INSERT INTO campaign_recipients
            (id, campaign_id, recipient_email, recipient_name, recipient_company,
             recipient_role, recipient_job_id, use_custom_subject, custom_subject,
             final_subject, final_body, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          randomId(),
          id,
          recipient.recipient_email,
          recipient.recipient_name,
          recipient.recipient_company,
          recipient.recipient_role,
          recipient.recipient_job_id,
          recipient.use_custom_subject,
          recipient.custom_subject,
          recipient.final_subject,
          recipient.final_body,
          now,
          now,
        ),
      ),
    ];
    await dependencies.db.batch(statements);
    return json({ campaign: { id, user_id: user.id, campaign_name: campaignName, status: 'DRAFT', total_recipients: recipients.length } }, 201);
  }

  const match = path.match(/^\/api\/campaigns\/([^/]+)(?:\/(send-batch|cancel|retry-failed))?$/);
  if (!match) throw new ApiError(404, 'Route not found');
  const campaignId = decodeURIComponent(match[1]);
  const action = match[2];
  const campaign = await getOwnedCampaign(dependencies.db, campaignId, user.id);
  if (!campaign) throw new ApiError(404, 'Campaign not found');

  if (!action && request.method === 'GET') {
    const recipients = await all<CampaignRecipientRow>(
      dependencies.db,
      'SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY created_at, id',
      campaignId,
    );
    return json({ campaign, recipients });
  }
  if (action === 'cancel' && request.method === 'POST') {
    await run(
      dependencies.db,
      `UPDATE campaign_recipients SET sending_status = 'CANCELLED', updated_at = ?
       WHERE campaign_id = ? AND sending_status = 'PENDING'`,
      isoNow(dependencies),
      campaignId,
    );
    const counts = await first<{ pending: number; processing: number }>(
      dependencies.db,
      `SELECT
        SUM(CASE WHEN sending_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN sending_status = 'PROCESSING' THEN 1 ELSE 0 END) AS processing
       FROM campaign_recipients WHERE campaign_id = ?`,
      campaignId,
    );
    if (!counts?.pending && !counts?.processing) {
      await run(
        dependencies.db,
        `UPDATE campaigns SET status = 'CANCELLED', completed_at = ? WHERE id = ? AND user_id = ?`,
        isoNow(dependencies),
        campaignId,
        user.id,
      );
    }
    return json({ ok: true });
  }
  if (action === 'retry-failed' && request.method === 'POST') {
    const now = isoNow(dependencies);
    const changes = await run(
      dependencies.db,
      `UPDATE campaign_recipients
       SET sending_status = 'PENDING',
           error_message = NULL, updated_at = ?
       WHERE campaign_id = ? AND sending_status = 'FAILED'`,
      now,
      campaignId,
    );
    if (changes) {
      await run(
        dependencies.db,
        `UPDATE campaigns SET status = 'SENDING', completed_at = NULL WHERE id = ? AND user_id = ?`,
        campaignId,
        user.id,
      );
    }
    return json({ retried: changes });
  }
  if (action === 'send-batch' && request.method === 'POST') {
    return sendCampaignBatch(request, campaign, user, dependencies);
  }
  throw new ApiError(405, 'Method not allowed');
}

async function sendCampaignBatch(
  request: Request,
  campaign: CampaignRow,
  user: UserRow,
  dependencies: ApiDependencies,
): Promise<Response> {
  const body = await readJson(request);
  const requestedSize = body.batchSize === undefined ? MAX_SEND_BATCH : Number(body.batchSize);
  if (!Number.isInteger(requestedSize) || requestedSize < 1) throw new ApiError(400, 'Invalid batch size');
  const batchSize = Math.min(requestedSize, MAX_SEND_BATCH);
  const attachment = validateResume(body.attachment);
  if (dependencies.config.emailMode === 'GMAIL' && !dependencies.config.tokenEncryptionKey) {
    throw new ApiError(503, 'Email sending is not configured');
  }

  const now = getNow(dependencies);
  const nowText = new Date(now).toISOString();
  const staleBefore = new Date(now - PROCESSING_TIMEOUT_MS).toISOString();
  await run(
    dependencies.db,
    `UPDATE campaign_recipients
     SET sending_status = 'UNKNOWN', error_message = 'Delivery outcome could not be confirmed', updated_at = ?
     WHERE campaign_id = ? AND sending_status = 'PROCESSING' AND updated_at < ?`,
    nowText,
    campaign.id,
    staleBefore,
  );

  const utcDayStart = `${nowText.slice(0, 10)}T00:00:00.000Z`;
  const dailyCount = await first<{ reserved: number }>(
    dependencies.db,
    `SELECT COUNT(*) AS reserved
     FROM campaign_recipients recipient
     JOIN campaigns owner_campaign ON owner_campaign.id = recipient.campaign_id
     WHERE owner_campaign.user_id = ?
       AND ((recipient.sending_status = 'SENT' AND recipient.sent_at >= ?)
         OR (recipient.sending_status = 'PROCESSING' AND recipient.updated_at >= ?))`,
    user.id,
    utcDayStart,
    utcDayStart,
  );
  const remainingDaily = dependencies.config.dailySendLimit - (dailyCount?.reserved ?? 0);
  if (remainingDaily <= 0) throw new ApiError(429, 'Daily sending limit reached');

  const claimed = await dependencies.db.prepare(
    `UPDATE campaign_recipients
     SET sending_status = 'PROCESSING', updated_at = ?, attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT pending.id FROM campaign_recipients pending
       JOIN campaigns owner_campaign ON owner_campaign.id = pending.campaign_id
       WHERE pending.campaign_id = ? AND pending.sending_status = 'PENDING'
         AND owner_campaign.user_id = ?
       ORDER BY pending.created_at, pending.id
       LIMIT MIN(?, MAX(0, ? - (
         SELECT COUNT(*) FROM campaign_recipients reserved
         JOIN campaigns reserved_campaign ON reserved_campaign.id = reserved.campaign_id
         WHERE reserved_campaign.user_id = ?
           AND ((reserved.sending_status = 'SENT' AND reserved.sent_at >= ?)
             OR (reserved.sending_status = 'PROCESSING' AND reserved.updated_at >= ?))
       )))
     )
     AND sending_status = 'PENDING'
     RETURNING *`,
  ).bind(
    nowText,
    campaign.id,
    user.id,
    batchSize,
    dependencies.config.dailySendLimit,
    user.id,
    utcDayStart,
    utcDayStart,
  ).all<CampaignRecipientRow>();
  const recipients = claimed.results;
  if (recipients.length === 0) {
    await refreshCampaignStatus(campaign.id, user.id, dependencies);
    return json({ processed: 0, remaining: await pendingCount(campaign.id, dependencies) });
  }

  let accessToken: string | null = null;
  let senderEmail = '';
  if (dependencies.config.emailMode === 'GMAIL') {
    const account = await first<ConnectedEmailAccountRow>(
      dependencies.db,
      `SELECT * FROM connected_email_accounts
       WHERE user_id = ? AND connection_status = 'CONNECTED'
       ORDER BY updated_at DESC LIMIT 1`,
      user.id,
    );
    if (!account) {
      await markRecipientsFailed(recipients, 'No connected Gmail account', dependencies);
      await refreshCampaignStatus(campaign.id, user.id, dependencies);
      throw new ApiError(409, 'Connect a Gmail account before sending');
    }
    senderEmail = account.email_address;
    try {
      const refreshToken = await decryptSecret(
        {
          ciphertext: account.encrypted_refresh_token,
          iv: account.token_iv,
          keyVersion: account.key_version,
        },
        dependencies.config.tokenEncryptionKey,
      );
      const refreshed = await dependencies.google.refreshAccessToken(refreshToken);
      accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) {
        const encrypted = await encryptSecret(refreshed.refreshToken, dependencies.config.tokenEncryptionKey);
        await run(
          dependencies.db,
          `UPDATE connected_email_accounts
           SET encrypted_refresh_token = ?, token_iv = ?, key_version = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.keyVersion,
          nowText,
          account.id,
          user.id,
        );
      }
    } catch {
      await markRecipientsFailed(recipients, 'Gmail authorization failed', dependencies);
      await refreshCampaignStatus(campaign.id, user.id, dependencies);
      throw new ApiError(502, 'Gmail authorization failed');
    }
  }

  for (const recipient of recipients) {
    try {
      let gmailMessageId: string;
      if (dependencies.config.emailMode === 'MOCK') {
        gmailMessageId = `MOCK-${recipient.id}`;
      } else {
        const raw = buildRawMessage({
          from: senderEmail,
          to: recipient.recipient_email,
          subject: recipient.final_subject,
          body: recipient.final_body,
          ...(attachment ? { attachment: { ...attachment, contentType: 'application/pdf' } } : {}),
        });
        const result = await dependencies.google.sendGmailMessage({
          accessToken: accessToken!,
          raw,
        });
        gmailMessageId = result.id;
      }
      await run(
        dependencies.db,
        `UPDATE campaign_recipients SET sending_status = 'SENT', gmail_message_id = ?,
           sent_at = ?, error_message = NULL, updated_at = ?
         WHERE id = ? AND sending_status = 'PROCESSING'`,
        gmailMessageId,
        nowText,
        nowText,
        recipient.id,
      );
    } catch {
      await run(
        dependencies.db,
        `UPDATE campaign_recipients SET sending_status = 'FAILED',
           error_message = 'Delivery failed', updated_at = ?
         WHERE id = ? AND sending_status = 'PROCESSING'`,
        nowText,
        recipient.id,
      );
    }
  }

  await refreshCampaignStatus(campaign.id, user.id, dependencies);
  return json({
    processed: recipients.length,
    remaining: await pendingCount(campaign.id, dependencies),
    mode: dependencies.config.emailMode,
  });
}

async function markRecipientsFailed(
  recipients: CampaignRecipientRow[],
  safeMessage: string,
  dependencies: ApiDependencies,
): Promise<void> {
  const now = isoNow(dependencies);
  await dependencies.db.batch(
    recipients.map((recipient) =>
      dependencies.db.prepare(
        `UPDATE campaign_recipients SET sending_status = 'FAILED', error_message = ?, updated_at = ?
         WHERE id = ? AND sending_status = 'PROCESSING'`,
      ).bind(safeMessage, now, recipient.id),
    ),
  );
}

async function pendingCount(campaignId: string, dependencies: ApiDependencies): Promise<number> {
  const result = await first<{ count: number }>(
    dependencies.db,
    `SELECT COUNT(*) AS count FROM campaign_recipients
     WHERE campaign_id = ? AND sending_status = 'PENDING'`,
    campaignId,
  );
  return result?.count ?? 0;
}

async function refreshCampaignStatus(
  campaignId: string,
  userId: string,
  dependencies: ApiDependencies,
): Promise<void> {
  await run(
    dependencies.db,
    `UPDATE campaigns SET
       sent_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND sending_status = 'SENT'),
       failed_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND sending_status = 'FAILED'),
       status = CASE
         WHEN EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND sending_status IN ('PENDING', 'PROCESSING')) THEN 'SENDING'
         WHEN EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND sending_status = 'UNKNOWN') THEN 'SENDING'
         WHEN EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND sending_status = 'CANCELLED')
           AND NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND sending_status IN ('PENDING', 'PROCESSING')) THEN 'CANCELLED'
         ELSE 'COMPLETED'
       END,
       started_at = COALESCE(started_at, ?),
       completed_at = CASE
         WHEN EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND sending_status IN ('PENDING', 'PROCESSING')) THEN NULL
         ELSE COALESCE(completed_at, ?)
       END
     WHERE id = ? AND user_id = ?`,
    campaignId,
    campaignId,
    campaignId,
    campaignId,
    campaignId,
    campaignId,
    isoNow(dependencies),
    campaignId,
    isoNow(dependencies),
    campaignId,
    userId,
  );
}

export async function handleApiRequest(
  request: Request,
  dependencies: ApiDependencies,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (!path.startsWith('/api/')) throw new ApiError(404, 'Route not found');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
    if (path === '/api/health' && request.method === 'GET') {
      return json({ status: 'UP', application: 'ReachFlow' });
    }
    if (path.startsWith('/api/auth/')) {
      if (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
      ) {
        ensureSameOrigin(request, dependencies.config);
      }
      return await handleAuth(request, path, dependencies);
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      ensureSameOrigin(request, dependencies.config);
    }
    const user = await requireUser(request, dependencies);
    if (path.startsWith('/api/admin/')) return await handleAdmin(request, path, user, dependencies);
    if (path.startsWith('/api/templates')) return await handleTemplates(request, path, user, dependencies);
    if (path.startsWith('/api/campaigns')) return await handleCampaigns(request, path, user, dependencies);
    throw new ApiError(404, 'Route not found');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return json({ error: 'Invalid request' }, 400);
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return json({ error: 'A record with those details already exists' }, 409);
    }
    return json({ error: 'Request could not be completed' }, 500);
  }
}

export async function debugQueryResult<T>(
  dependencies: ApiDependencies,
  query: string,
  ...values: unknown[]
): Promise<T | null> {
  return first<T>(dependencies.db, query, ...values);
}
