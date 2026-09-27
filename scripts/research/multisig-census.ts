/**
 * Multisig census — read-only mainnet research.
 *
 *   node scripts/research/multisig-census.ts
 *
 * 1. Reads the configuration of every Squads v4 multisig (threshold, members,
 *    time lock, config authority, activity) via getProgramAccounts.
 * 2. For a list of widely used programs, reads the upgrade authority and
 *    checks whether it is a Squads v4 vault — and if so, how that multisig is
 *    configured.
 *
 * Output:
 *   docs/research/multisig-census.json   aggregate numbers only (publishable)
 *   scripts/research/output/programs.json  per-program detail (git-ignored;
 *                                          responsible disclosure, not publication)
 * Program ids that are not an upgradeable program on mainnet are reported as
 * unverified and excluded — nothing is assumed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { rpc } from "./env.ts";

const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const MULTISIG_DISC = "e07479ba44a14fec";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

/** Widely used mainnet programs (name → id). Ids are verified on-chain before use. */
const PROGRAMS: Record<string, string> = {
  "Jupiter Aggregator v6": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "Jupiter Perps": "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu",
  "Jupiter DCA": "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M",
  "Jupiter Limit Order": "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X",
  "Raydium AMM v4": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "Raydium CLMM": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "Raydium CPMM": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "Orca Whirlpools": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "Meteora DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Meteora Dynamic AMM": "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  "Meteora DAMM v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "Meteora Vault": "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi",
  "Drift Protocol v2": "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
  "Kamino Lend": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  "Kamino Liquidity": "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc",
  "MarginFi v2": "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  "Marinade": "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
  "Save (Solend)": "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo",
  "Phoenix": "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
  "OpenBook v2": "opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb",
  "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "Pump AMM": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "Tensor Swap": "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN",
  "Magic Eden M2": "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
  "Metaplex Token Metadata": "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "Metaplex Bubblegum": "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY",
  "Jito Tip Distribution": "4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7",
  "Zeta Markets": "ZETAxsqBRek56DhiGXrn75yj2NHU3aYUnxvHXpkf3aD",
  "Mango v4": "4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg",
  "Lifinity v2": "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c",
  "Flash Trade": "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn",
  "Wormhole Core": "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  "Wormhole Token Bridge": "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  "Streamflow": "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m",
  "SPL Governance (Realms)": "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
  "Squads v4": SQUADS,
};

interface MultisigRow {
  address: string;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  controlled: boolean;
  members: number;
}

function parseMultisig(address: string, b: Buffer): MultisigRow | null {
  if (b.length < 100) return null;
  const configAuthority = new PublicKey(b.subarray(40, 72)).toBase58();
  const threshold = b.readUInt16LE(72);
  const timeLock = b.readUInt32LE(74);
  const transactionIndex = b.readBigUInt64LE(78);
  const hasRentCollector = b[94] === 1;
  const membersOffset = 94 + 1 + (hasRentCollector ? 32 : 0) + 1;
  if (b.length < membersOffset + 4) return null;
  return { address, threshold, timeLock, transactionIndex, controlled: configAuthority !== DEFAULT_PUBKEY, members: b.readUInt32LE(membersOffset) };
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

function stats(rows: MultisigRow[]) {
  const n = rows.length;
  const multiMember = rows.filter((r) => r.members > 1);
  return {
    count: n,
    noTimeLockPct: pct(rows.filter((r) => r.timeLock === 0).length, n),
    controlledConfigPct: pct(rows.filter((r) => r.controlled).length, n),
    singleSignaturePct: pct(multiMember.filter((r) => r.threshold === 1).length, multiMember.length),
    minorityThresholdPct: pct(multiMember.filter((r) => r.threshold * 2 < r.members).length, multiMember.length),
    singleMemberPct: pct(rows.filter((r) => r.members === 1).length, n),
    medianMembers: n ? [...rows].sort((a, b) => a.members - b.members)[Math.floor(n / 2)].members : null,
  };
}

async function multiAccounts(addresses: string[], encoding: "jsonParsed" | "base64") {
  const out = new Map<string, { owner: string; executable: boolean; data: unknown } | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const r = await rpc<{ value: Array<{ owner: string; executable: boolean; data: unknown } | null> }>("getMultipleAccounts", [chunk, { encoding }]);
    chunk.forEach((a, j) => out.set(a, r.value[j] ?? null));
  }
  return out;
}

async function main() {
  const started = new Date();
  console.error("Fetching Squads v4 multisig accounts…");
  const raw = await rpc<Array<{ pubkey: string; account: { data: [string, string] } }>>("getProgramAccounts", [SQUADS, { encoding: "base64", dataSlice: { offset: 0, length: 140 }, filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(MULTISIG_DISC, "hex")) } }] }], 170_000);
  const rows = raw.flatMap((a) => parseMultisig(a.pubkey, Buffer.from(a.account.data[0], "base64")) ?? []);
  const active = rows.filter((r) => r.transactionIndex >= 1n);
  const busy = rows.filter((r) => r.transactionIndex >= 10n);
  console.error(`${rows.length} multisigs parsed (${active.length} with at least one transaction).`);

  console.error("Mapping vault PDAs of active multisigs…");
  const program = new PublicKey(SQUADS);
  const vaultOwner = new Map<string, MultisigRow>();
  for (const r of active) {
    const ms = new PublicKey(r.address).toBytes();
    for (let v = 0; v < 2; v++) {
      const [vault] = PublicKey.findProgramAddressSync([Buffer.from("multisig"), ms, Buffer.from("vault"), Uint8Array.of(v)], program);
      vaultOwner.set(vault.toBase58(), r);
    }
  }

  console.error("Reading program upgrade authorities…");
  const entries = Object.entries(PROGRAMS);
  const programAccounts = await multiAccounts(entries.map(([, id]) => id), "jsonParsed");
  const verified: Array<{ name: string; id: string; programData: string }> = [];
  const unverified: string[] = [];
  for (const [name, id] of entries) {
    const acc = programAccounts.get(id) as { owner: string; executable: boolean; data: { parsed?: { info?: { programData?: string } } } } | null;
    const programData = acc?.data?.parsed?.info?.programData;
    if (acc && acc.executable && acc.owner === BPF_UPGRADEABLE && programData) verified.push({ name, id, programData });
    else unverified.push(name);
  }
  const pdAccounts = await multiAccounts(verified.map((v) => v.programData), "jsonParsed");
  const programs = verified.map((v) => {
    const info = (pdAccounts.get(v.programData) as { data: { parsed?: { info?: { authority?: string | null } } } } | null)?.data?.parsed?.info;
    const authority = info?.authority ?? null;
    const ms = authority ? vaultOwner.get(authority) : undefined;
    return {
      name: v.name,
      id: v.id,
      authority,
      control: authority === null ? "immutable" : ms ? "squads-v4" : "other (single key, other multisig or DAO)",
      multisig: ms ? { address: ms.address, threshold: ms.threshold, members: ms.members, timeLock: ms.timeLock, controlledConfig: ms.controlled } : null,
    };
  });
  const bySquads = programs.filter((p) => p.multisig);

  const aggregate = {
    generatedAt: started.toISOString(),
    method: "Read-only mainnet-beta RPC. Squads v4 multisig accounts via getProgramAccounts (Multisig discriminator); program upgrade authorities via program/programdata accounts; a Squads vault is matched against vault indexes 0–1 of multisigs with at least one transaction.",
    multisigs: { all: stats(rows), withTransactions: stats(active), withTenOrMoreTransactions: stats(busy) },
    programs: {
      checked: programs.length,
      unverifiedIds: unverified,
      immutable: programs.filter((p) => p.control === "immutable").length,
      squadsV4: bySquads.length,
      other: programs.filter((p) => p.control.startsWith("other")).length,
      squadsV4Config: {
        noTimeLock: bySquads.filter((p) => p.multisig!.timeLock === 0).length,
        controlledConfig: bySquads.filter((p) => p.multisig!.controlledConfig).length,
        minorityThreshold: bySquads.filter((p) => p.multisig!.threshold * 2 < p.multisig!.members).length,
        thresholds: bySquads.map((p) => `${p.multisig!.threshold}/${p.multisig!.members}`).sort(),
      },
    },
  };

  mkdirSync("docs/research", { recursive: true });
  mkdirSync("scripts/research/output", { recursive: true });
  writeFileSync("docs/research/multisig-census.json", `${JSON.stringify(aggregate, null, 2)}\n`);
  writeFileSync("scripts/research/output/programs.json", `${JSON.stringify(programs, null, 2)}\n`);
  console.log(JSON.stringify(aggregate, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
