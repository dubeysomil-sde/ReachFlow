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
  ENVIRONMENT?: string;
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

export class ConfigurationError extends Error {}

export function readConfig(env: AppEnvironment): AppConfig {
  const production = env.ENVIRONMENT !== 'development';
  if (production || env.EMAIL_MODE?.toUpperCase() === 'GMAIL') {
    for (const key of [
      'EMAIL_MODE',
      'APP_BASE_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'SESSION_SECRET',
      'TOKEN_ENCRYPTION_KEY',
    ] as const) {
      if (!env[key]?.trim())
        throw new ConfigurationError(`ReachFlow configuration error: ${key} is required.`);
    }
    if (env.SESSION_SECRET!.length < 32) {
      throw new ConfigurationError(
        'ReachFlow configuration error: SESSION_SECRET needs at least 32 characters.',
      );
    }
    let keyLength = 0;
    try {
      keyLength = atob(env.TOKEN_ENCRYPTION_KEY!).length;
    } catch {
      /* Report the invalid configuration below. */
    }
    if (keyLength !== 32) {
      throw new ConfigurationError(
        'ReachFlow configuration error: TOKEN_ENCRYPTION_KEY must be base64 for 32 bytes.',
      );
    }
  }
  const emailMode = (env.EMAIL_MODE ?? 'MOCK').toUpperCase();
  if (emailMode !== 'MOCK' && emailMode !== 'GMAIL') {
    throw new ConfigurationError('EMAIL_MODE must be explicitly set to MOCK or GMAIL');
  }
  const dailySendLimit = Number(env.DAILY_SEND_LIMIT ?? '100');
  if (!Number.isInteger(dailySendLimit) || dailySendLimit < 1) {
    throw new ConfigurationError('DAILY_SEND_LIMIT must be a positive integer');
  }
  const appBaseUrl = env.APP_BASE_URL ?? 'http://localhost:4200';
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(appBaseUrl);
  } catch {
    throw new ConfigurationError('APP_BASE_URL must be a valid HTTPS origin');
  }
  if (production && parsedBaseUrl.protocol !== 'https:') {
    throw new ConfigurationError('APP_BASE_URL must use HTTPS in production');
  }
  if (parsedBaseUrl.protocol !== 'https:' && parsedBaseUrl.hostname !== 'localhost') {
    throw new ConfigurationError('APP_BASE_URL must use HTTPS outside localhost');
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
