import { byteCount, copyOf, ObjectGetOwnPropertyDescriptor, promise, ReflectApply, settle } from "./primordials";

/**
 * Ed25519 signature check with the browser's own Web Crypto, so no crypto
 * library has to load into every page. Built from a `subtle` captured before
 * any site script runs (the page hook passes it in), so a site cannot replace
 * the check; its promises are read with the captured `then` (./primordials),
 * so a site that replaced Promise.prototype.then cannot answer "valid".
 * Answers null when this browser cannot check Ed25519 at all (older Chrome),
 * so the caller can tell "invalid" from "not checkable".
 */

type Subtle = Pick<SubtleCrypto, "importKey" | "verify">;

export type SignatureVerifier = (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => Promise<boolean | null>;

const domExceptionName = typeof DOMException === "function" ? ObjectGetOwnPropertyDescriptor(DOMException.prototype, "name")?.get : undefined;

/** NotSupportedError: no Ed25519 in this browser (read with the captured accessor, not the error's own claim). */
function notSupported(error: unknown): boolean {
  if (!domExceptionName) return false;
  try {
    return ReflectApply(domExceptionName, error, []) === "NotSupportedError";
  } catch {
    return false;
  }
}

export function ed25519Verifier(subtle: Subtle): SignatureVerifier {
  const importKey = subtle.importKey.bind(subtle);
  const verify = subtle.verify.bind(subtle);
  return (message, signature, publicKey) =>
    promise<boolean | null>((resolve) => {
      if (byteCount(signature) !== 64 || byteCount(publicKey) !== 32) return resolve(false);
      let imported: unknown;
      try {
        imported = importKey("raw", copyOf(publicKey), { name: "Ed25519" }, false, ["verify"]);
      } catch {
        return resolve(false);
      }
      settle<CryptoKey>(
        imported,
        (key) => {
          let checked: unknown;
          try {
            checked = verify({ name: "Ed25519" }, key, copyOf(signature), copyOf(message));
          } catch {
            return resolve(false);
          }
          settle<unknown>(checked, (ok) => resolve(ok === true), () => resolve(false), true);
        },
        // NotSupportedError: no Ed25519 in this browser. Anything else: not a valid public key.
        (error) => resolve(notSupported(error) ? null : false),
        true,
      );
    });
}
