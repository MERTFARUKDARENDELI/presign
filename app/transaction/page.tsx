import type { Metadata } from "next";
import { Suspense } from "react";
import TransactionClient from "./TransactionClient";

export const metadata: Metadata = {
  title: "Check a transaction · Presign",
  description: "Decode, simulate and risk-check a Solana transaction before you sign it — including Squads approvals and durable-nonce signatures.",
};

export default function TransactionPage() {
  return (
    <Suspense>
      <TransactionClient />
    </Suspense>
  );
}
