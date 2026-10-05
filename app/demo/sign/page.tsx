import type { Metadata } from "next";
import DemoSignClient from "./DemoSignClient";

export const metadata: Metadata = {
  title: "Pre-sign demo · Presign",
  description: "A controlled demo dApp that sends real signing requests through Presign's review: safe, risky, critical and unverifiable.",
};

export default function DemoSignPage() {
  return <DemoSignClient />;
}
