import { SystemProgram, Transaction, TransactionMessage, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { messageHashOfTx, signExactly, verifyTransactionSignatures, type SignRequest } from "@/lib/wallet/signing";
import { ATTACKER, BLOCKHASH, buildTx, keypair, WALLET } from "../helpers/fixtures";

type Signable = Transaction | VersionedTransaction;
type WalletSign = SignRequest["sign"];

const OWNER = keypair(1); // === WALLET
const OTHER = keypair(2); // === ATTACKER

const transfer = (lamports = 1) => SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports });

function legacyTx(lamports = 1): Uint8Array {
  return buildTx([transfer(lamports)]).bytes;
}

function v0Tx(lamports = 1): Uint8Array {
  const msg = new TransactionMessage({ payerKey: WALLET, recentBlockhash: BLOCKHASH, instructions: [transfer(lamports)] }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}

function signWith(kp: Keypair, tx: Signable): void {
  if (tx instanceof VersionedTransaction) tx.sign([kp]);
  else tx.partialSign(kp);
}

/** An honest wallet: signs exactly what it is given. */
const honestWallet = (kp: Keypair = OWNER): WalletSign =>
  (async <T extends Signable>(tx: T): Promise<T> => {
    signWith(kp, tx);
    return tx;
  }) as WalletSign;

/** Returns the wallet's signed tx after `mutate` (simulates a malicious or buggy wallet). */
const walletThat = (mutate: (tx: Signable) => void): WalletSign =>
  (async <T extends Signable>(tx: T): Promise<T> => {
    mutate(tx);
    return tx;
  }) as WalletSign;

const V0_OK = new Set<unknown>(["legacy", 0]);

async function request(bytes: Uint8Array, overrides: Partial<SignRequest> = {}): Promise<SignRequest> {
  return { bytes, confirmedHash: await messageHashOfTx(bytes), signer: WALLET.toBase58(), sign: honestWallet(), supportedVersions: V0_OK, ...overrides };
}

describe("signExactly — happy paths", () => {
  it("signs a legacy transaction and returns exactly the confirmed message with a valid signature", async () => {
    const bytes = legacyTx();
    const req = await request(bytes);
    const out = await signExactly(req);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(await messageHashOfTx(out.signed)).toBe(req.confirmedHash);
    expect(verifyTransactionSignatures(out.signed)).toEqual({ ok: true, missing: [], invalid: [] });
  });

  it("signs a v0 transaction when the wallet declares v0 support", async () => {
    const out = await signExactly(await request(v0Tx()));
    expect(out.ok).toBe(true);
    if (out.ok) expect(verifyTransactionSignatures(out.signed).ok).toBe(true);
  });
});

describe("signExactly — blocks before the wallet is asked", () => {
  it("blocks when the transaction changed after the user confirmed it (tampering)", async () => {
    const sign = vi.fn(honestWallet());
    const confirmedHash = await messageHashOfTx(legacyTx(1));
    const out = await signExactly({ ...(await request(legacyTx(1_000_000))), confirmedHash, sign: sign as WalletSign });
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("blocks when the connected wallet is not a required signer (wrong signer)", async () => {
    const sign = vi.fn(honestWallet(OTHER));
    const out = await signExactly(await request(legacyTx(), { signer: ATTACKER.toBase58(), sign: sign as WalletSign }));
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses v0 for a wallet that does not declare v0 support", async () => {
    const sign = vi.fn(honestWallet());
    for (const supportedVersions of [null, new Set<unknown>(["legacy"])]) {
      const out = await signExactly(await request(v0Tx(), { supportedVersions, sign: sign as WalletSign }));
      expect(out).toMatchObject({ ok: false, kind: "UNSUPPORTED" });
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it("blocks unparseable bytes", async () => {
    const out = await signExactly({ bytes: new Uint8Array([1, 2, 3]), confirmedHash: "x", signer: WALLET.toBase58(), sign: honestWallet() });
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
  });
});

describe("signExactly — verifies what the wallet returns", () => {
  it("reports a user rejection without treating it as success", async () => {
    const reject = (async () => {
      throw new Error("User rejected the request.");
    }) as WalletSign;
    expect(await signExactly(await request(legacyTx(), { sign: reject }))).toMatchObject({ ok: false, kind: "REJECTED" });
  });

  it("blocks a wallet that adds an instruction before signing (legacy)", async () => {
    const out = await signExactly(
      await request(legacyTx(), {
        sign: walletThat((tx) => {
          (tx as Transaction).add(SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: ATTACKER, lamports: 999 }));
          signWith(OWNER, tx);
        }),
      }),
    );
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
    if (!out.ok) expect(out.reason).toMatch(/different transaction/);
  });

  it("blocks a wallet that returns a different v0 message", async () => {
    const swapped = VersionedTransaction.deserialize(v0Tx(5_000_000));
    const out = await signExactly(
      await request(v0Tx(), {
        sign: (async () => {
          swapped.sign([OWNER]);
          return swapped;
        }) as WalletSign,
      }),
    );
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
  });

  it("blocks an invalid signature (legacy and v0)", async () => {
    const corruptLegacy = walletThat((tx) => {
      signWith(OWNER, tx);
      (tx as Transaction).signatures[0].signature![0] ^= 0xff;
    });
    const corruptV0 = walletThat((tx) => {
      signWith(OWNER, tx);
      (tx as VersionedTransaction).signatures[0][0] ^= 0xff;
    });
    expect(await signExactly(await request(legacyTx(), { sign: corruptLegacy }))).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
    expect(await signExactly(await request(v0Tx(), { sign: corruptV0 }))).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
  });

  it("blocks a wallet that returns the transaction unsigned", async () => {
    const out = await signExactly(await request(v0Tx(), { sign: walletThat(() => {}) }));
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
  });

  it("blocks a signature made by a different key placed in the owner's slot", async () => {
    const out = await signExactly(
      await request(v0Tx(), {
        sign: walletThat((tx) => {
          const v = tx as VersionedTransaction;
          const foreign = VersionedTransaction.deserialize(v.serialize());
          // Sign the same message with another key, then smuggle that signature into slot 0.
          const msg = foreign.message.serialize();
          const other = new VersionedTransaction(foreign.message);
          other.addSignature(WALLET, new Uint8Array(64));
          v.signatures[0] = Uint8Array.from(OTHER.secretKey.slice(0, 64).map((b, i) => b ^ msg[i % msg.length]));
        }),
      }),
    );
    expect(out).toMatchObject({ ok: false, kind: "SECURITY_BLOCK" });
  });
});

describe("verifyTransactionSignatures", () => {
  it("lists missing and invalid signers", () => {
    const unsigned = v0Tx();
    expect(verifyTransactionSignatures(unsigned)).toEqual({ ok: false, missing: [WALLET.toBase58()], invalid: [] });

    const tx = VersionedTransaction.deserialize(v0Tx());
    tx.sign([OWNER]);
    tx.signatures[0][10] ^= 0x01;
    expect(verifyTransactionSignatures(tx.serialize())).toEqual({ ok: false, missing: [], invalid: [WALLET.toBase58()] });
  });

  it("can restrict the check to specific signers", () => {
    expect(verifyTransactionSignatures(v0Tx(), [ATTACKER.toBase58()]).ok).toBe(true);
  });
});
