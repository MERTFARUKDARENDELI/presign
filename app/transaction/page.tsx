import { Suspense } from "react";
import TransactionClient from "./TransactionClient";

export default function TransactionPage() {
  return (
    <Suspense>
      <TransactionClient />
    </Suspense>
  );
}
