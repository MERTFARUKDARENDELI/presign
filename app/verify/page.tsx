import type { Metadata } from "next";
import { Suspense } from "react";
import VerifyClient from "./VerifyClient";

export const metadata: Metadata = {
  title: "Verify a proposal · Presign",
  description: "See what a Squads multisig proposal would do — decoded, simulated and checked for authority changes — before you approve it.",
};

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyClient />
    </Suspense>
  );
}
