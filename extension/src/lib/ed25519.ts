/**
 * Ed25519 signature check with the browser's own Web Crypto, so no crypto
 * library has to load into every page. Built from a `subtle` captured before
 * any site script runs (the page hook passes it in), so a site cannot replace
 * the check. Answers null when this browser cannot check Ed25519 at all
 * (older Chrome), so the caller can tell "invalid" from "not checkable".
 */

type Subtle = Pick<SubtleCrypto, "importKey" | "verify">;

export type SignatureVerifier = (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => Promise<boolean | null>;

export function ed25519Verifier(subtle: Subtle): SignatureVerifier {
  const importKey = subtle.importKey.bind(subtle);
  const verify = subtle.verify.bind(subtle);
  return async (message, signature, publicKey) => {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    let key: CryptoKey;
    try {
      key = await importKey("raw", Uint8Array.from(publicKey), { name: "Ed25519" }, false, ["verify"]);
    } catch (error) {
      // NotSupportedError: no Ed25519 in this browser. Anything else: not a valid public key.
      return error instanceof Error && error.name === "NotSupportedError" ? null : false;
    }
    try {
      return await verify({ name: "Ed25519" }, key, Uint8Array.from(signature), Uint8Array.from(message));
    } catch {
      return false;
    }
  };
}
