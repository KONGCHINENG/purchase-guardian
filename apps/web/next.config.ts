import type { NextConfig } from "next";

const apiUrl = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // The shopping agent can take over a minute; the default 30s proxy timeout would cut it off.
  experimental: { proxyTimeout: 120_000 },
  transpilePackages: ["@guardian/shared"],
  // Type safety is enforced by `npm run typecheck` (tsc) in CI rather than during `next build`.
  typescript: { ignoreBuildErrors: true },
  // Same-origin proxy to the API: the refresh-token cookie stays first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'" },
          { key: "Strict-Transport-Security", value: "max-age=15552000" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
