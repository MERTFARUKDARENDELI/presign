import { copyList, push, setOwn, snapshot } from "./primordials";

/**
 * Sign-In With Solana: the wallet builds the text it signs from the request
 * fields. Presign rebuilds the same text with the standard's format
 * (@solana/wallet-standard-util `createSignInMessageText`) so the user reviews
 * exactly what will be signed — and after signing, the page hook refuses to
 * hand the signature to the site if the wallet signed anything else.
 */

export interface SignInInput {
  domain?: string;
  address?: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: readonly string[];
}

const TEXT_FIELDS = ["domain", "address", "statement", "uri", "version", "chainId", "nonce", "issuedAt", "expirationTime", "notBefore", "requestId"] as const;

/**
 * The site's sign-in input as Presign reviews it and the wallet receives it:
 * read once, every standard field an own property (a string, or undefined for
 * anything else) and `resources` a copy holding only strings. A getter or a
 * prototype property cannot show the wallet other text than Presign rebuilt.
 */
export function signInSnapshot(input: unknown): SignInInput {
  const s = snapshot(input) ?? {};
  for (let i = 0; i < TEXT_FIELDS.length; i++) {
    const v = s[TEXT_FIELDS[i]];
    setOwn(s, TEXT_FIELDS[i], typeof v === "string" ? v : undefined);
  }
  const resources = s.resources;
  if (resources === undefined) {
    setOwn(s, "resources", undefined);
    return s as SignInInput;
  }
  const list = copyList(resources);
  const strings: string[] = [];
  for (let i = 0; i < list.length; i++) if (typeof list[i] === "string") push(strings, list[i] as string);
  setOwn(s, "resources", strings);
  return s as SignInInput;
}

/** The standard's text. Plain string concatenation: nothing a site can replace is looked up. */
export function createSignInMessageText(input: SignInInput & { domain: string; address: string }): string {
  let message = `${input.domain} wants you to sign in with your Solana account:\n`;
  message += `${input.address}`;
  if (input.statement) message += `\n\n${input.statement}`;
  let fields = "";
  const add = (line: string) => {
    fields += fields ? `\n${line}` : line;
  };
  if (input.uri) add(`URI: ${input.uri}`);
  if (input.version) add(`Version: ${input.version}`);
  if (input.chainId) add(`Chain ID: ${input.chainId}`);
  if (input.nonce) add(`Nonce: ${input.nonce}`);
  if (input.issuedAt) add(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime) add(`Expiration Time: ${input.expirationTime}`);
  if (input.notBefore) add(`Not Before: ${input.notBefore}`);
  if (input.requestId) add(`Request ID: ${input.requestId}`);
  if (input.resources) {
    add("Resources:");
    const r = input.resources;
    for (let i = 0; i < r.length; i++) add(`- ${r[i]}`);
  }
  if (fields) message += `\n\n${fields}`;
  return message;
}
