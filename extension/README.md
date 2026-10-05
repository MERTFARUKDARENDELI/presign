# Presign browser extension

Reviews every Solana signing request on any website **before your wallet opens**. No link to share: when a site asks your wallet to sign, Presign opens its review, and the wallet is asked only after your decision. Presign advises; you decide.

## Install (developer mode)

```bash
npm run build:extension
```

Chrome / Edge / Brave → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`.

The toolbar menu turns protection on or off, turns it off for the current site, picks the Presign instance (production picks mainnet or devnet by the request's chain; "local" uses `http://localhost:3000`), and lists recent decisions.

## How it works

```text
site ── signTransaction / signMessage / signIn ──▶ page hook (MAIN world, document_start)
page hook ── secret-named DOM events ──▶ content script ──▶ background service worker
background ── opens ──▶ Presign /extension/review?rid=…&ext=…   (popup window)
review page: decode · simulate · deterministic rules · your decision · server approval
review page ── externally_connectable ──▶ background ──▶ content script ──▶ page hook
page hook ── the site's ORIGINAL request ──▶ wallet ── signature ──▶ checked ──▶ site
```

- **What is wrapped:** Wallet Standard wallets (the `register-wallet` / `app-ready` handshake is intercepted, so the site only gets wrapped wallets) and injected providers (`window.phantom.solana`, `window.solana`, `window.solflare`, `window.backpack`, …) — sign transaction(s), sign and send, sign message, Sign-In With Solana.
- **Same review as everywhere:** `/extension/review` uses the same analysis, decision rules and server approval as the rest of Presign. The requesting site is the origin the browser reports to the extension, not what the site claims.
- **Exact bytes, both ways:** after approval the wallet receives the site's own request object; the hook never accepts bytes from outside. When the wallet returns, a signed transaction may differ from the reviewed one only in its signature slots, and a signed message must be byte-identical — otherwise the signature is withheld from the site.
- **Ownership once per session:** Presign approves only for a wallet you proved is yours (a message that authorizes nothing). Your wallet extension works on the review page too.
- **Channel to the extension:** a random secret is exchanged with the content script synchronously at start-up, before any site script runs; messages then travel as DOM events named with that secret, using DOM / JSON functions captured before the site could replace them.
- **No keys, no network:** the extension never signs, never holds keys and makes no requests of its own (`tests/security/no-server-signing.test.ts` fails if it ever does).

## Verified

- Unit tests: `tests/extension/*` (Wallet Standard interception with faithful event classes and a class-based wallet, injected providers, tampering wallets, batches, sign-in, re-entrancy, background decisions), `tests/security/presign-extension.test.ts` (decision path and page ↔ extension bridge).
- Real Chrome, end to end: `node scripts/extension-e2e.mjs` loads the built extension in a fresh profile, serves a test dApp with a fake Wallet Standard wallet and drives the review on a local Presign: the wallet is not asked before the review; approve signs exactly the reviewed bytes; cancel and closing the window never reach the wallet; a CRITICAL request can be signed only after the explicit confirmation; ownership is asked once per session.

## Limits

- A page written specifically to evade a page-level hook can bypass it; only wallet-level integration closes that.
- `signAndSendTransaction` is broadcast by the wallet itself, so only what goes to the wallet can be checked.
- A Sign-In With Solana request whose account is chosen inside the wallet cannot be reconstructed in advance; it goes to the wallet unreviewed and is logged as "not reviewed".
- Each transaction of a batch is reviewed separately; there is no combined view.
- Not yet published to the Chrome Web Store; not yet exercised with a real wallet extension (Phantom, Solflare, Backpack) — the end-to-end test uses a fake wallet.
