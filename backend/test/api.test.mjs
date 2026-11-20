import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashToken } from '../../shared/core/crypto.ts';
import { handleApiRequest } from '../src/api/router.ts';
import { createSessionCookie } from '../src/auth/session.ts';
import { GoogleAccessExpiredError, GoogleInvalidTokenError } from '../src/google/googleClient.ts';
import { FakeGoogleClient } from './fakeGoogle.mjs';
import { SQLiteDatabaseAdapter } from './sqliteDatabase.mjs';

const SESSION_SECRET = 'test-session-secret-with-at-least-32-chars';
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const APP_URL = 'https://reachflow.test';

function config(overrides = {}) {
  return {
    emailMode: 'MOCK',
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    sessionSecret: SESSION_SECRET,
    tokenEncryptionKey: ENCRYPTION_KEY,
    adminEmails: new Set(),
    dailySendLimit: 100,
    appBaseUrl: APP_URL,
    ...overrides,
  };
}

async function setup(overrides = {}) {
  const db = await SQLiteDatabaseAdapter.createWithMigrations();
  const google = new FakeGoogleClient();
  let now = Date.parse('2026-11-20T12:00:00.000Z');
  const dependencies = {
    db,
    google,
    config: config(overrides),
    now: () => now,
  };
  return {
    db,
    google,
    dependencies,
    setNow(value) {
      now = value;
    },
    close() {
      db.close();
    },
  };
}

async function seedUser(db, id, { email = `${id}@example.com`, role = 'USER', status = 'ACTIVE' } = {}) {
  await db
    .prepare(
      `INSERT INTO users (id, google_id, email, name, role, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, `google-${id}`, email, `User ${id}`, role, status)
    .run();
}

async function sessionFor(userId, now = Date.parse('2026-11-20T12:00:00.000Z')) {
  const cookie = await createSessionCookie(userId, SESSION_SECRET, true, now);
  return cookie.split(';', 1)[0];
}

async function csrfFor(dependencies) {
  const response = await handleApiRequest(new Request(`${APP_URL}/api/auth/csrf`), dependencies);
  const token = (await response.json()).csrfToken;
  return {
    token,
    cookie: response.headers
      .getSetCookie()
      .find((value) => value.startsWith('reachflow_csrf='))
      ?.split(';', 1)[0],
  };
}

async function apiRequest(
  dependencies,
  path,
  { method = 'GET', userCookie, csrfCookie, csrfToken, body, headers = {} } = {},
) {
  const requestHeaders = new Headers(headers);
  if (userCookie || csrfCookie) {
    requestHeaders.set('Cookie', [userCookie, csrfCookie].filter(Boolean).join('; '));
  }
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (!requestHeaders.has('Origin')) requestHeaders.set('Origin', APP_URL);
    if (csrfToken) requestHeaders.set('X-CSRF-Token', csrfToken);
  }
  return handleApiRequest(
    new Request(`${APP_URL}${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    dependencies,
  );
}

async function authThroughGoogle(fixture, inviteToken) {
  const startUrl = `${APP_URL}/api/auth/google/start${inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ''}`;
  const start = await handleApiRequest(new Request(startUrl), fixture.dependencies);
  assert.equal(start.status, 302);
  const oauthCookie = start.headers
    .getSetCookie()
    .find((value) => value.startsWith('reachflow_oauth='))
    .split(';', 1)[0];
  const authorizationUrl = new URL(start.headers.get('Location'));
  const callback = await handleApiRequest(
    new Request(
      `${APP_URL}/api/auth/google/callback?code=valid-code&state=${authorizationUrl.searchParams.get('state')}`,
      {
        headers: { Cookie: oauthCookie },
      },
    ),
    fixture.dependencies,
  );
  return callback;
}

async function createCampaign(
  fixture,
  userCookie,
  csrf,
  {
    recipients = ['a@acme.com', 'b@acme.com'],
    campaignName = 'Launch',
    defaultSubject = 'Hello [Name]',
    defaultBody = 'Role: [Role], job: [JobId]',
    role = 'Engineer',
    jobId = 'JOB-1',
  } = {},
) {
  const response = await apiRequest(fixture.dependencies, '/api/campaigns', {
    method: 'POST',
    userCookie,
    csrfCookie: csrf.cookie,
    csrfToken: csrf.token,
    body: {
      campaign_name: campaignName,
      default_subject: defaultSubject,
      default_body: defaultBody,
      recipients: recipients.map((email) => ({
        email,
        recipient_role: role,
        recipient_job_id: jobId,
      })),
    },
  });
  return { response, body: await response.json() };
}

test('invite-only registration requires a valid, unexpired, single-use email-bound invitation', async () => {
  const fixture = await setup();
  try {
    fixture.google.user.email = 'person@example.com';
    const noInvite = await authThroughGoogle(fixture);
    assert.match(noInvite.headers.get('Location'), /invitation_required/);

    await seedUser(fixture.db, 'admin', {
      role: 'ADMIN',
      email: 'admin@example.com',
    });
    const token = 'invite-once-secret';
    await fixture.db
      .prepare(
        `INSERT INTO invitations (id, email, invitation_token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .bind('invite-1', 'person@example.com', await hashToken(token), 'admin', '2026-11-21T00:00:00.000Z')
      .run();

    const success = await authThroughGoogle(fixture, token);
    assert.equal(success.status, 302);
    const user = await fixture.db
      .prepare('SELECT id, role FROM users WHERE email = ?')
      .bind('person@example.com')
      .first();
    assert.equal(user.role, 'USER');
    assert.ok(
      (await fixture.db.prepare('SELECT used_at FROM invitations WHERE id = ?').bind('invite-1').first())
        .used_at,
    );

    fixture.google.user = {
      ...fixture.google.user,
      id: 'another-subject',
      email: 'another-person@example.com',
    };
    const secondUse = await authThroughGoogle(fixture, token);
    assert.match(secondUse.headers.get('Location'), /invalid_invitation/);
  } finally {
    fixture.close();
  }
});

test('expired invitations are rejected and public mode permits registration', async () => {
  const fixture = await setup();
  try {
    fixture.google.user.email = 'expired@example.com';
    await seedUser(fixture.db, 'admin', {
      role: 'ADMIN',
      email: 'admin@example.com',
    });
    const token = 'expired-secret';
    await fixture.db
      .prepare(
        `INSERT INTO invitations (id, email, invitation_token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        'invite-expired',
        'expired@example.com',
        await hashToken(token),
        'admin',
        '2026-11-19T00:00:00.000Z',
      )
      .run();
    const expired = await authThroughGoogle(fixture, token);
    assert.match(expired.headers.get('Location'), /invalid_invitation/);

    fixture.google.user.email = 'public@example.com';
    await fixture.db
      .prepare(`UPDATE app_settings SET value = 'PUBLIC' WHERE key = 'registration_mode'`)
      .run();
    const publicRegistration = await authThroughGoogle(fixture);
    assert.equal(publicRegistration.status, 302);
    assert.ok(
      await fixture.db.prepare('SELECT id FROM users WHERE email = ?').bind('public@example.com').first(),
    );
  } finally {
    fixture.close();
  }
});

test('only allowlisted new Google users are bootstrapped as admins', async () => {
  const fixture = await setup({ adminEmails: new Set(['admin@example.com']) });
  try {
    await fixture.db
      .prepare(`UPDATE app_settings SET value = 'PUBLIC' WHERE key = 'registration_mode'`)
      .run();
    fixture.google.user.email = 'admin@example.com';
    await authThroughGoogle(fixture);
    assert.equal(
      (await fixture.db.prepare('SELECT role FROM users WHERE email = ?').bind('admin@example.com').first())
        .role,
      'ADMIN',
    );

    fixture.google.user = {
      ...fixture.google.user,
      id: 'another-subject',
      email: 'regular@example.com',
    };
    await authThroughGoogle(fixture);
    assert.equal(
      (await fixture.db.prepare('SELECT role FROM users WHERE email = ?').bind('regular@example.com').first())
        .role,
      'USER',
    );
  } finally {
    fixture.close();
  }
});

test('session tampering, expiry, and disabled users are rejected on each API request', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const me = await apiRequest(fixture.dependencies, '/api/auth/me', {
      userCookie,
    });
    assert.equal((await me.json()).user.id, 'user-1');

    const tampered = `${userCookie.slice(0, -1)}x`;
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/auth/me', {
          userCookie: tampered,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/campaigns', {
          userCookie: tampered,
        })
      ).status,
      401,
    );

    const expired = await sessionFor('user-1', Date.parse('2026-10-10T12:00:00.000Z'));
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/campaigns', {
          userCookie: expired,
        })
      ).status,
      401,
    );

    await fixture.db.prepare(`UPDATE users SET status = 'DISABLED' WHERE id = ?`).bind('user-1').run();
    assert.equal((await apiRequest(fixture.dependencies, '/api/campaigns', { userCookie })).status, 401);
  } finally {
    fixture.close();
  }
});

test('persistent sessions slide after 15 days, stop at 180 days, and logout clears instead of renewing', async () => {
  const f = await setup();
  try {
    await seedUser(f.db, 'a');
    const start = Date.parse('2026-11-20T12:00:00Z');
    const day = 86_400_000;
    const initial = await createSessionCookie('a', SESSION_SECRET, false, start);
    for (const flag of ['Max-Age=2592000', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      assert.ok(initial.includes(flag), flag);
    }
    let cookie = initial.split(';')[0];
    const payload = (value) => JSON.parse(Buffer.from(value.split('=')[1].split('.')[0], 'base64url'));
    assert.equal(payload(cookie).iat, start / 1000);
    f.setNow(start + 15 * day);
    assert.equal(
      (await apiRequest(f.dependencies, '/api/auth/me', { userCookie: cookie })).headers.get('Set-Cookie'),
      null,
    );
    f.setNow(start + 30 * day);
    assert.equal((await apiRequest(f.dependencies, '/api/campaigns', { userCookie: cookie })).status, 401);
    for (let elapsed = 16; elapsed <= 176; elapsed += 16) {
      f.setNow(start + elapsed * day);
      const response = await apiRequest(f.dependencies, '/api/auth/me', { userCookie: cookie });
      assert.equal((await response.json()).user.id, 'a');
      cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith('reachflow_session='))
        .split(';')[0];
      assert.equal(payload(cookie).firstIat, start / 1000);
      assert.ok(payload(cookie).exp <= start / 1000 + 180 * 86_400);
    }
    assert.equal(payload(cookie).exp, start / 1000 + 180 * 86_400);
    f.setNow(start + 180 * day);
    assert.equal((await apiRequest(f.dependencies, '/api/campaigns', { userCookie: cookie })).status, 401);
    f.setNow(start + 16 * day);
    const csrf = await csrfFor(f.dependencies);
    const renewed = await apiRequest(f.dependencies, '/api/auth/me', {
      userCookie: initial.split(';')[0], csrfCookie: csrf.cookie,
    });
    assert.ok(renewed.headers.getSetCookie().some((value) =>
      value.startsWith(`${csrf.cookie};`) && value.includes('Max-Age=2592000')));
    const logout = await apiRequest(f.dependencies, '/api/auth/logout', {
      method: 'POST',
      userCookie: initial.split(';')[0],
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
    });
    const sessionCookies = logout.headers
      .getSetCookie()
      .filter((value) => value.startsWith('reachflow_session='));
    assert.equal(sessionCookies.length, 1);
    assert.match(sessionCookies[0], /Max-Age=0/);
    const rotated = {
      ...f.dependencies,
      config: { ...f.dependencies.config, sessionSecret: 'a-different-secret-with-at-least-32-characters' },
    };
    assert.equal(
      (await apiRequest(rotated, '/api/campaigns', { userCookie: initial.split(';')[0] })).status,
      401,
    );
    await f.db.prepare('DELETE FROM users WHERE id=?').bind('a').run();
    assert.equal(
      (await apiRequest(f.dependencies, '/api/campaigns', { userCookie: initial.split(';')[0] })).status,
      401,
    );
  } finally {
    f.close();
  }
});

async function connectThroughGoogle(f, cookie) {
  const start = await apiRequest(f.dependencies, '/api/auth/gmail/connect', { userCookie: cookie });
  const oauthCookie = start.headers
    .getSetCookie()
    .find((value) => value.startsWith('reachflow_oauth='))
    .split(';')[0];
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  return apiRequest(f.dependencies, `/api/auth/gmail/callback?code=connect&state=${state}`, {
    userCookie: `${cookie}; ${oauthCookie}`,
  });
}

test('Gmail connect needs offline consent and a refresh token; sign-in stays separate', async () => {
  const f = await setup();
  try {
    await seedUser(f.db, 'a');
    const cookie = await sessionFor('a');
    f.google.withoutRefreshToken = true;
    const missing = await connectThroughGoogle(f, cookie);
    assert.match(missing.headers.get('Location'), /gmail_refresh_token_missing/);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM connected_email_accounts').first()).n, 0);
    const options = f.google.authorizationRequests.at(-1);
    assert.equal(options.accessType, 'offline');
    assert.equal(options.prompt, 'consent');
    f.google.withoutRefreshToken = false;
    assert.equal((await connectThroughGoogle(f, cookie)).headers.get('Location'), APP_URL);
    assert.equal(
      (await f.db.prepare('SELECT connection_status FROM connected_email_accounts').first())
        .connection_status,
      'CONNECTED',
    );
    assert.equal((await apiRequest(f.dependencies, '/api/auth/me', { userCookie: cookie })).status, 200);
  } finally {
    f.close();
  }
});

test('invalid_grant during refresh or send preserves Waiting, revokes Gmail but not login, and reconnect resumes only Waiting', async () => {
  for (const failure of ['refresh', 'send']) {
    const f = await setup({ emailMode: 'GMAIL' });
    try {
      await seedUser(f.db, 'a');
      const cookie = await sessionFor('a');
      const csrf = await csrfFor(f.dependencies);
      await connectThroughGoogle(f, cookie);
      const id = (
        await createCampaign(f, cookie, csrf, { recipients: ['a@acme.com', 'b@acme.com', 'c@acme.com'] })
      ).body.campaign.id;
      const call = () =>
        apiRequest(f.dependencies, `/api/campaigns/${id}/send-batch`, {
          method: 'POST',
          userCookie: cookie,
          csrfCookie: csrf.cookie,
          csrfToken: csrf.token,
          body: {},
        });
      const originalSend = f.google.sendGmailMessage.bind(f.google);
      if (failure === 'refresh') f.google.refreshError = new GoogleAccessExpiredError();
      else {
        let calls = 0;
        f.google.sendGmailMessage = async (message) => {
          if (++calls === 2) throw new GoogleAccessExpiredError();
          return originalSend(message);
        };
      }
      const stopped = await call();
      assert.equal(stopped.status, 409);
      assert.deepEqual(await stopped.json(), {
        error: 'Gmail access has expired. Reconnect Gmail, then continue.',
      });
      const rows = await f.db
        .prepare('SELECT sending_status FROM campaign_recipients WHERE campaign_id=?')
        .bind(id)
        .all();
      assert.equal(
        rows.results.filter((row) => row.sending_status === 'SENT').length,
        failure === 'send' ? 1 : 0,
      );
      assert.ok(rows.results.every((row) => ['PENDING', 'SENT'].includes(row.sending_status)));
      assert.equal(
        (await f.db.prepare('SELECT connection_status FROM connected_email_accounts').first())
          .connection_status,
        'REVOKED',
      );
      assert.equal(
        (await (await apiRequest(f.dependencies, '/api/auth/me', { userCookie: cookie })).json()).user.id,
        'a',
      );
      assert.equal((await call()).status, 409);
      assert.equal(f.google.sentMessages.length, failure === 'send' ? 1 : 0);
      f.google.refreshError = null;
      f.google.sendGmailMessage = originalSend;
      await connectThroughGoogle(f, cookie);
      assert.equal((await call()).status, 200);
      assert.equal((await call()).status, 200);
      assert.equal(f.google.sentMessages.length, 3);
    } finally {
      f.close();
    }
  }
});

test('account and admin deletion tolerate invalid Google tokens but network/server errors preserve data', async () => {
  for (const admin of [false, true]) {
    for (const invalid of [true, false]) {
      const f = await setup();
      try {
        await seedUser(f.db, 'a');
        await seedUser(f.db, 'admin', { role: 'ADMIN' });
        const cookie = await sessionFor('a');
        await connectThroughGoogle(f, cookie);
        f.google.revokeError = invalid
          ? new GoogleInvalidTokenError('already invalid')
          : new Error('network failed');
        const csrf = await csrfFor(f.dependencies);
        const response = await apiRequest(
          f.dependencies,
          admin ? '/api/admin/users/a' : '/api/auth/account',
          {
            method: 'DELETE',
            userCookie: admin ? await sessionFor('admin') : cookie,
            csrfCookie: csrf.cookie,
            csrfToken: csrf.token,
            body: { confirmation: 'DELETE' },
          },
        );
        assert.equal(response.status, invalid ? 200 : 502);
        assert.equal(!!(await f.db.prepare('SELECT id FROM users WHERE id=?').bind('a').first()), !invalid);
      } finally {
        f.close();
      }
    }
  }
});

test('allowlisted admin can bootstrap in invite-only mode, without opening registration', async () => {
  const f = await setup({ adminEmails: new Set(['admin@example.com']) });
  try {
    f.google.user.email = 'admin@example.com';
    const signedIn = await authThroughGoogle(f);
    assert.equal(signedIn.headers.get('Location'), APP_URL);
    assert.equal((await f.db.prepare('SELECT role FROM users').first()).role, 'ADMIN');
    f.google.user = { ...f.google.user, id: 'another', email: 'regular@example.com' };
    assert.match((await authThroughGoogle(f)).headers.get('Location'), /invitation_required/);
  } finally {
    f.close();
  }
});

test('state-changing requests require both CSRF header and same-origin Origin', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const reused = await apiRequest(fixture.dependencies, '/api/auth/csrf', {
      csrfCookie: csrf.cookie,
    });
    assert.equal((await reused.json()).csrfToken, csrf.token);
    const noHeader = await apiRequest(fixture.dependencies, '/api/templates', {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      body: { template_name: 'T', default_subject: 'S', default_body: 'B' },
    });
    assert.equal(noHeader.status, 403);
    const badOrigin = await apiRequest(fixture.dependencies, '/api/templates', {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      headers: { Origin: 'https://attacker.test' },
      body: { template_name: 'T', default_subject: 'S', default_body: 'B' },
    });
    assert.equal(badOrigin.status, 403);
    const accepted = await apiRequest(fixture.dependencies, '/api/templates', {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { template_name: 'T', default_subject: 'S', default_body: 'B' },
    });
    assert.equal(accepted.status, 201);
  } finally {
    fixture.close();
  }
});

test('users cannot read or modify another user templates or campaigns', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-a');
    await seedUser(fixture.db, 'user-b');
    const userA = await sessionFor('user-a');
    const userB = await sessionFor('user-b');
    const csrf = await csrfFor(fixture.dependencies);

    const otherTemplate = await apiRequest(fixture.dependencies, '/api/templates', {
      method: 'POST',
      userCookie: userB,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: {
        template_name: 'Private',
        default_subject: 'Hello',
        default_body: 'Body',
      },
    });
    const templateId = (await otherTemplate.json()).template.id;
    assert.deepEqual(
      (
        await (
          await apiRequest(fixture.dependencies, '/api/templates', {
            userCookie: userA,
          })
        ).json()
      ).templates,
      [],
    );
    assert.equal(
      (
        await apiRequest(fixture.dependencies, `/api/templates/${templateId}`, {
          method: 'PUT',
          userCookie: userA,
          csrfCookie: csrf.cookie,
          csrfToken: csrf.token,
          body: {
            template_name: 'stolen',
            default_subject: 'x',
            default_body: 'y',
          },
        })
      ).status,
      404,
    );

    const campaign = await createCampaign(fixture, userB, csrf, {
      recipients: ['person@acme.com'],
    });
    const campaignId = campaign.body.campaign.id;
    assert.equal(
      (
        await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}`, {
          userCookie: userA,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/campaigns', {
          method: 'POST',
          userCookie: userA,
          csrfCookie: csrf.cookie,
          csrfToken: csrf.token,
          body: {
            campaign_name: "Try another user's template",
            template_id: templateId,
            recipients: [{ email: 'x@acme.com' }],
          },
        })
      ).status,
      404,
    );
  } finally {
    fixture.close();
  }
});

test('campaign input rejects header injection, unresolved placeholders, and duplicate recipients', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const base = {
      campaign_name: 'Bad',
      default_subject: 'Hello',
      default_body: 'Body',
      recipients: [
        {
          email: 'a@acme.com',
          final_subject: 'Hi\r\nBcc: x@example.com',
          final_body: 'Body',
        },
      ],
    };
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/campaigns', {
          method: 'POST',
          userCookie,
          csrfCookie: csrf.cookie,
          csrfToken: csrf.token,
          body: base,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/campaigns', {
          method: 'POST',
          userCookie,
          csrfCookie: csrf.cookie,
          csrfToken: csrf.token,
          body: {
            ...base,
            recipients: [
              {
                email: 'a@acme.com',
                final_subject: '[Name]',
                final_body: 'Body',
              },
            ],
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/campaigns', {
          method: 'POST',
          userCookie,
          csrfCookie: csrf.cookie,
          csrfToken: csrf.token,
          body: {
            ...base,
            recipients: [{ email: 'a@acme.com' }, { email: 'A@ACME.COM' }],
          },
        })
      ).status,
      400,
    );
  } finally {
    fixture.close();
  }
});

test('MOCK send-batch is capped at eight, idempotent, and concurrent claims are exclusive', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const emails = Array.from({ length: 10 }, (_, index) => `person${index}@acme.com`);
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: emails,
    });
    assert.equal(created.response.status, 201);
    const campaignId = created.body.campaign.id;

    const send = () =>
      apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
        method: 'POST',
        userCookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
        body: { batchSize: 99 },
      });
    const concurrent = await Promise.all([send(), send()]);
    const processed = await Promise.all(
      concurrent.map(async (response) => (await response.json()).processed),
    );
    assert.equal(
      processed.reduce((sum, value) => sum + value, 0),
      10,
    );
    assert.ok(processed.every((value) => value <= 8));
    const third = await send();
    assert.equal((await third.json()).processed, 0);
    const campaign = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}`, { userCookie });
    const details = await campaign.json();
    assert.equal(details.recipients.filter((row) => row.sending_status === 'SENT').length, 10);
    assert.equal(fixture.google.sentMessages.length, 0);
  } finally {
    fixture.close();
  }
});

test('Gmail batch refreshes once, never auto-resends UNKNOWN, and retry-failed excludes SENT', async () => {
  const fixture = await setup({ emailMode: 'GMAIL', dailySendLimit: 10 });
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const timestamp = new Date(Date.parse('2026-11-20T12:00:00.000Z') - 600_000).toISOString();
    const encrypted = await (
      await import('../../shared/core/crypto.ts')
    ).encryptSecret('stored-refresh-token', ENCRYPTION_KEY);
    await fixture.db
      .prepare(
        `INSERT INTO connected_email_accounts
        (id, user_id, provider, email_address, encrypted_refresh_token, token_iv, key_version, scopes, connection_status)
       VALUES ('account-1', 'user-1', 'GMAIL', 'sender@example.com', ?, ?, ?, 'gmail.send', 'CONNECTED')`,
      )
      .bind(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion)
      .run();
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: ['a@acme.com', 'b@acme.com'],
    });
    const campaignId = created.body.campaign.id;
    await fixture.db
      .prepare(
        `UPDATE campaign_recipients SET sending_status = 'PROCESSING', updated_at = ?
       WHERE campaign_id = ? AND recipient_email = 'b@acme.com'`,
      )
      .bind(timestamp, campaignId)
      .run();

    const response = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { batchSize: 8 },
    });
    assert.equal(response.status, 200);
    assert.equal(fixture.google.refreshCalls.length, 1);
    assert.equal(fixture.google.sentMessages.length, 1);
    const states = await fixture.db
      .prepare(
        `SELECT recipient_email, sending_status FROM campaign_recipients
       WHERE campaign_id = ? ORDER BY recipient_email`,
      )
      .bind(campaignId)
      .all();
    assert.deepEqual(
      states.results.map((row) => row.sending_status),
      ['SENT', 'UNKNOWN'],
    );

    const retry = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/retry-failed`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
    });
    assert.deepEqual(await retry.json(), { retried: 0 });
    const sendAgain = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: {},
    });
    assert.equal((await sendAgain.json()).processed, 0);
    assert.equal(fixture.google.sentMessages.length, 1);
    assert.equal(fixture.google.refreshCalls.length, 1);
  } finally {
    fixture.close();
  }
});

test('daily send limit is enforced from stored SENT recipients', async () => {
  const fixture = await setup({ dailySendLimit: 1 });
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: ['a@acme.com', 'b@acme.com'],
    });
    const campaignId = created.body.campaign.id;
    const first = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { batchSize: 8 },
    });
    assert.equal((await first.json()).processed, 1);
    const second = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { batchSize: 8 },
    });
    assert.equal(second.status, 429);
  } finally {
    fixture.close();
  }
});

test('daily limits reserve quota during concurrent batches', async () => {
  const fixture = await setup({ dailySendLimit: 1 });
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: ['a@acme.com', 'b@acme.com'],
    });
    const url = `/api/campaigns/${created.body.campaign.id}/send-batch`;
    const send = () =>
      apiRequest(fixture.dependencies, url, {
        method: 'POST',
        userCookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
        body: { batchSize: 8 },
      });
    const responses = await Promise.all([send(), send()]);
    const processed = await Promise.all(
      responses.map(async (response) => {
        const body = await response.json();
        return body.processed ?? 0;
      }),
    );
    assert.equal(
      processed.reduce((sum, value) => sum + value, 0),
      1,
    );
    assert.equal(
      (
        await fixture.db
          .prepare(
            `SELECT COUNT(*) AS count FROM campaign_recipients
       WHERE sending_status = 'SENT'`,
          )
          .first()
      ).count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('retry-failed retries only FAILED recipients and never resends SENT recipients', async () => {
  const fixture = await setup({ emailMode: 'GMAIL' });
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const encrypted = await (
      await import('../../shared/core/crypto.ts')
    ).encryptSecret('stored-refresh-token', ENCRYPTION_KEY);
    await fixture.db
      .prepare(
        `INSERT INTO connected_email_accounts
        (id, user_id, provider, email_address, encrypted_refresh_token, token_iv, key_version, scopes, connection_status)
       VALUES ('account-1', 'user-1', 'GMAIL', 'sender@example.com', ?, ?, ?, 'gmail.send', 'CONNECTED')`,
      )
      .bind(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion)
      .run();
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: ['a@acme.com', 'b@acme.com'],
    });
    const campaignId = created.body.campaign.id;
    let sendCount = 0;
    fixture.google.sendGmailMessage = async (message) => {
      fixture.google.sentMessages.push(message);
      sendCount += 1;
      if (sendCount === 1) throw new Error('provider private error');
      return { id: `gmail-${sendCount}` };
    };

    const send = (body = {}) =>
      apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
        method: 'POST',
        userCookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
        body,
      });
    assert.equal((await (await send()).json()).processed, 2);
    const retry = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/retry-failed`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
    });
    assert.deepEqual(await retry.json(), { retried: 1 });
    assert.equal((await (await send()).json()).processed, 1);
    assert.equal((await (await send()).json()).processed, 0);
    assert.equal(fixture.google.sentMessages.length, 3);
    assert.equal(
      (
        await fixture.db
          .prepare(
            `SELECT COUNT(*) AS count FROM campaign_recipients
       WHERE campaign_id = ? AND sending_status = 'SENT'`,
          )
          .bind(campaignId)
          .first()
      ).count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('resume batch validation requires PDF magic and enforces 1.5 MB before claiming', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: ['a@acme.com'],
    });
    const campaignId = created.body.campaign.id;
    const invalid = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: {
        attachment: {
          filename: 'resume.pdf',
          contentType: 'application/pdf',
          base64: btoa('not pdf'),
        },
      },
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (
        await fixture.db
          .prepare('SELECT sending_status FROM campaign_recipients WHERE campaign_id = ?')
          .bind(campaignId)
          .first()
      ).sending_status,
      'PENDING',
    );

    const oversized = 'JVBERi0x' + 'A'.repeat(2_100_000);
    const large = await apiRequest(fixture.dependencies, `/api/campaigns/${campaignId}/send-batch`, {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: {
        attachment: {
          filename: 'resume.pdf',
          contentType: 'application/pdf',
          base64: oversized,
        },
      },
    });
    assert.ok(large.status === 413 || large.status === 400);
  } finally {
    fixture.close();
  }
});

test('Gmail refresh token is encrypted in storage and disconnect revokes it', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const start = await apiRequest(fixture.dependencies, '/api/auth/gmail/connect', { userCookie });
    assert.equal(start.status, 302);
    assert.match(fixture.google.authorizationRequests.at(-1).scopes.join(' '), /gmail\.send/);
    assert.equal(fixture.google.authorizationRequests.at(-1).accessType, 'offline');
    assert.equal(fixture.google.authorizationRequests.at(-1).prompt, 'consent');

    const oauthCookie = start.headers
      .getSetCookie()
      .find((value) => value.startsWith('reachflow_oauth='))
      .split(';', 1)[0];
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    const callback = await handleApiRequest(
      new Request(`${APP_URL}/api/auth/gmail/callback?code=code&state=${state}`, {
        headers: { Cookie: `${userCookie}; ${oauthCookie}` },
      }),
      fixture.dependencies,
    );
    assert.equal(callback.status, 302);
    const account = await fixture.db
      .prepare('SELECT * FROM connected_email_accounts WHERE user_id = ?')
      .bind('user-1')
      .first();
    assert.ok(account.encrypted_refresh_token);
    assert.notEqual(account.encrypted_refresh_token, 'test-refresh-token');
    const { decryptSecret } = await import('../../shared/core/crypto.ts');
    assert.equal(
      await decryptSecret(
        {
          ciphertext: account.encrypted_refresh_token,
          iv: account.token_iv,
          keyVersion: account.key_version,
        },
        ENCRYPTION_KEY,
      ),
      'test-refresh-token',
    );

    const csrf = await csrfFor(fixture.dependencies);
    const disconnected = await apiRequest(fixture.dependencies, '/api/auth/gmail/disconnect', {
      method: 'POST',
      userCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { accountId: account.id },
    });
    assert.equal(disconnected.status, 200);
    assert.deepEqual(fixture.google.revokedTokens, ['test-refresh-token']);
    assert.equal(
      (
        await fixture.db
          .prepare('SELECT connection_status FROM connected_email_accounts WHERE id = ?')
          .bind(account.id)
          .first()
      ).connection_status,
      'REVOKED',
    );
  } finally {
    fixture.close();
  }
});

test('admin endpoints are role-protected and invitation responses do not expose stored hashes', async () => {
  const fixture = await setup();
  try {
    await seedUser(fixture.db, 'admin', { role: 'ADMIN' });
    await seedUser(fixture.db, 'user-1');
    const adminCookie = await sessionFor('admin');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    assert.equal(
      (
        await apiRequest(fixture.dependencies, '/api/admin/users', {
          userCookie,
        })
      ).status,
      403,
    );

    const inviteResponse = await apiRequest(fixture.dependencies, '/api/admin/invitations', {
      method: 'POST',
      userCookie: adminCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { email: 'new@example.com' },
    });
    assert.equal(inviteResponse.status, 201);
    const body = await inviteResponse.json();
    const token = new URL(body.invitation.link).searchParams.get('invite');
    const stored = await fixture.db
      .prepare('SELECT invitation_token_hash FROM invitations WHERE id = ?')
      .bind(body.invitation.id)
      .first();
    assert.equal(stored.invitation_token_hash, await hashToken(token));
    assert.equal(JSON.stringify(body).includes(stored.invitation_token_hash), false);

    const registrationMode = await apiRequest(fixture.dependencies, '/api/admin/registration-mode', {
      method: 'POST',
      userCookie: adminCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { mode: 'PUBLIC' },
    });
    assert.equal((await registrationMode.json()).registrationMode, 'PUBLIC');
    const disabled = await apiRequest(fixture.dependencies, '/api/admin/users/user-1/status', {
      method: 'POST',
      userCookie: adminCookie,
      csrfCookie: csrf.cookie,
      csrfToken: csrf.token,
      body: { status: 'DISABLED' },
    });
    assert.equal(disabled.status, 200);
    assert.equal((await apiRequest(fixture.dependencies, '/api/campaigns', { userCookie })).status, 401);
  } finally {
    fixture.close();
  }
});

test('Gmail failures return safe responses without logging bodies, tokens, or provider errors', async () => {
  const fixture = await setup({ emailMode: 'GMAIL' });
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...values) => logs.push(values.join(' '));
  console.log = (...values) => logs.push(values.join(' '));
  try {
    await seedUser(fixture.db, 'user-1');
    const userCookie = await sessionFor('user-1');
    const csrf = await csrfFor(fixture.dependencies);
    const created = await createCampaign(fixture, userCookie, csrf, {
      recipients: ['a@acme.com'],
    });
    const response = await apiRequest(
      fixture.dependencies,
      `/api/campaigns/${created.body.campaign.id}/send-batch`,
      {
        method: 'POST',
        userCookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
        body: {},
      },
    );

    assert.equal(response.status, 409);
    assert.equal(JSON.stringify(await response.json()).includes('test-refresh-token'), false);
    assert.deepEqual(logs, []);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    fixture.close();
  }
});

test('delete single, selected and all history stays scoped and blocks active sends', async () => {
  const f = await setup();
  try {
    await seedUser(f.db, 'a');
    await seedUser(f.db, 'b');
    const cookie = await sessionFor('a');
    const csrf = await csrfFor(f.dependencies);
    const write = (path, method, body) =>
      apiRequest(f.dependencies, path, {
        method,
        body,
        userCookie: cookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
      });
    const create = async () => (await createCampaign(f, cookie, csrf)).body.campaign.id;
    const other = (await createCampaign(f, await sessionFor('b'), csrf)).body.campaign.id;
    assert.equal((await write(`/api/campaigns/${other}`, 'DELETE')).status, 404);
    const id = await create();
    await f.db.prepare(`UPDATE campaigns SET status='SENDING' WHERE id=?`).bind(id).run();
    assert.equal((await write(`/api/campaigns/${id}`, 'DELETE')).status, 409);
    assert.equal((await write('/api/campaigns', 'DELETE', { all: true })).status, 409);
    await write(`/api/campaigns/${id}/cancel`, 'POST', {});
    assert.equal((await write(`/api/campaigns/${id}`, 'DELETE')).status, 200);
    assert.equal(
      (
        await f.db
          .prepare('SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id=?')
          .bind(id)
          .first()
      ).n,
      0,
    );
    const ids = [await create(), await create()];
    assert.equal((await write('/api/campaigns', 'DELETE', { ids: [...ids, other] })).status, 404);
    assert.equal((await write('/api/campaigns', 'DELETE', { ids })).status, 200);
    await create();
    assert.equal((await write('/api/campaigns', 'DELETE', { all: true })).status, 200);
    assert.equal(
      (await f.db.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE user_id=?').bind('a').first()).n,
      0,
    );
    assert.ok(await f.db.prepare('SELECT id FROM campaigns WHERE id=?').bind(other).first());
  } finally {
    f.close();
  }
});

test('deleting a message is owner scoped and keeps its history', async () => {
  const f = await setup();
  try {
    await seedUser(f.db, 'a');
    await seedUser(f.db, 'b');
    await f.db
      .prepare(
        `INSERT INTO email_templates(id,user_id,template_name,default_subject,default_body)
          VALUES ('message','a','Hello','Hello','Body')`,
      )
      .run();
    const csrf = await csrfFor(f.dependencies);
    const created = await createCampaign(f, await sessionFor('a'), csrf);
    await f.db
      .prepare('UPDATE campaigns SET template_id=? WHERE id=?')
      .bind('message', created.body.campaign.id)
      .run();
    for (const [user, status] of [
      ['b', 404],
      ['a', 200],
    ]) {
      assert.equal(
        (
          await apiRequest(f.dependencies, '/api/templates/message', {
            method: 'DELETE',
            userCookie: await sessionFor(user),
            csrfCookie: csrf.cookie,
            csrfToken: csrf.token,
          })
        ).status,
        status,
      );
    }
    const history = await f.db
      .prepare('SELECT template_id FROM campaigns WHERE id=?')
      .bind(created.body.campaign.id)
      .first();
    assert.equal(history.template_id, null);
  } finally {
    f.close();
  }
});

test('permanent daily counts survive deletion, trim batches and contact warnings follow history', async () => {
  const f = await setup({ dailySendLimit: 2 });
  try {
    await seedUser(f.db, 'a');
    const cookie = await sessionFor('a');
    const csrf = await csrfFor(f.dependencies);
    const call = (path, method, body) =>
      apiRequest(f.dependencies, path, {
        method,
        body,
        userCookie: cookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
      });
    const id = (await createCampaign(f, cookie, csrf, { recipients: ['a@acme.com'] })).body.campaign.id;
    await call(`/api/campaigns/${id}/send-batch`, 'POST', {});
    const contacts = await call('/api/campaigns/contact-history', 'POST', {
      emails: ['a@acme.com'],
    });
    assert.equal((await contacts.json()).contacts.length, 1);
    await call(`/api/campaigns/${id}`, 'DELETE');
    assert.equal(
      (
        await (
          await call('/api/campaigns/contact-history', 'POST', {
            emails: ['a@acme.com'],
          })
        ).json()
      ).contacts.length,
      0,
    );
    const next = (await createCampaign(f, cookie, csrf)).body.campaign.id;
    assert.equal(
      (
        await (
          await call(`/api/campaigns/${next}/send-batch`, 'POST', {
            batchSize: 8,
          })
        ).json()
      ).processed,
      1,
    );
    await call(`/api/campaigns/${next}/cancel`, 'POST', {});
    await call('/api/campaigns', 'DELETE', { all: true });
    const third = (await createCampaign(f, cookie, csrf)).body.campaign.id;
    assert.equal((await call(`/api/campaigns/${third}/send-batch`, 'POST', {})).status, 429);
    assert.equal(
      (await f.db.prepare('SELECT sent_count FROM daily_send_counts WHERE user_id=?').bind('a').first())
        .sent_count,
      2,
    );
  } finally {
    f.close();
  }
});

test('account and admin user removal revoke Gmail, cascade all data and prevent self removal', async () => {
  const f = await setup();
  try {
    await seedUser(f.db, 'admin', { role: 'ADMIN' });
    await seedUser(f.db, 'a');
    const csrf = await csrfFor(f.dependencies);
    const cookie = await sessionFor('a');
    const id = (await createCampaign(f, cookie, csrf)).body.campaign.id;
    const encrypted = await (
      await import('../../shared/core/crypto.ts')
    ).encryptSecret('revoke-me', ENCRYPTION_KEY);
    await f.db
      .prepare(
        `INSERT INTO connected_email_accounts
          (id,user_id,provider,email_address,encrypted_refresh_token,token_iv,key_version,scopes,connection_status)
          VALUES ('gmail','a','GMAIL','a@gmail.com',?,?,?,'gmail.send','CONNECTED')`,
      )
      .bind(encrypted.ciphertext, encrypted.iv, encrypted.keyVersion)
      .run();
    await f.db
      .prepare(
        `INSERT INTO invitations(id,email,invitation_token_hash,invited_by,expires_at)
          VALUES ('invite','new@acme.com','hash','a','2027-01-01')`,
      )
      .run();
    await f.db
      .prepare(
        `INSERT INTO email_templates(id,user_id,template_name,default_subject,default_body)
          VALUES ('t','a','Name','Hello','Body')`,
      )
      .run();
    await f.db.prepare(`INSERT INTO daily_send_counts VALUES ('a','2026-11-20',1)`).run();
    const call = (path, userCookie, body) =>
      apiRequest(f.dependencies, path, {
        method: 'DELETE',
        body,
        userCookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
      });
    assert.equal((await call('/api/auth/account', cookie, { confirmation: 'no' })).status, 400);
    await f.db.prepare(`UPDATE campaigns SET status='SENDING' WHERE id=?`).bind(id).run();
    assert.equal((await call('/api/auth/account', cookie, { confirmation: 'DELETE' })).status, 409);
    await f.db.prepare(`UPDATE campaigns SET status='COMPLETED' WHERE id=?`).bind(id).run();
    const response = await call('/api/auth/account', cookie, {
      confirmation: 'DELETE',
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.deepEqual(f.google.revokedTokens, ['revoke-me']);
    for (const table of [
      'campaigns',
      'campaign_recipients',
      'email_templates',
      'connected_email_accounts',
      'daily_send_counts',
      'invitations',
    ]) {
      assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0, table);
    }
    const adminCookie = await sessionFor('admin');
    assert.equal((await call('/api/admin/users/admin', adminCookie)).status, 403);
    await seedUser(f.db, 'b');
    await createCampaign(f, await sessionFor('b'), csrf);
    assert.equal((await call('/api/admin/users/b', adminCookie)).status, 200);
    assert.equal(await f.db.prepare(`SELECT id FROM users WHERE id='b'`).first(), null);
    assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM campaigns`).first()).n, 0);
    await f.db
      .prepare(
        `INSERT INTO invitations(id,email,invitation_token_hash,invited_by,expires_at)
          VALUES ('admin-invite','new@acme.com','hash','admin','2027-01-01')`,
      )
      .run();
    assert.equal((await call('/api/admin/invitations/admin-invite', adminCookie)).status, 200);
  } finally {
    f.close();
  }
});

test('server accepts cold emails and rechecks every final subject and body', async () => {
  const f = await setup();
  try {
    await seedUser(f.db, 'a');
    const cookie = await sessionFor('a');
    const csrf = await csrfFor(f.dependencies);
    const cold = await createCampaign(f, cookie, csrf, {
      role: '',
      jobId: '',
      defaultSubject: 'A quick introduction about [Role]',
      defaultBody: 'Hi [Name] at [Company]\nRole: [Role]\nJob: [JobId]',
    });
    assert.equal(cold.response.status, 201);
    const person = await f.db
      .prepare('SELECT final_subject, final_body FROM campaign_recipients WHERE campaign_id=?')
      .bind(cold.body.campaign.id)
      .first();
    assert.equal(person.final_body.includes('Role:'), false);
    assert.equal(person.final_subject, 'A quick introduction about');
    for (const bad of ['', '[Name]', '[Company]', '[Role]', '[JobId]', 'Hi\r\nBcc: other@acme.com']) {
      const response = await apiRequest(f.dependencies, '/api/campaigns', {
        method: 'POST',
        userCookie: cookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
        body: {
          campaign_name: 'Cold',
          default_subject: 'Hello',
          default_body: 'Body',
          recipients: [{ email: 'a@acme.com', final_subject: bad, final_body: 'Body' }],
        },
      });
      assert.equal(response.status, 400);
    }
    const literal = '{'.repeat(2) + ' ordinary text';
    const accepted = await createCampaign(f, cookie, csrf, {
      defaultSubject: literal,
      defaultBody: literal,
    });
    assert.equal(accepted.response.status, 201);
    for (const field of ['recipient_name', 'recipient_company']) {
      const response = await apiRequest(f.dependencies, '/api/campaigns', {
        method: 'POST',
        userCookie: cookie,
        csrfCookie: csrf.cookie,
        csrfToken: csrf.token,
        body: {
          campaign_name: 'Check',
          default_subject: 'Hi',
          default_body: 'Hello',
          recipients: [{ email: 'alex@acme.com', [field]: '' }],
        },
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Fill in the (name|company)/);
    }
  } finally {
    f.close();
  }
});
