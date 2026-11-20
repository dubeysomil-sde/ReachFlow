export class FakeGoogleClient {
  constructor() {
    this.authorizationRequests = [];
    this.sentMessages = [];
    this.revokedTokens = [];
    this.refreshCalls = [];
    this.failSendFor = new Set();
    this.user = {
      id: 'google-subject-1',
      email: 'person@example.com',
      name: 'Test Person',
      picture: null,
      emailVerified: true,
    };
  }

  authorizationUrl(options) {
    this.authorizationRequests.push(options);
    const url = new URL('https://google.test/authorize');
    url.searchParams.set('state', options.state);
    url.searchParams.set('scope', options.scopes.join(' '));
    if (options.accessType) url.searchParams.set('access_type', options.accessType);
    if (options.prompt) url.searchParams.set('prompt', options.prompt);
    return url.toString();
  }

  async exchangeCode(code, redirectUri, codeVerifier) {
    this.lastExchange = { code, redirectUri, codeVerifier };
    return {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
    };
  }

  async refreshAccessToken(refreshToken) {
    this.refreshCalls.push(refreshToken);
    return { accessToken: 'test-refreshed-access-token', expiresIn: 3600 };
  }

  async userInfo() {
    return this.user;
  }

  async sendGmailMessage(message) {
    this.sentMessages.push(message);
    if (this.failSendFor.has(message.raw)) throw new Error('redacted provider failure');
    return { id: `gmail-${this.sentMessages.length}` };
  }

  async revokeToken(token) {
    this.revokedTokens.push(token);
  }
}
