export interface GoogleUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  emailVerified: boolean;
}

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface GmailMessage {
  accessToken: string;
  raw: string;
}

export interface GoogleClient {
  authorizationUrl(options: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: string[];
    accessType?: 'online' | 'offline';
    prompt?: string;
  }): string;
  exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<GoogleTokenResponse>;
  refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse>;
  userInfo(accessToken: string): Promise<GoogleUser>;
  sendGmailMessage(message: GmailMessage): Promise<{ id: string }>;
  revokeToken(token: string): Promise<void>;
}

interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
}

export class GoogleAccessExpiredError extends Error {
  constructor() {
    super('Gmail access has expired. Reconnect Gmail, then continue.');
  }
}

export class GoogleInvalidTokenError extends Error {}

export function isInvalidGoogleToken(error: unknown): boolean {
  return error instanceof GoogleAccessExpiredError || error instanceof GoogleInvalidTokenError;
}

async function googleErrorCode(response: Response): Promise<string | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  let body: { error?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof body.error === 'string' ? body.error : undefined;
}

export class FetchGoogleClient implements GoogleClient {
  private readonly options: GoogleClientOptions;

  constructor(options: GoogleClientOptions) {
    this.options = options;
  }

  authorizationUrl(options: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: string[];
    accessType?: 'online' | 'offline';
    prompt?: string;
  }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: options.redirectUri,
      response_type: 'code',
      scope: options.scopes.join(' '),
      state: options.state,
      code_challenge: options.codeChallenge,
      code_challenge_method: 'S256',
      access_type: options.accessType ?? 'online',
      ...(options.prompt ? { prompt: options.prompt } : {}),
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<GoogleTokenResponse> {
    const body = await this.postToken({
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
    });
    return this.toTokenResponse(body);
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    const body = await this.postToken({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    return this.toTokenResponse(body);
  }

  async userInfo(accessToken: string): Promise<GoogleUser> {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error('Google user verification failed');
    const body = (await response.json()) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
      email_verified?: boolean;
    };
    if (!body.sub || !body.email || !body.email_verified) {
      throw new Error('Google user verification failed');
    }
    return {
      id: body.sub,
      email: body.email.toLowerCase(),
      name: body.name ?? body.email,
      picture: body.picture ?? null,
      emailVerified: true,
    };
  }

  async sendGmailMessage(message: GmailMessage): Promise<{ id: string }> {
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${message.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: message.raw }),
    });
    if (response.status === 401) throw new GoogleAccessExpiredError();
    if (!response.ok) {
      if (response.status < 500 && (await googleErrorCode(response)) === 'invalid_grant') {
        throw new GoogleAccessExpiredError();
      }
      throw new Error('Gmail rejected the message');
    }
    const body = (await response.json()) as { id?: string };
    if (!body.id) throw new Error('Gmail returned an invalid message response');
    return { id: body.id };
  }

  async revokeToken(token: string): Promise<void> {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    if (!response.ok) {
      const code = await googleErrorCode(response);
      if (response.status === 400 && (code === 'invalid_token' || code === 'invalid_grant')) {
        throw new GoogleInvalidTokenError('Google token is already invalid.');
      }
      throw new Error('Google token revocation failed');
    }
  }

  private async postToken(values: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...values,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }),
    });
    if (!response.ok) {
      if (response.status < 500 && (await googleErrorCode(response)) === 'invalid_grant') {
        throw new GoogleAccessExpiredError();
      }
      throw new Error('Google token exchange failed');
    }
    return (await response.json()) as Record<string, unknown>;
  }

  private toTokenResponse(body: Record<string, unknown>): GoogleTokenResponse {
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error('Google returned an invalid token response');
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresIn: body.expires_in,
    };
  }
}
