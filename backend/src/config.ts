export type EmailMode = 'MOCK' | 'GMAIL';

export interface AppConfig {
  emailMode: EmailMode;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  tokenEncryptionKey: string;
  adminEmails: Set<string>;
  dailySendLimit: number;
  appBaseUrl: string;
}

export interface AppEnvironment {
  DB: import('./db/d1Database').D1Binding;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  EMAIL_MODE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  ADMIN_EMAILS?: string;
  DAILY_SEND_LIMIT?: string;
  APP_BASE_URL?: string;
}

export function readConfig(env: AppEnvironment): AppConfig {
  const emailMode = (env.EMAIL_MODE ?? 'MOCK').toUpperCase();
  if (emailMode !== 'MOCK' && emailMode !== 'GMAIL') {
    throw new Error('EMAIL_MODE must be MOCK or GMAIL');
  }
  const dailySendLimit = Number(env.DAILY_SEND_LIMIT ?? '100');
  if (!Number.isInteger(dailySendLimit) || dailySendLimit < 1) {
    throw new Error('DAILY_SEND_LIMIT must be a positive integer');
  }
  const appBaseUrl = env.APP_BASE_URL ?? 'http://localhost:4200';
  const parsedBaseUrl = new URL(appBaseUrl);
  if (parsedBaseUrl.protocol !== 'https:' && parsedBaseUrl.hostname !== 'localhost') {
    throw new Error('APP_BASE_URL must use HTTPS outside localhost');
  }

  return {
    emailMode,
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? '',
    adminEmails: new Set(
      (env.ADMIN_EMAILS ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
    dailySendLimit,
    appBaseUrl: parsedBaseUrl.origin,
  };
}
