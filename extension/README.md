# Presign browser extension

Reviews Solana signing requests on any website **before your wallet opens** — every request made through the wallet APIs it wraps (Wallet Standard and injected providers); while protection is on, anything it cannot review is refused. No link to share: when a site asks your wallet to sign, Presign opens its review, and the wallet is asked only after your decision. Presign advises; you decide.

## Install (developer mode)

```bash
npm run build:extension
```

Chrome / Edge / Brave → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`.

The toolbar menu turns protection on or off, turns it off for the current site, picks the Presign instance (production picks mainnet or devnet by the request's chain), and lists recent decisions. A development build (`npm run build:extension:dev`) also offers "local" (`http://localhost:3000`); the production build does not list localhost in `externally_connectable` and never sends a review there, since any other local project could be listening on that port.

## How it works

```text
site ── signTransaction / signMessage / signIn ──▶ page hook (MAIN world, document_start)
page hook ── secret-named DOM events ──▶ content script ──▶ background service worker
background ── opens ──▶ Presign /extension/review?rid=…&ext=…   (popup window)
review page: decode · simulate · deterministic rules · your decision · server approval
review page ── externally_connectable ──▶ background ──▶ content script ──▶ page hook
page hook ── the site's ORIGINAL request ──▶ wallet ── signature ──▶ checked ──▶ site
```

- **What is wrapped:** Wallet Standard wallets (the `register-wallet` / `app-ready` handshake is intercepted, so the site only gets wrapped wallets; wallets that register through the legacy `window.navigator.wallets` list are routed through the same handshake, and the list cannot be replaced afterwards — apps that try log "window.navigator.wallets could not be set" and keep the wrapped wallets) and injected providers (`window.phantom.solana`, `window.solana`, `window.solflare`, `window.backpack`, …) — sign transaction(s), sign and send (one or several), sign message, off-chain message, Sign-In With Solana. **Default deny:** any other Solana signing feature, `sign…` provider method or `request({ method: "sign…" })` Presign cannot read is refused (or reviewed as unreadable), never passed through.
- **Same review as everywhere:** `/extension/review` uses the same analysis, decision rules and server approval as the rest of Presign. The requesting site is the origin the browser reports to the extension, not what the site claims.
- **Exact bytes, both ways:** the bytes are copied the moment the site calls, and after approval the wallet gets that copy — never the site's own array, which the site could change while you read the review. Injected providers take a transaction object: the wallet gets a view of it whose serialization is fixed to the reviewed bytes, and the site gets its own object back. When the wallet returns, a signed transaction may differ from the reviewed one only in its signature slots, and a signed message must be byte-identical with a signature that is valid for the reviewed bytes and account — otherwise the signature is withheld from the site. Signatures are checked with the browser's own Web Crypto (Ed25519); on plain-HTTP pages, or in a browser without Ed25519, only the bytes are compared.
- **Fails closed:** with protection on, a request Presign cannot review as sent (too large, more than 50 signatures at once, malformed) opens the review as unreadable, where Cancel is the only choice; if the review cannot open at all, or the extension was reloaded, the request is refused. Only the toolbar's own switches (protection off, or off for this site) let requests through unreviewed.
- **Ownership once per session:** Presign approves only for a wallet you proved is yours (a message that authorizes nothing). Your wallet extension works on the review page too.
- **Channel to the extension:** a random secret is exchanged with the content script synchronously at start-up, before any site script runs; messages then travel as DOM events named with that secret, using DOM / JSON functions captured before the site could replace them.
- **No keys, no network:** the extension never signs, never holds keys and makes no requests of its own (`tests/security/no-server-signing.test.ts` fails if it ever does).

## Verified

- Unit tests: `tests/extension/*` (Wallet Standard interception with faithful event classes and a class-based wallet, injected providers, tampering wallets, batches, sign-in, re-entrancy, background decisions), `tests/security/presign-extension.test.ts` (decision path and page ↔ extension bridge).
- Real Chrome, end to end: `node scripts/extension-e2e.mjs` loads the built extension in a fresh profile, serves a test dApp with a fake Wallet Standard wallet and drives the review on a local Presign: the wallet is not asked before the review; approve signs exactly the reviewed bytes; cancel and closing the window never reach the wallet; a CRITICAL request can be signed only after the explicit confirmation; ownership is asked once per session.

## Limits

- A page written specifically to evade a page-level hook can bypass it; only wallet-level integration closes that.
- `signAndSendTransaction` is broadcast by the wallet itself, so only what goes to the wallet can be checked (it is the reviewed copy).
- Injected providers: a wallet that rebuilds a transaction from the object's fields instead of serializing it would not be held to the reviewed bytes by the sealed view. Wallet Standard wallets receive bytes and are not affected.
- A Sign-In With Solana request whose account is chosen inside the wallet cannot be reconstructed in advance, so for it the order is reversed: the wallet signs first, Presign rebuilds the text for the account the wallet returned, requires the wallet to have signed exactly that (signature checked), and reviews it. The site receives the signature only if you continue; Cancel, a failed review or any mismatch withholds it. The wallet window therefore opens before Presign's review for this one case.
- Each transaction of a batch is reviewed separately; there is no combined view.
- Not yet published to the Chrome Web Store; not yet exercised with a real wallet extension (Phantom, Solflare, Backpack) — the end-to-end test uses a fake wallet. Wallets that add instructions to a transaction (priority fees, guard instructions) will have their signature withheld, by design; this needs checking against real wallets.
- The page hook is tested against hostile sites in unit tests (bytes swapped after the call, objects that serialize differently, oversized requests, unwrapped features); the Chrome end-to-end test covers an honest site.
