import type { DigitalAsset } from "@/lib/solana/das";
import { buildAssessment } from "../engine";
import type { RiskAssessment, RiskSignal } from "../risk";
import { hasLink, scanText } from "../text-signals";
import type { Evidence } from "../types";
import { assessLinksInText, urlEvidenceText, worstUrlLevel } from "../url-reputation";

/**
 * NFT / compressed NFT (cNFT) risk rules. cNFTs are Merkle-tree leaves, NOT
 * SPL token accounts; this module never feeds the SPL cleanup pipeline.
 *
 * A link in a description alone is normal for NFTs and is NOT flagged; the
 * scam pattern is a link in the NAME, or a link combined with claim/reward
 * wording, typically in unsolicited, unverified (c)NFT airdrops.
 */
export function evaluateAssetRisk(asset: DigitalAsset, now?: Date): RiskAssessment {
  const prefix = `asset:${asset.id}`;
  const evidence: Evidence[] = [];
  const signals: RiskSignal[] = [];
  const ev = (key: string, e: Omit<Evidence, "id">) => {
    const id = `${prefix}:${key}`;
    evidence.push({ id, ...e });
    return id;
  };

  ev("kind", { source: "HELIUS_DAS", label: "Asset type", observed: asset.compressed ? "compressed NFT (cNFT)" : asset.interface });

  const nameSignals = scanText(`${asset.name ?? ""} ${asset.symbol ?? ""}`);
  const descSignals = scanText(asset.description);
  const unverified = !asset.collectionVerified && asset.verifiedCreators === 0;

  if (hasLink(nameSignals)) {
    // Defanged hosts only; raw URLs from untrusted metadata are not echoed.
    const hosts = assessLinksInText([...nameSignals.urls, ...nameSignals.domains]).map((a) => a.displayHost);
    const id = ev("nameLink", { source: "HELIUS_DAS", label: "Link in asset name", observed: hosts.join(", ").slice(0, 200), condition: "name/symbol contains URL or domain" });
    signals.push({ code: "ASSET_NAME_LINK", title: "Phishing-style link in name", description: "The asset name advertises a website, a common drainer lure. Do not visit it or sign transactions from it.", severity: "HIGH", evidenceIds: [id] });
  }

  const lure = [...new Set([...nameSignals.lureKeywords, ...descSignals.lureKeywords])];
  if (lure.length > 0 && (hasLink(nameSignals) || hasLink(descSignals) || asset.externalUrl)) {
    const id = ev("lure", { source: "HELIUS_DAS", label: "Claim/reward wording with link", observed: lure.join(", "), condition: "lure keywords + external link" });
    signals.push({ code: "ASSET_CLAIM_LURE", title: "Airdrop claim lure", description: "Metadata pushes you to visit a site to claim a reward — a typical wallet-drainer pattern.", severity: asset.compressed && unverified ? "HIGH" : "MEDIUM", evidenceIds: [id] });
  }

  // Links anywhere in the metadata: only phishing-pattern links become a signal
  // (an unknown domain is not phishing; a description link alone is normal).
  const links = assessLinksInText([...nameSignals.urls, ...nameSignals.domains, ...descSignals.urls, ...descSignals.domains, ...(asset.externalUrl ? [asset.externalUrl] : [])]);
  const flagged = links.filter((a) => a.level === "MEDIUM" || a.level === "HIGH");
  if (flagged.length > 0) {
    const id = ev("linkReputation", { source: "DETERMINISTIC_RULE", label: "Link pattern checks", observed: flagged.map(urlEvidenceText).join("; ").slice(0, 300), condition: "obfuscation / impersonation / shortener patterns; no external reputation service" });
    const high = worstUrlLevel(flagged) === "HIGH";
    signals.push({ code: high ? "ASSET_PHISHING_URL" : "ASSET_SUSPICIOUS_URL", title: high ? "Phishing-pattern link" : "Suspicious link", description: "A metadata link matches deterministic phishing patterns (look-alike brand, hidden destination or obfuscation). Do not open it.", severity: high ? "HIGH" : "MEDIUM", evidenceIds: [id] });
  }

  if (nameSignals.promptInjection || descSignals.promptInjection) {
    const id = ev("injection", { source: "HELIUS_DAS", label: "Instruction-like text in metadata", observed: true, condition: "text attempts to instruct an AI/system" });
    signals.push({ code: "ASSET_METADATA_INJECTION", title: "Manipulative metadata text", description: "Metadata contains text that tries to instruct automated systems. It was treated as untrusted data.", severity: "MEDIUM", evidenceIds: [id] });
  }

  if (asset.compressed && unverified && signals.length > 0) {
    const id = ev("unverified", { source: "HELIUS_DAS", label: "Verified collection / creators", observed: "none", condition: "no verified collection and no verified creator" });
    signals.push({ code: "ASSET_UNVERIFIED_SPAM_CNFT", title: "Unverified spam cNFT", description: "Unverified compressed NFT combined with lure signals.", severity: "MEDIUM", evidenceIds: [id] });
  }

  // DAS is the only source for asset data; its response was schema-validated.
  return buildAssessment({
    category: "asset",
    signals,
    evidence,
    sources: [{ source: "HELIUS_DAS", status: "OK", detail: "Asset metadata" }],
    // Off-chain JSON and linked sites are not inspected, so metadata analysis is
    // always PARTIAL: an asset without signals is UNKNOWN, never SAFE.
    status: "PARTIAL",
    now,
  });
}
