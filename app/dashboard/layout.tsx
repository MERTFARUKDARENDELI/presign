import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Wallet tools · Presign",
  description: "Scan a Solana wallet's tokens, authorities and approvals, and clean up what you no longer need.",
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return children;
}
