import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptSecret, encryptSecret, generateInvitationToken, hashToken } from '../../shared/core/crypto.ts';
import { buildRawMessage } from '../../shared/core/mimeBuilder.ts';
import { parseRecipient } from '../../shared/core/recipientParser.ts';
import { assertSendable, renderTemplate } from '../../shared/core/templateRenderer.ts';

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

function decodeMimeHeaders(raw) {
  const normalized = raw.replace(/\r\n[ \t]/g, '');
  const headers = normalized.split('\r\n\r\n', 1)[0].split('\r\n');
  return Object.fromEntries(
    headers
      .filter((header) => /^[^:]+:/.test(header))
      .map((header) => {
        const separator = header.indexOf(':');
        return [header.slice(0, separator), header.slice(separator + 1).trim()];
      }),
  );
}

test('recipient parser extracts name and company from a normal address', () => {
  assert.deepEqual(parseRecipient('  Iqbal.Kaur@Birdeye.com  '), {
    email: 'iqbal.kaur@birdeye.com',
    firstName: 'Iqbal',
    company: 'Birdeye',
    confidence: 'HIGH',
    warnings: [],
  });
});

test('recipient parser handles multi-part suffixes and subdomains', () => {
  assert.equal(parseRecipient('person@mail.acme.co.uk').company, 'Acme');
  assert.equal(parseRecipient('person@google.co.in').company, 'Google');
  assert.equal(parseRecipient('person@jobs.example.com.au').company, 'Example');
});

test('public email providers have no inferred company and low confidence', () => {
  assert.deepEqual(parseRecipient('Person@gmail.com'), {
    email: 'person@gmail.com',
    firstName: 'Person',
    company: '',
    confidence: 'LOW',
    warnings: ['company cannot be detected'],
  });
});

test('role mailboxes have no inferred name and low confidence', () => {
  const parsed = parseRecipient('no-reply@acme.com');
  assert.equal(parsed.firstName, '');
  assert.equal(parsed.company, 'Acme');
  assert.equal(parsed.confidence, 'LOW');
});

test('recipient parser strips digits from the first local-part segment', () => {
  assert.equal(parseRecipient('jo4hn.doe@acme.com').firstName, 'John');
});

test('recipient parser rejects malformed addresses and CR/LF', () => {
  for (const value of [
    'not-an-email',
    'a@@example.com',
    'person@localhost',
    'person name@example.com',
    'person@example..com',
    'person@example.com\r\nBcc: other@example.com',
  ]) {
    assert.throws(() => parseRecipient(value), /Invalid email address/);
  }
});

test('template renderer replaces supported placeholders and reports unresolved ones', () => {
  assert.deepEqual(
    renderTemplate('Hello [Name] at [Company], [Role] [JobId]', {
      Name: 'Ari',
      Company: 'Acme',
    }),
    {
      text: 'Hello Ari at Acme, [Role] [JobId]',
      unresolved: ['[Role]', '[JobId]'],
    },
  );
  assert.throws(() => assertSendable('Hello [Name]', 'Body'), /Unresolved placeholders/);
  assert.throws(() => assertSendable('Hello', 'Body', ['']), /must not be empty/);
  assert.throws(() => assertSendable('  ', 'Body'), /Subject is required/);
});

test('MIME builder rejects header injection in sender, recipient, and subject', () => {
  for (const field of ['from', 'to', 'subject']) {
    assert.throws(
      () =>
        buildRawMessage({
          from: field === 'from' ? 'sender@example.com\r\nBcc: x' : 'sender@example.com',
          to: field === 'to' ? 'person@example.com\nBcc: x' : 'person@example.com',
          subject: field === 'subject' ? 'Hello\r\nBcc: x' : 'Hello',
          body: 'Message',
        }),
      /CR\/LF is not allowed/,
    );
  }
});

test('MIME builder encodes non-ASCII subjects using RFC 2047', () => {
  const raw = decodeBase64Url(
    buildRawMessage({
      from: 'sender@example.com',
      to: 'person@example.com',
      subject: 'Café привет',
      body: 'Hello',
    }),
  );
  const headers = decodeMimeHeaders(raw);

  assert.match(headers.Subject, /^=\?UTF-8\?B\?.+\?=$/);
  const encodedSubject = headers.Subject.match(/=\?UTF-8\?B\?(.+?)\?=/)?.[1];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(encodedSubject), (c) => c.charCodeAt(0))), 'Café привет');
});

test('MIME attachment is reused as base64 and decodes to the original bytes', () => {
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 200, 255]);
  const attachmentBase64 = btoa(String.fromCharCode(...bytes));
  const raw = decodeBase64Url(
    buildRawMessage({
      from: 'sender@example.com',
      to: 'person@example.com',
      subject: 'Résumé',
      body: 'Hello',
      attachment: {
        filename: 'résumé.pdf',
        contentType: 'application/pdf',
        base64: attachmentBase64,
      },
    }),
  );
  const parts = raw.split(/\r\n/);
  const encodedIndex = parts.findIndex((line) => line === 'Content-Transfer-Encoding: base64');
  assert.ok(encodedIndex >= 0);
  assert.ok(parts.some((line) => /filename\*=UTF-8''r%C3%A9sum%C3%A9.pdf/.test(line)));
  const base64Start = parts.indexOf('', encodedIndex + 1) + 1;
  const attachmentLines = [];
  for (let index = base64Start; index < parts.length && !parts[index].startsWith('--reachflow_'); index += 1) {
    if (parts[index]) attachmentLines.push(parts[index]);
  }
  const decoded = atob(attachmentLines.join(''));
  assert.deepEqual(
    Uint8Array.from(decoded, (char) => char.charCodeAt(0)),
    bytes,
  );
  assert.ok(attachmentLines.every((line) => line.length <= 76));
});

const base64Key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

test('AES-256-GCM secret encryption round-trips with a random 12-byte IV', async () => {
  const encrypted = await encryptSecret('refresh-token', base64Key);
  assert.equal(encrypted.keyVersion, 'v1');
  assert.equal(atob(encrypted.iv).length, 12);
  assert.notEqual(encrypted.iv, (await encryptSecret('refresh-token', base64Key)).iv);
  assert.equal(await decryptSecret(encrypted, base64Key), 'refresh-token');
});

test('AES-GCM authentication rejects tampered ciphertext and wrong keys', async () => {
  const encrypted = await encryptSecret('secret-value', base64Key);
  const bytes = Uint8Array.from(atob(encrypted.ciphertext), (char) => char.charCodeAt(0));
  bytes[0] ^= 1;
  const tampered = {
    ...encrypted,
    ciphertext: btoa(String.fromCharCode(...bytes)),
  };
  await assert.rejects(decryptSecret(tampered, base64Key));

  const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
  await assert.rejects(decryptSecret(encrypted, wrongKey));
});

test('invitation tokens contain 32 random bytes and token hashes are deterministic SHA-256 hex', async () => {
  const token = generateInvitationToken();
  assert.equal(decodeBase64Url(token).length, 32);
  assert.match(await hashToken(token), /^[0-9a-f]{64}$/);
  assert.equal(await hashToken(token), await hashToken(token));
});
