import type { Metadata } from "next";
import { Suspense } from "react";
import ExtensionReviewClient from "./ExtensionReviewClient";

export const metadata: Metadata = {
  title: "Review signing request · Presign",
  description: "Presign's review of a signing request captured by the Presign browser extension, before your wallet opens.",
  robots: { index: false, follow: false },
};

export default function ExtensionReviewPage() {
  return (
    <Suspense fallback={null}>
      <ExtensionReviewClient />
    </Suspense>
  );
}
