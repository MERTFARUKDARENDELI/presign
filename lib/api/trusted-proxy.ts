/**
 * Which request headers this deployment may believe. X-Forwarded-For / -Host /
 * -Proto are only as trustworthy as the proxy that sets them: on Vercel the
 * platform sets them; elsewhere they count only when the operator says how
 * many proxies sit in front of the app (PRESIGN_TRUSTED_PROXY_HOPS). Without
 * that they are whatever the client sent, and are ignored.
 */

/** Number of trusted proxies in front of the app (1–5), from PRESIGN_TRUSTED_PROXY_HOPS; 0 = none declared. */
export function trustedProxyHops(): number {
  const n = Number(process.env.PRESIGN_TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

export function forwardedHeadersTrusted(): boolean {
  return Boolean(process.env.VERCEL) || trustedProxyHops() > 0;
}

/** For /api/health: where the client address and host come from (no secrets). */
export function proxyTrust(): "vercel" | `hops:${number}` | "none" {
  if (process.env.VERCEL) return "vercel";
  const hops = trustedProxyHops();
  return hops > 0 ? `hops:${hops}` : "none";
}

/**
 * PRESIGN_CANONICAL_ORIGIN (e.g. https://presign-app.vercel.app): the one origin
 * this deployment calls itself. When set it is the domain in ownership messages
 * and the cookie security decision, and pages requested on any other host are
 * redirected to it (proxy.ts). A value that is not a bare http(s) origin is ignored.
 */
export function canonicalOrigin(): URL | null {
  const value = process.env.PRESIGN_CANONICAL_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}
