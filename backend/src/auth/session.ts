import { first, type Database } from '../db/database.ts';
import type { UserRow } from '../db/types.ts';

const SESSION_COOKIE = 'reachflow_session';
const CSRF_COOKIE = 'reachflow_csrf';
const OAUTH_COOKIE = 'reachflow_oauth';
const encoder = new TextEncoder();

export interface SessionPayload {
  sub: string;
  exp: number;
}

export interface OAuthStatePayload {
  state: string;
  verifier: string;
  purpose: 'LOGIN' | 'GMAIL';
  exp: number;
  inviteHash?: string;
  userId?: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  const expected = await sign(value, secret);
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return difference === 0;
}

function getCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get('Cookie') ?? '';
  for (const cookie of cookies.split(';')) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return value.join('=') || '';
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; secure?: boolean; maxAge?: number; path?: string } = {},
): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`, 'SameSite=Lax'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

function requireSecret(secret: string): void {
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
}

export async function createSessionCookie(
  userId: string,
  secret: string,
  secure: boolean,
  now = Date.now(),
): Promise<string> {
  requireSecret(secret);
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + 60 * 60 * 24 * 7 })),
  );
  return serializeCookie(SESSION_COOKIE, `${payload}.${await sign(payload, secret)}`, {
    httpOnly: true,
    secure,
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function readSession(
  request: Request,
  db: Database,
  secret: string,
  now = Date.now(),
): Promise<UserRow | null> {
  requireSecret(secret);
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!(await verify(payload, signature, secret))) return null;

  let session: SessionPayload;
  try {
    session = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof session.sub !== 'string' || session.exp <= Math.floor(now / 1000)) return null;
  return first<UserRow>(
    db,
    `SELECT id, google_id, email, name, profile_picture, role, status, created_at, updated_at
     FROM users WHERE id = ? AND status = 'ACTIVE'`,
    session.sub,
  );
}

export function csrfCookie(value: string, secure: boolean): string {
  return serializeCookie(CSRF_COOKIE, value, { secure, maxAge: 60 * 60 * 24 * 7 });
}

export function clearSessionCookies(secure: boolean): string[] {
  return [
    serializeCookie(SESSION_COOKIE, '', { httpOnly: true, secure, maxAge: 0 }),
    serializeCookie(CSRF_COOKIE, '', { secure, maxAge: 0 }),
  ];
}

export function csrfMatches(request: Request): boolean {
  const cookie = getCookie(request, CSRF_COOKIE);
  const header = request.headers.get('X-CSRF-Token');
  return !!cookie && !!header && cookie === header;
}

export async function createOAuthStateCookie(
  payload: OAuthStatePayload,
  secret: string,
  secure: boolean,
): Promise<string> {
  requireSecret(secret);
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return serializeCookie(OAUTH_COOKIE, `${encoded}.${await sign(encoded, secret)}`, {
    httpOnly: true,
    secure,
    maxAge: 600,
    path: '/api/auth',
  });
}

export async function readOAuthState(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<OAuthStatePayload | null> {
  requireSecret(secret);
  const value = getCookie(request, OAUTH_COOKIE);
  if (!value) return null;
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const encoded = value.slice(0, separator);
  if (!(await verify(encoded, value.slice(separator + 1), secret))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as OAuthStatePayload;
    if (payload.exp <= Math.floor(now / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearOAuthCookie(secure: boolean): string {
  return serializeCookie(OAUTH_COOKIE, '', {
    httpOnly: true,
    secure,
    maxAge: 0,
    path: '/api/auth',
  });
}

export function createRandomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function sessionCookieValue(request: Request): string | null {
  return getCookie(request, SESSION_COOKIE);
}
