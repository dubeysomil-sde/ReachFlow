import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/index.ts';

const schema = await readFile(
  new URL('../migrations/0001_initial_schema.sql', import.meta.url),
  'utf8',
);

function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  return db;
}

function insertUser(db, id, email = `${id}@example.com`) {
  db.prepare(
    'INSERT INTO users (id, google_id, email, name) VALUES (?, ?, ?, ?)',
  ).run(id, `google-${id}`, email, `User ${id}`);
}

function insertCampaign(db, id, userId, name = `Campaign ${id}`) {
  db.prepare(
    'INSERT INTO campaigns (id, user_id, campaign_name) VALUES (?, ?, ?)',
  ).run(id, userId, name);
}

function insertRecipient(db, id, campaignId, email) {
  db.prepare(
    `INSERT INTO campaign_recipients
      (id, campaign_id, recipient_email, final_subject, final_body)
      VALUES (?, ?, ?, ?, ?)`,
  ).run(id, campaignId, email, 'Hello', 'Message');
}

test('GET /api/health returns the ReachFlow health response', async () => {
  const response = await worker.fetch(
    new Request('http://localhost/api/health'),
    { ENVIRONMENT: 'development' },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'UP',
    application: 'ReachFlow',
  });
});

test('schema creates exactly the requested tables and seeds invite-only registration', () => {
  const db = createDatabase();
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    assert.deepEqual(tables, [
      'app_settings',
      'campaign_recipients',
      'campaigns',
      'connected_email_accounts',
      'email_templates',
      'invitations',
      'users',
    ]);
    assert.equal(
      db.prepare('SELECT value FROM app_settings WHERE key = ?')
        .get('registration_mode').value,
      'INVITE_ONLY',
    );
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_campaigns_user_created_at',
           'idx_campaign_recipients_campaign_sending_status',
           'idx_email_templates_user',
           'idx_invitations_email'
         )`,
      ).get().count,
      4,
    );
  } finally {
    db.close();
  }
});

test('default timestamps are UTC ISO text and user defaults are applied', () => {
  const db = createDatabase();
  try {
    insertUser(db, 'user-1');
    const user = db.prepare(
      'SELECT role, status, created_at, updated_at FROM users WHERE id = ?',
    ).get('user-1');

    assert.equal(user.role, 'USER');
    assert.equal(user.status, 'ACTIVE');
    assert.match(user.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(user.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    db.close();
  }
});

test('unique constraints reject duplicate users, accounts, templates, invitations, and recipients', () => {
  const db = createDatabase();
  try {
    insertUser(db, 'user-1');
    assert.throws(() => {
      db.prepare(
        'INSERT INTO users (id, google_id, email, name) VALUES (?, ?, ?, ?)',
      ).run('user-2', 'google-user-2', 'user-1@example.com', 'Duplicate email');
    }, /UNIQUE constraint failed/);
    assert.throws(() => {
      db.prepare(
        'INSERT INTO users (id, google_id, email, name) VALUES (?, ?, ?, ?)',
      ).run('user-2', 'google-user-1', 'user-2@example.com', 'Duplicate Google ID');
    }, /UNIQUE constraint failed/);

    db.prepare(
      `INSERT INTO connected_email_accounts
        (id, user_id, provider, email_address, encrypted_refresh_token, token_iv,
         key_version, scopes, connection_status)
       VALUES (?, ?, 'GMAIL', ?, 'ciphertext', 'iv', 'v1', 'scope', 'CONNECTED')`,
    ).run('account-1', 'user-1', 'sender@example.com');
    assert.throws(() => {
      db.prepare(
        `INSERT INTO connected_email_accounts
          (id, user_id, provider, email_address, encrypted_refresh_token, token_iv,
           key_version, scopes, connection_status)
         VALUES (?, ?, 'GMAIL', ?, 'ciphertext', 'iv', 'v1', 'scope', 'CONNECTED')`,
      ).run('account-2', 'user-1', 'sender@example.com');
    }, /UNIQUE constraint failed/);

    db.prepare(
      `INSERT INTO email_templates
        (id, user_id, template_name, default_subject, default_body)
       VALUES ('template-1', 'user-1', 'Intro', 'Hello', 'Message')`,
    ).run();
    assert.throws(() => {
      db.prepare(
        `INSERT INTO email_templates
          (id, user_id, template_name, default_subject, default_body)
         VALUES ('template-2', 'user-1', 'Intro', 'Hello', 'Message')`,
      ).run();
    }, /UNIQUE constraint failed/);

    insertCampaign(db, 'campaign-1', 'user-1');
    insertRecipient(db, 'recipient-1', 'campaign-1', 'person@example.com');
    assert.throws(
      () => insertRecipient(db, 'recipient-2', 'campaign-1', 'person@example.com'),
      /UNIQUE constraint failed/,
    );

    const insertInvitation = db.prepare(
      `INSERT INTO invitations
        (id, email, invitation_token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, 'user-1', '2030-01-01T00:00:00.000Z')`,
    );
    insertInvitation.run('invite-1', 'invitee@example.com', 'hash-1');
    assert.throws(
      () => insertInvitation.run('invite-2', 'other@example.com', 'hash-1'),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('CHECK constraints reject invalid roles, statuses, providers, and recipient flags', () => {
  const db = createDatabase();
  try {
    assert.throws(() => {
      db.prepare(
        `INSERT INTO users (id, google_id, email, name, role)
         VALUES ('user-1', 'google-1', 'user@example.com', 'User', 'OWNER')`,
      ).run();
    }, /CHECK constraint failed/);

    insertUser(db, 'user-1');
    assert.throws(() => {
      db.prepare(
        `INSERT INTO connected_email_accounts
          (id, user_id, provider, email_address, encrypted_refresh_token, token_iv,
           key_version, scopes, connection_status)
         VALUES ('account-1', 'user-1', 'OUTLOOK', 'sender@example.com',
           'ciphertext', 'iv', 'v1', 'scope', 'CONNECTED')`,
      ).run();
    }, /CHECK constraint failed/);

    assert.throws(
      () => db.prepare(
        `INSERT INTO campaigns (id, user_id, campaign_name, status)
         VALUES ('campaign-1', 'user-1', 'Campaign', 'PAUSED')`,
      ).run(),
      /CHECK constraint failed/,
    );

    insertCampaign(db, 'campaign-1', 'user-1');
    assert.throws(() => {
      db.prepare(
        `INSERT INTO campaign_recipients
          (id, campaign_id, recipient_email, use_custom_subject, final_subject, final_body)
         VALUES ('recipient-1', 'campaign-1', 'person@example.com', 2, 'Hello', 'Message')`,
      ).run();
    }, /CHECK constraint failed/);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO campaign_recipients
          (id, campaign_id, recipient_email, sending_status, final_subject, final_body)
         VALUES ('recipient-2', 'campaign-1', 'other@example.com', 'QUEUED', 'Hello', 'Message')`,
      ).run();
    }, /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test('foreign keys cascade user and campaign deletion and null deleted templates', () => {
  const db = createDatabase();
  try {
    insertUser(db, 'user-1');
    db.prepare(
      `INSERT INTO email_templates
        (id, user_id, template_name, default_subject, default_body)
       VALUES ('template-1', 'user-1', 'Intro', 'Hello', 'Message')`,
    ).run();
    insertCampaign(db, 'campaign-1', 'user-1');
    insertRecipient(db, 'recipient-1', 'campaign-1', 'person@example.com');
    db.prepare(
      `UPDATE campaigns SET template_id = 'template-1' WHERE id = 'campaign-1'`,
    ).run();

    db.prepare('DELETE FROM email_templates WHERE id = ?').run('template-1');
    assert.equal(
      db.prepare('SELECT template_id FROM campaigns WHERE id = ?')
        .get('campaign-1').template_id,
      null,
    );

    insertRecipient(db, 'recipient-2', 'campaign-1', 'second@example.com');
    db.prepare('DELETE FROM campaigns WHERE id = ?').run('campaign-1');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ?')
        .get('campaign-1').count,
      0,
    );

    insertCampaign(db, 'campaign-2', 'user-1');
    insertRecipient(db, 'recipient-3', 'campaign-2', 'third@example.com');
    db.prepare(
      `INSERT INTO invitations
        (id, email, invitation_token_hash, invited_by, expires_at)
       VALUES ('invite-1', 'invitee@example.com', 'hash-1', 'user-1', '2030-01-01T00:00:00.000Z')`,
    ).run();
    assert.throws(
      () => db.prepare('DELETE FROM users WHERE id = ?').run('user-1'),
      /FOREIGN KEY constraint failed/,
    );
    db.prepare('DELETE FROM invitations WHERE id = ?').run('invite-1');
    db.prepare('DELETE FROM users WHERE id = ?').run('user-1');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaigns WHERE user_id = ?')
        .get('user-1').count,
      0,
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM campaign_recipients')
        .get().count,
      0,
    );
  } finally {
    db.close();
  }
});

test('campaign queries scoped to a user do not return another user campaigns', () => {
  const db = createDatabase();
  try {
    insertUser(db, 'user-1');
    insertUser(db, 'user-2');
    insertCampaign(db, 'campaign-1', 'user-1', 'First user campaign');
    insertCampaign(db, 'campaign-2', 'user-2', 'Second user campaign');

    const campaigns = db.prepare(
      `SELECT id, campaign_name
       FROM campaigns
       WHERE user_id = ?
       ORDER BY id`,
    ).all('user-1');

    assert.deepEqual(
      campaigns.map(({ id, campaign_name }) => ({ id, campaign_name })),
      [{ id: 'campaign-1', campaign_name: 'First user campaign' }],
    );
    assert.equal(campaigns.some((campaign) => campaign.id === 'campaign-2'), false);
  } finally {
    db.close();
  }
});

test('recipient statuses can be updated by recipient idempotently and independently', () => {
  const db = createDatabase();
  try {
    insertUser(db, 'user-1');
    insertCampaign(db, 'campaign-1', 'user-1');
    insertRecipient(db, 'recipient-1', 'campaign-1', 'first@example.com');
    insertRecipient(db, 'recipient-2', 'campaign-1', 'second@example.com');

    const markSent = db.prepare(
      `UPDATE campaign_recipients
       SET sending_status = 'SENT', gmail_message_id = ?, sent_at = ?
       WHERE id = ? AND sending_status IN ('PENDING', 'PROCESSING')`,
    );
    assert.equal(
      markSent.run('gmail-message-1', '2026-11-20T00:00:00.000Z', 'recipient-1')
        .changes,
      1,
    );
    assert.equal(
      markSent.run('gmail-message-1', '2026-11-20T00:00:00.000Z', 'recipient-1')
        .changes,
      0,
    );
    assert.equal(
      db.prepare('SELECT sending_status FROM campaign_recipients WHERE id = ?')
        .get('recipient-1').sending_status,
      'SENT',
    );
    assert.equal(
      db.prepare('SELECT sending_status FROM campaign_recipients WHERE id = ?')
        .get('recipient-2').sending_status,
      'PENDING',
    );
  } finally {
    db.close();
  }
});
