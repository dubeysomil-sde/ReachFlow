export interface MimeAttachment {
  filename: string;
  base64: string;
  contentType?: string;
}

export interface RawMessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachment?: MimeAttachment;
}

const encoder = new TextEncoder();

function encodeBytesBase64(bytes: Uint8Array): string {
  const chunkSize = 0x7ffe;
  const encodedChunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    encodedChunks.push(btoa(String.fromCharCode(...chunk)));
  }
  return encodedChunks.join('');
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;

  const codePoints = Array.from(subject);
  const words: string[] = [];
  let current = '';

  for (const codePoint of codePoints) {
    const candidate = current + codePoint;
    if (encoder.encode(candidate).length > 42 && current) {
      words.push(`=?UTF-8?B?${encodeBytesBase64(encoder.encode(current))}?=`);
      current = codePoint;
    } else {
      current = candidate;
    }
  }
  if (current) {
    words.push(`=?UTF-8?B?${encodeBytesBase64(encoder.encode(current))}?=`);
  }

  return words.join('\r\n ');
}

function encodeFilename(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .replace(/[\r\n]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function normalizeBase64(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('Attachment must be valid base64 data');
  }
  return normalized.replace(/=+$/, '');
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n|\r|\n/g, '\r\n');
}

export function buildRawMessage(options: RawMessageOptions): string {
  const { from, to, subject, body, attachment } = options;
  for (const [field, value] of [
    ['from', from],
    ['to', to],
    ['subject', subject],
  ] as const) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`CR/LF is not allowed in the ${field} header`);
    }
  }

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
  ];
  let message: string;

  if (!attachment) {
    message = [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeBody(body),
    ].join('\r\n');
  } else {
    if (/[\r\n]/.test(attachment.filename)) {
      throw new Error('CR/LF is not allowed in the attachment filename');
    }
    const contentType = attachment.contentType ?? 'application/octet-stream';
    if (!/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)) {
      throw new Error('Invalid attachment content type');
    }
    const safeFilename = attachment.filename
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\;]/g, '_');
    const boundary = `reachflow_${encodeBytesBase64(crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, '')}`;
    const attachmentBase64 = wrapBase64(normalizeBase64(attachment.base64));
    message = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      normalizeBody(body),
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${safeFilename}"`,
      `Content-Disposition: attachment; ${encodeFilename(attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      '',
      attachmentBase64,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }

  return encodeBytesBase64(encoder.encode(message))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
