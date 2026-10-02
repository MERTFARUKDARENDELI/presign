import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Demo · Presign",
  description: "A guided demo of the wallet scanner and transaction check, with sample data and no wallet.",
};

export default function DemoLayout({ children }: { children: ReactNode }) {
  return children;
}
