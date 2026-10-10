// Loaded with `--import` into the local Presign server during the isolated e2e (scripts/e2e/local.mjs): a request to
// any host other than loopback fails at once and its host (never the URL, which may carry a key) is appended to
// E2E_BLOCKED_LOG. The run therefore cannot depend on, or send anything to, an outside service through fetch or
// node:http(s). Raw sockets are not covered.
import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const LOG = process.env.E2E_BLOCKED_LOG;
const loopback = (host) => /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i.test(String(host ?? "").replace(/:\d+$/, ""));
const blocked = (via, host) => {
  if (LOG) {
    try {
      appendFileSync(LOG, `${via} ${host}\n`);
    } catch {
      // the log is best effort; the request is refused either way
    }
  }
  return new Error(`e2e isolation: request to ${host} refused`);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async function isolatedFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!loopback(url.hostname)) throw blocked("fetch", url.host);
  return realFetch(input, init);
};

for (const [name, mod] of [["http", http], ["https", https]]) {
  for (const method of ["request", "get"]) {
    const real = mod[method];
    mod[method] = function isolatedRequest(...args) {
      const first = args[0];
      const host = typeof first === "string" || first instanceof URL ? new URL(first).hostname : (first?.hostname ?? first?.host ?? "localhost");
      if (!loopback(host)) throw blocked(`${name}.${method}`, host);
      return Reflect.apply(real, this, args);
    };
  }
}
