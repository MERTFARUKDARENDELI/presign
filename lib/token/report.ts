import type { RiskAssessment } from "@/lib/security/risk";
import type { TokenAge } from "./age";
import type { RugcheckData } from "./rugcheck-types";
import type { MintInfo, TokenMetadata } from "./types";

export interface TokenSecurityReport {
  mint: string;
  mintInfo: MintInfo | null;
  metadata: TokenMetadata | null;
  rugcheck: RugcheckData | null;
  concentration: { top1Pct: number; top10Pct: number } | null;
  /** Deep scan only; absent from wallet-scan (batch) reports, where age is not checked. */
  age?: TokenAge;
  risk: RiskAssessment;
}
