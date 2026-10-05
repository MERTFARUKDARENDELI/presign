import type { NextConfig } from "next";

// The Content-Security-Policy is set per response, with a nonce, by proxy.ts (lib/security/csp.ts).
// A second, static CSP here would be enforced next to it and block every script.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Prevent clickjacking of the confirmation/signing screens (also frame-ancestors in the CSP).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
