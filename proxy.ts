import { NextResponse, type NextRequest } from "next/server";
import { canonicalOrigin } from "@/lib/api/trusted-proxy";
import { buildCsp, newNonce } from "@/lib/security/csp";

/**
 * A fresh CSP nonce for every page response (lib/security/csp.ts). Next.js
 * reads it from the request's Content-Security-Policy header and puts it on
 * its own scripts; the browser gets the same policy on the response.
 *
 * With PRESIGN_CANONICAL_ORIGIN set, a page requested on any other host (an
 * old domain, a deployment alias) is permanently redirected there, so users
 * and the extension's allow-list meet one origin.
 */
export function proxy(request: NextRequest) {
  const canonical = canonicalOrigin();
  const host = request.headers.get("host")?.toLowerCase();
  if (canonical && host && host !== canonical.host) {
    return NextResponse.redirect(new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, canonical), 308);
  }
  const csp = buildCsp(newNonce(), process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not API routes, static files, image optimization or the favicon.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
