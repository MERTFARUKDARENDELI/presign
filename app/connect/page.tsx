import type { Metadata } from "next";
import { Suspense } from "react";
import ConnectClient from "./ConnectClient";

export const metadata: Metadata = {
  title: "Secure connect · Presign",
  description: "Presign checks the connection context before your wallet opens, then verifies wallet ownership with a signature that authorizes nothing.",
};

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectClient />
    </Suspense>
  );
}
