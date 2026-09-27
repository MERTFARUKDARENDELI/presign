import "server-only";
import { AppError } from "@/lib/api/errors";
import { buildDemoTransaction, buildDemoWalletScan } from "@/lib/demo/scenario";
import { analyzeToken } from "@/lib/token/scanner";
import { analyzeTransaction } from "@/lib/transaction/analyze";
import { scanWallet } from "@/lib/wallet/scan";
import type { WalletSecurityScan } from "@/lib/wallet/scan-core";
import type { SecurityDataProvider } from "./tools";

export function createLiveProvider(wallet: string | null): SecurityDataProvider {
  let scan: Promise<WalletSecurityScan> | null = null;
  return {
    mode: "live",
    wallet,
    getWalletScan: () => {
      if (!wallet) return Promise.reject(new AppError("INVALID_WALLET", "No wallet selected."));
      scan ??= scanWallet(wallet);
      return scan;
    },
    analyzeToken: (mint) => analyzeToken(mint),
    analyzeTransaction: (input) => analyzeTransaction(input, wallet ?? undefined),
  };
}

export function createDemoProvider(): SecurityDataProvider {
  const scan = buildDemoWalletScan();
  return {
    mode: "demo",
    wallet: scan.snapshot.address,
    getWalletScan: async () => scan,
    analyzeToken: async (mint) => {
      const t = scan.tokens.find((x) => x.holding.mint === mint);
      if (!t?.report) throw new AppError("TOKEN_NOT_FOUND", "Token is not part of the demo wallet.");
      return t.report;
    },
    analyzeTransaction: async () => buildDemoTransaction().analysis,
  };
}
