import { handleApiRequest } from './api/router.ts';
import { ConfigurationError, readConfig, type AppEnvironment } from './config.ts';
import { D1DatabaseAdapter } from './db/d1Database.ts';
import { FetchGoogleClient } from './google/googleClient.ts';

interface Env extends AppEnvironment {}

const STATIC_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let config;
    try {
      config = readConfig(env);
    } catch (reason) {
      if (!(reason instanceof ConfigurationError)) throw reason;
      return Response.json(
        { error: reason.message },
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        },
      );
    }
    const dependencies = {
      db: new D1DatabaseAdapter(env.DB),
      google: new FetchGoogleClient({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      }),
      config,
    };

    if (new URL(request.url).pathname.startsWith('/api/')) {
      return handleApiRequest(request, dependencies);
    }

    if (!env.ASSETS) {
      return new Response('Frontend assets are not configured', { status: 503 });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
      headers.set(name, value);
    }
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
