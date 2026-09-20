import type { NextConfig } from 'next';

/**
 * The API is a separate process. Proxying it under the web origin keeps the
 * session cookie same-origin, which is what lets it stay `SameSite=Lax` and
 * `httpOnly`. In production Caddy does the same thing in front of both.
 */
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
};

export default nextConfig;
