import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('0002 follows 0001, backfills counts, enforces uniqueness and cascades only with user deletion', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of ['0001_initial_schema.sql', '0002_daily_send_counts.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(sql, /\b(BEGIN|COMMIT|PRAGMA)\b/i);
      if (name.startsWith('0002')) {
        db.exec(`INSERT INTO users (id,google_id,email,name) VALUES ('u','g','u@acme.com','U');
          INSERT INTO campaigns (id,user_id,campaign_name) VALUES ('c','u','Send');
          INSERT INTO campaign_recipients (id,campaign_id,recipient_email,final_subject,final_body,sending_status,sent_at)
          VALUES ('r','c','r@acme.com','Hi','Body','SENT','2026-11-20T12:00:00.000Z');`);
      }
      db.exec(sql);
    }
    assert.equal(db.prepare('SELECT sent_count FROM daily_send_counts').get().sent_count, 1);
    assert.throws(() => db.exec(`INSERT INTO daily_send_counts VALUES ('u','2026-11-20',2)`), /UNIQUE/);
    db.exec(`DELETE FROM campaigns`);
    assert.equal(db.prepare('SELECT sent_count FROM daily_send_counts').get().sent_count, 1);
    db.exec(`DELETE FROM users`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_send_counts').get().n, 0);
  } finally {
    db.close();
  }
});
