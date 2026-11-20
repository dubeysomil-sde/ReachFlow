import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../src/config.ts';
import worker from '../src/index.ts';
import {
  FetchGoogleClient,
  GoogleAccessExpiredError,
  GoogleInvalidTokenError,
} from '../src/google/googleClient.ts';

const valid = {
  EMAIL_MODE: 'GMAIL',
  APP_BASE_URL: 'https://reachflow.example',
  GOOGLE_CLIENT_ID: 'test-id',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: 'a-session-test-key-at-least-32-characters',
  TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)),
};

test('production requires explicit email mode, origin and all secrets with clear safe errors', async () => {
  assert.equal(readConfig(valid).emailMode, 'GMAIL');
  for (const key of Object.keys(valid)) {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => readConfig(env), new RegExp(key));
    const response = await worker.fetch(new Request('https://reachflow.example/api/health'), env);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, new RegExp(key));
  }
  assert.throws(() => readConfig({ ...valid, TOKEN_ENCRYPTION_KEY: 'bad' }), /32 bytes/);
  assert.throws(() => readConfig({ ...valid, SESSION_SECRET: 'short' }), /32 characters/);
  assert.throws(() => readConfig({ ...valid, APP_BASE_URL: 'http://example.com' }), /HTTPS/);
});

test('fetch Google client classifies invalid grants/tokens without exposing provider responses', async () => {
  const original = globalThis.fetch;
  const google = new FetchGoogleClient({ clientId: 'test', clientSecret: 'test' });
  try {
    globalThis.fetch = async () =>
      Response.json({ error: 'invalid_grant', error_description: 'private' }, { status: 400 });
    await assert.rejects(google.refreshAccessToken('fake'), GoogleAccessExpiredError);
    await assert.rejects(
      google.sendGmailMessage({ raw: 'fake', accessToken: 'fake' }),
      GoogleAccessExpiredError,
    );
    globalThis.fetch = async () => Response.json({ error: 'invalid_token' }, { status: 400 });
    await assert.rejects(google.revokeToken('fake'), GoogleInvalidTokenError);
    globalThis.fetch = async () => Response.json({ error: 'invalid_token' }, { status: 503 });
    await assert.rejects(google.revokeToken('fake'), (error) => !(error instanceof GoogleInvalidTokenError));
    globalThis.fetch = async () => {
      throw new TypeError('network failure');
    };
    await assert.rejects(google.revokeToken('fake'), TypeError);
  } finally {
    globalThis.fetch = original;
  }
});

test('production API provider excludes browser mock, and Worker has no demo sign-in route', async () => {
  const provider = await readFile(
    new URL('../../frontend/src/app/api-provider.production.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(provider, /MockApi|signInMock|localStorage/);
  assert.match(provider, /new HttpApi/);
  const router = await readFile(new URL('../src/api/router.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /\/api\/auth\/(?:mock|demo|test)/i);
  const angular = JSON.parse(await readFile(new URL('../../frontend/angular.json', import.meta.url), 'utf8'));
  assert.ok(
    angular.projects.frontend.architect.build.configurations.production.fileReplacements.some(
      (entry) => entry.with === 'src/app/api-provider.production.ts',
    ),
  );
});
