import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

test('production bundles contain no browser mock sign-in implementation or demo identity', async () => {
  const directory = new URL('../dist/frontend/browser/', import.meta.url);
  const scripts = (await readdir(directory)).filter((file) => file.endsWith('.js'));
  assert.ok(scripts.length > 0);
  const source = (await Promise.all(scripts.map((file) => readFile(new URL(file, directory), 'utf8')))).join(
    '\n',
  );
  assert.doesNotMatch(
    source,
    /reachflow\.mock\.v1|demo@reachflow\.local|mock-admin|\/api\/auth\/(?:mock|demo|test)/i,
  );
  assert.match(source, /Sign in with Google/);
});
