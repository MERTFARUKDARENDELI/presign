/**
 * Devnet end-to-end demo of Presign Guard with a real Squads v4 multisig:
 * the Drift attack against a guarded protocol.
 *
 *   setup           2-of-3 multisig, a token whose mint authority the vault holds,
 *                   a guard (proposer = vault, 3 guardians, delay), and proposal #1
 *                   handing the mint authority to the guard.
 *   attack-propose  proposal #2: the vault schedules "set mint authority → attacker"
 *                   through the guard, approved by one member (verify it in Presign now).
 *   attack-execute  second approval and execution: the action is now pending.
 *   veto            an independent guardian vetoes it.
 *   execute-action  try to run the action (fails after a veto; succeeds after the delay otherwise).
 *   status          addresses, balances and links.
 *
 * Run inside WSL/Linux (devnet must be reachable):
 *   node --experimental-transform-types --import ./scripts/devnet/register.mjs scripts/devnet/guard-demo.ts <step>
 * Env: SOLANA_RPC_URL (default devnet), GUARD_PROGRAM_ID (default guard/Anchor.toml's),
 * PRESIGN_PUBLIC_URL (for links), GUARD_DELAY_SECONDS (default 600), DEMO_PAYER (keypair file).
 * Keys and state stay in ~/.presign-demo, never in the repository. Devnet only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { AuthorityType, createMint, createSetAuthorityInstruction, getMint } from "@solana/spl-token";
import { createRequire } from "node:module";
import type * as SquadsSdk from "@sqds/multisig";
import { createGuardInstruction, decodeActionAccount, decodeGuardAccount, executeInstruction, scheduleInstruction, vetoInstruction, type GuardInstructionData } from "@/lib/guard/codec";
import { actionPda, guardPda, guardSignerPda } from "@/lib/guard/constants";

// The SDK's ESM build imports a CommonJS dependency by name, which Node rejects; its CommonJS build works.
const multisig = createRequire(import.meta.url)("@sqds/multisig") as typeof SquadsSdk;

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM = process.env.GUARD_PROGRAM_ID ?? readFileSync(new URL("../../guard/Anchor.toml", import.meta.url), "utf8").match(/\[programs\.devnet\]\s*presign_guard = "([^"]+)"/)![1];
const PUBLIC_URL = (process.env.PRESIGN_PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DELAY = Number(process.env.GUARD_DELAY_SECONDS ?? 600);
const DIR = join(homedir(), ".presign-demo");
const conn = new Connection(RPC, "confirmed");

interface State {
  multisig?: string;
  vault?: string;
  mint?: string;
  guard?: string;
  handToGuard?: string;
  attack?: string;
  action?: string;
}

function keypair(name: string): Keypair {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = join(DIR, `${name}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.DEMO_PAYER ?? join(homedir(), ".config/solana/id.json"), "utf8")) as number[]));
const member2 = keypair("member2");
const member3 = keypair("member3");
const guardian = keypair("guardian");
const attacker = keypair("attacker").publicKey;

const stateFile = join(DIR, "state.json");
const load = (): State => (existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as State) : {});
const save = (s: State) => writeFileSync(stateFile, JSON.stringify(s, null, 2));

async function send(ixs: TransactionInstruction[], signers: Keypair[], lookups: AddressLookupTableAccount[] = []): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookups);
  const tx = new VersionedTransaction(message);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

async function fund(to: PublicKey, sol: number) {
  if ((await conn.getBalance(to)) >= (sol / 2) * LAMPORTS_PER_SOL) return;
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })], [payer]);
}

function ms(s: State) {
  if (!s.multisig || !s.vault) throw new Error("Run `setup` first.");
  return { multisigPda: new PublicKey(s.multisig), vault: new PublicKey(s.vault) };
}

/** Creates a vault transaction + proposal and approves it with the given members; returns its index. */
async function propose(s: State, ixs: TransactionInstruction[], memo: string, approvers: Keypair[]): Promise<bigint> {
  const { multisigPda, vault } = ms(s);
  const account = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
  const index = BigInt(account.transactionIndex.toString()) + 1n;
  const transactionMessage = new TransactionMessage({ payerKey: vault, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: ixs });
  await send(
    [
      multisig.instructions.vaultTransactionCreate({ multisigPda, transactionIndex: index, creator: payer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage, memo }),
      multisig.instructions.proposalCreate({ multisigPda, creator: payer.publicKey, transactionIndex: index }),
    ],
    [payer],
  );
  for (const m of approvers) await send([multisig.instructions.proposalApprove({ multisigPda, transactionIndex: index, member: m.publicKey })], [m]);
  return index;
}

async function executeProposal(s: State, index: bigint, member: Keypair) {
  const { multisigPda } = ms(s);
  const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection: conn, multisigPda, transactionIndex: index, member: member.publicKey });
  return send([instruction], [member], lookupTableAccounts);
}

const link = (q: string) => `${PUBLIC_URL}/verify?q=${encodeURIComponent(q)}`;

async function setup() {
  const s = load();
  console.log(`payer ${payer.publicKey.toBase58()} · ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL · guard program ${PROGRAM}`);
  for (const k of [member2, member3, guardian]) await fund(k.publicKey, 0.05);

  if (!s.multisig) {
    const createKey = keypair("multisig-create-key");
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [programConfig] = multisig.getProgramConfigPda({});
    const { treasury } = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfig);
    const members = [payer.publicKey, member2.publicKey, member3.publicKey].map((key) => ({ key, permissions: multisig.types.Permissions.all() }));
    await send([multisig.instructions.multisigCreateV2({ treasury, creator: payer.publicKey, multisigPda, configAuthority: null, threshold: 2, members, timeLock: 0, createKey: createKey.publicKey, rentCollector: null, memo: "Presign Guard demo" })], [payer, createKey]);
    s.multisig = multisigPda.toBase58();
    s.vault = multisig.getVaultPda({ multisigPda, index: 0 })[0].toBase58();
    save(s);
    console.log(`multisig ${s.multisig} (2 of 3, no time lock) · vault ${s.vault}`);
  }
  const { vault } = ms(s);
  await fund(vault, 0.1);

  if (!s.mint) {
    s.mint = (await createMint(conn, payer, vault, null, 6)).toBase58();
    save(s);
    console.log(`token ${s.mint}: mint authority = the vault (stands in for a protocol's admin key)`);
  }

  if (!s.guard) {
    const createKey = keypair("guard-create-key");
    const guard = guardPda(PROGRAM, createKey.publicKey.toBase58());
    const config = { proposer: vault.toBase58(), guardians: [member2, member3, guardian].map((k) => k.publicKey.toBase58()), delaySeconds: DELAY };
    await send([createGuardInstruction(PROGRAM, { guard, createKey: createKey.publicKey.toBase58(), payer: payer.publicKey.toBase58(), config })], [payer, createKey]);
    s.guard = guard;
    save(s);
    console.log(`guard ${guard}: proposer = vault, 3 guardians, delay ${DELAY}s`);
  }

  const signer = new PublicKey(guardSignerPda(PROGRAM, s.guard));
  const mint = await getMint(conn, new PublicKey(s.mint));
  if (!s.handToGuard && mint.mintAuthority?.equals(vault)) {
    const index = await propose(s, [createSetAuthorityInstruction(mint.address, vault, AuthorityType.MintTokens, signer)], "Move mint authority to Presign Guard", [payer, member2]);
    await executeProposal(s, index, payer);
    s.handToGuard = index.toString();
    save(s);
    console.log(`proposal #${index}: mint authority → guard signer ${signer.toBase58()} (executed)`);
    console.log(`  Presign: ${link(`${s.multisig} #${index}`)}`);
  }
  console.log("setup done");
}

async function attackPropose() {
  const s = load();
  const { vault } = ms(s);
  if (!s.guard || !s.mint) throw new Error("Run `setup` first.");
  const signer = guardSignerPda(PROGRAM, s.guard);
  const guardAccount = decodeGuardAccount(Uint8Array.from((await conn.getAccountInfo(new PublicKey(s.guard)))!.data));
  const action = actionPda(PROGRAM, s.guard, guardAccount.actionCount);
  const takeover = createSetAuthorityInstruction(new PublicKey(s.mint), new PublicKey(signer), AuthorityType.MintTokens, attacker);
  const scheduled: GuardInstructionData = { programId: takeover.programId.toBase58(), accounts: takeover.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Uint8Array.from(takeover.data) };
  const ix = scheduleInstruction(PROGRAM, { guard: s.guard, action, proposer: vault.toBase58(), payer: vault.toBase58(), instructions: [scheduled], memo: "Rotate mint authority to the new ops key" });
  // Like Drift: a routine-sounding memo, approved by one member who did not read the bytes.
  const index = await propose(s, [ix], "Rotate mint authority", [payer]);
  s.attack = index.toString();
  s.action = action;
  save(s);
  console.log(`proposal #${index}: schedules "mint authority → ${attacker.toBase58()}" through the guard; 1 of 2 approvals`);
  console.log(`  Presign (before the second signer approves): ${link(`${s.multisig} #${index}`)}`);
}

async function attackExecute() {
  const s = load();
  if (!s.attack || !s.action) throw new Error("Run `attack-propose` first.");
  const { multisigPda } = ms(s);
  const index = BigInt(s.attack);
  await send([multisig.instructions.proposalApprove({ multisigPda, transactionIndex: index, member: member2.publicKey })], [member2]);
  await executeProposal(s, index, payer);
  const a = decodeActionAccount(Uint8Array.from((await conn.getAccountInfo(new PublicKey(s.action)))!.data));
  console.log(`action ${s.action} is ${a.status}; executable after ${new Date(Number(a.eta) * 1000).toISOString()} unless a guardian vetoes`);
  console.log(`  Presign (guardians): ${link(s.action)}`);
}

async function veto() {
  const s = load();
  if (!s.guard || !s.action) throw new Error("Nothing to veto.");
  await fund(guardian.publicKey, 0.02);
  const sig = await send([vetoInstruction(PROGRAM, { guard: s.guard, action: s.action, guardian: guardian.publicKey.toBase58() })], [guardian]);
  console.log(`vetoed by independent guardian ${guardian.publicKey.toBase58()} · ${sig}`);
}

async function executeAction() {
  const s = load();
  if (!s.guard || !s.action) throw new Error("No action.");
  const action = { ...decodeActionAccount(Uint8Array.from((await conn.getAccountInfo(new PublicKey(s.action)))!.data)), address: s.action };
  try {
    console.log(`executed: ${await send([executeInstruction(PROGRAM, { guard: s.guard, action })], [payer])}`);
  } catch (e) {
    console.log(`execute refused by the program: ${e instanceof Error ? e.message : e}`);
  }
}

async function status() {
  const s = load();
  console.log(JSON.stringify({ rpc: RPC, program: PROGRAM, payer: payer.publicKey.toBase58(), members: [payer, member2, member3].map((k) => k.publicKey.toBase58()), guardian: guardian.publicKey.toBase58(), attacker: attacker.toBase58(), ...s }, null, 2));
  if (s.mint) console.log(`mint authority now: ${(await getMint(conn, new PublicKey(s.mint))).mintAuthority?.toBase58() ?? "none"}`);
  if (s.action) {
    const info = await conn.getAccountInfo(new PublicKey(s.action));
    if (info) console.log(`action status: ${decodeActionAccount(Uint8Array.from(info.data)).status}`);
  }
  if (s.multisig) console.log(`Presign: ${link(s.multisig)}${s.guard ? ` · ${link(s.guard)}` : ""}`);
}

const steps: Record<string, () => Promise<void>> = { setup, "attack-propose": attackPropose, "attack-execute": attackExecute, veto, "execute-action": executeAction, status };
const step = process.argv[2] ?? "status";
if (!steps[step]) {
  console.error(`Unknown step "${step}". Steps: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await steps[step]();
