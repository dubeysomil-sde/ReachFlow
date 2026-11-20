import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('screen text and user messages use plain words without the old send label', async () => {
  const html = await readFile(new URL('../../frontend/src/app/app.html', import.meta.url), 'utf8');
  const visible = html
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/@(?:if|for|else if)\s*\([^{}]*?\)\s*\{/g, '')
    .replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(
    visible,
    /\b(campaigns?|templates?|recipients?|people|persons?|invitations?|placeholders?|cancel)\b/i,
  );
  for (const file of ['app.ts', 'api.ts', 'composer.ts']) {
    const source = await readFile(new URL(`../../frontend/src/app/${file}`, import.meta.url), 'utf8');
    const calls = [
      ...source.matchAll(/(?:new Error|(?:error|toast)\.set|window\.(?:confirm|prompt))\(([\s\S]*?)\);/g),
    ];
    const messages = calls
      .flatMap((call) => [...call[1].matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)])
      .map((match) => match[2].replace(/\$\{[^}]*\}/g, ''))
      .join('\n');
    assert.doesNotMatch(
      messages,
      /\b(campaigns?|templates?|recipients?|people|persons?|invitations?|placeholders?|cancel)\b/i,
    );
  }
  assert.doesNotMatch(visible, /\{\{/);
  const labels = [...html.matchAll(/(?:aria-label|placeholder)="([^"]*)"/g)]
    .map((match) => match[1])
    .join('\n');
  assert.doesNotMatch(labels, /\b(campaigns?|people|persons?|recipients?)\b/i);
});
