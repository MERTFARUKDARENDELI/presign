/**
 * Team policy files for Watchtower and the MCP server (PRESIGN_POLICY_FILE):
 * one policy object, or an array of policies told apart by their `multisig`.
 * Only the shape needed to route them is checked here; the Presign API
 * validates every policy it receives. No imports: both run under plain Node.
 */

export type PolicyJson = Record<string, unknown>;

export function parsePolicyFile(text: string): PolicyJson[] {
  const json: unknown = JSON.parse(text);
  const list = Array.isArray(json) ? json : [json];
  if (list.length === 0) throw new Error("The policy file is empty.");
  for (const p of list) {
    if (!p || typeof p !== "object" || Array.isArray(p) || (p as PolicyJson).version !== 1 || typeof (p as PolicyJson).name !== "string") {
      throw new Error('Each policy needs "version": 1 and a "name".');
    }
  }
  return list as PolicyJson[];
}

/** The policy written for this multisig, else the one without a `multisig`, else the only one. */
export function policyFor(policies: PolicyJson[], multisig: string | null): PolicyJson | null {
  if (multisig) {
    const exact = policies.find((p) => p.multisig === multisig);
    if (exact) return exact;
  }
  return policies.find((p) => p.multisig === undefined) ?? (policies.length === 1 ? policies[0] : null);
}

/** First base58 address-looking token in free-form input (a link, "<multisig> #7", …). */
export function firstAddress(input: string): string | null {
  return input.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0] ?? null;
}
