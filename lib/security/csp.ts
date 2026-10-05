/**
 * Content Security Policy for every page. Presign's own origin is what the
 * browser extension trusts to approve a signing request, so script injection
 * there must be blocked, not only framing.
 *
 * Scripts run only with this response's nonce ('strict-dynamic' lets them load
 * their own chunks); Next.js puts the nonce on its scripts during dynamic
 * rendering (proxy.ts sets it, app/layout.tsx renders per request). No inline
 * script without it, no eval outside development. Styles may be inline (UI
 * components set style attributes; a nonce would disable that, and styles
 * cannot run code). The only other hosts are the public Solana RPC endpoints
 * the wallet adapter uses for cluster detection, and the local websocket of the
 * Android Mobile Wallet Adapter.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https://api.mainnet-beta.solana.com https://api.devnet.solana.com wss://api.mainnet-beta.solana.com wss://api.devnet.solana.com ws://localhost:*",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** 128 random bits, base64 — unpredictable and new for every response. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
