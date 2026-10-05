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

export function createSignInMessageText(input: SignInInput & { domain: string; address: string }): string {
  let message = `${input.domain} wants you to sign in with your Solana account:\n`;
  message += `${input.address}`;
  if (input.statement) message += `\n\n${input.statement}`;
  const fields: string[] = [];
  if (input.uri) fields.push(`URI: ${input.uri}`);
  if (input.version) fields.push(`Version: ${input.version}`);
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
  if (input.nonce) fields.push(`Nonce: ${input.nonce}`);
  if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime) fields.push(`Expiration Time: ${input.expirationTime}`);
  if (input.notBefore) fields.push(`Not Before: ${input.notBefore}`);
  if (input.requestId) fields.push(`Request ID: ${input.requestId}`);
  if (input.resources) {
    fields.push("Resources:");
    for (const resource of input.resources) fields.push(`- ${resource}`);
  }
  if (fields.length) message += `\n\n${fields.join("\n")}`;
  return message;
}
