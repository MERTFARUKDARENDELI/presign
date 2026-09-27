import { describe, expect, it } from "vitest";
import { evaluateAssetRisk } from "@/lib/security/rules/asset";
import { evaluateTokenRisk } from "@/lib/security/rules/token";
import { assessLinksInText, assessUrl, defang, URL_REPUTATION_CAPABILITY, urlEvidenceText, worstUrlLevel } from "@/lib/security/url-reputation";
import type { DigitalAsset } from "@/lib/solana/das";
import { parseMintAccount } from "@/lib/solana/parsers";
import { MINT, parsedMint } from "../helpers/fixtures";

const codes = (u: string) => assessUrl(u).signals.map((s) => s.code);
const ZWSP = String.fromCharCode(0x200b);

describe("assessUrl — normalization", () => {
  it("normalizes scheme-less, www and bare domains; lower-cases the host; strips wrapping punctuation", () => {
    expect(assessUrl("Example.COM/path")).toMatchObject({ valid: true, host: "example.com", registrableDomain: "example.com" });
    expect(assessUrl("www.example.com").host).toBe("www.example.com");
    expect(assessUrl("(https://example.com/a).").host).toBe("example.com");
    expect(assessUrl("shop.example.co.uk").registrableDomain).toBe("example.co.uk");
  });

  it("invalid input is INVALID, never phishing and never safe", () => {
    for (const bad of ["", "not a url", "http://", "localhost", "https://exa mple.com"]) {
      const a = assessUrl(bad);
      expect(a.verdict, bad).toBe("INVALID");
      expect(a.level).toBeNull();
      expect(a.valid).toBe(false);
    }
  });

  it("defangs hosts so evidence can never be a clickable link", () => {
    expect(defang("a.b.xyz")).toBe("a[.]b[.]xyz");
    const a = assessUrl("https://jup-claim.xyz/free?ref=123");
    expect(a.displayHost).toBe("jup-claim[.]xyz");
    const text = urlEvidenceText(a);
    expect(text).not.toContain("https://");
    expect(text).not.toContain("ref=123");
    expect(text).not.toContain("jup-claim.xyz");
  });
});

describe("assessUrl — unknown ≠ malicious", () => {
  it("an unknown domain without patterns is NO_SIGNAL (reputation unknown), not phishing", () => {
    const a = assessUrl("https://my-small-project.com/docs");
    expect(a.verdict).toBe("NO_SIGNAL");
    expect(a.level).toBeNull();
    expect(a.signals).toEqual([]);
    expect(urlEvidenceText(a)).toContain("reputation unknown");
  });

  it("a known domain is identity only (KNOWN_DOMAIN), and other patterns still apply", () => {
    expect(assessUrl("https://jup.ag/swap").verdict).toBe("KNOWN_DOMAIN");
    expect(assessUrl("https://phantom.app").knownDomain).toBe(true);
    expect(codes("http://solana.com")).toEqual(["URL_INSECURE_HTTP"]);
  });

  it("reports that no external reputation service ran (no API key, no pretend lookup)", () => {
    expect(assessUrl("example.com").reputation).toEqual(URL_REPUTATION_CAPABILITY);
    expect(URL_REPUTATION_CAPABILITY.status).toBe("NOT_CONFIGURED");
  });
});

describe("assessUrl — suspicious and obfuscated patterns", () => {
  it("brand name on a foreign domain is MEDIUM impersonation", () => {
    const a = assessUrl("phantom-wallet-support.com");
    expect(a.signals.map((s) => s.code)).toContain("URL_BRAND_IMPERSONATION");
    expect(a.level).toBe("MEDIUM");
    expect(a.verdict).toBe("SUSPICIOUS");
  });

  it("short brand tokens match whole labels only (no false positive inside other words)", () => {
    expect(codes("orchestra-music.com")).not.toContain("URL_BRAND_IMPERSONATION");
    expect(codes("jupyter.org")).not.toContain("URL_BRAND_IMPERSONATION");
    expect(codes("orca-rewards.net")).toContain("URL_BRAND_IMPERSONATION");
    // calibrated on real mainnet metadata: meme-coin domains that merely contain "solana" are not impersonation
    expect(codes("catwifhatsolana.com")).not.toContain("URL_BRAND_IMPERSONATION");
    expect(codes("solana-airdrop.com")).toContain("URL_BRAND_IMPERSONATION");
  });

  it("look-alike spelling (digit substitution) is HIGH", () => {
    expect(assessUrl("ph4ntom.app").signals.map((s) => s.code)).toContain("URL_BRAND_LOOKALIKE");
    expect(assessUrl("so1flare.com").level).toBe("HIGH");
  });

  it("userinfo '@' trick, hidden characters and script schemes are HIGH", () => {
    expect(codes("https://phantom.app@evil-site.com/login")).toContain("URL_USERINFO");
    expect(assessUrl("https://phantom.app@evil-site.com").host).toBe("evil-site.com");
    expect(codes(`https://exa${ZWSP}mple.com`)).toContain("URL_HIDDEN_CHARACTERS");
    const js = assessUrl("javascript:alert(1)");
    expect(js.signals.map((s) => s.code)).toEqual(["URL_DANGEROUS_SCHEME"]);
    expect(js.level).toBe("HIGH");
    expect(js.displayHost).toBe("[javascript link]");
  });

  it("IP hosts (incl. integer-encoded), punycode and shorteners are MEDIUM", () => {
    expect(codes("http://192.168.1.10/claim")).toContain("URL_IP_HOST");
    const encoded = assessUrl("http://3232235777/");
    expect(encoded.host).toBe("192.168.1.1");
    expect(encoded.signals.map((s) => s.code)).toContain("URL_IP_HOST");
    expect(codes("https://xn--phntom-3ua.app")).toContain("URL_PUNYCODE");
    expect(codes("bit.ly/abc")).toContain("URL_SHORTENER");
  });

  it("weak patterns alone stay LOW", () => {
    const a = assessUrl("https://some-project.xyz");
    expect(a.signals.map((s) => s.code)).toEqual(["URL_SUSPICIOUS_TLD"]);
    expect(a.level).toBe("LOW");
    expect(a.verdict).toBe("WEAK_SIGNALS");
    expect(assessUrl("a.b.c.d.example.com").signals.map((s) => s.code)).toContain("URL_DEEP_SUBDOMAIN");
  });

  it("independent red flags combine to HIGH, but never CRITICAL", () => {
    // brand impersonation (MEDIUM) + lure wording (LOW) + suspicious TLD (LOW)
    const a = assessUrl("https://jup-claim.xyz/airdrop");
    expect(a.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["URL_BRAND_IMPERSONATION", "URL_LURE_WORDING", "URL_SUSPICIOUS_TLD", "URL_MULTIPLE_RED_FLAGS"]));
    expect(a.level).toBe("HIGH");
    expect(a.verdict).toBe("LIKELY_PHISHING");
    // two independent MEDIUM flags: brand impersonation + punycode
    const two = assessUrl("https://phantom.xn--80ak6aa92e.com");
    expect(two.signals.map((s) => s.code)).toEqual(expect.arrayContaining(["URL_PUNYCODE", "URL_BRAND_IMPERSONATION", "URL_MULTIPLE_RED_FLAGS"]));
    expect(two.level).toBe("HIGH");
    // a single MEDIUM flag is not escalated
    expect(assessUrl("bit.ly/abc")).toMatchObject({ level: "MEDIUM", verdict: "SUSPICIOUS" });
    // severity type has no CRITICAL: the worst any URL can reach is HIGH
    const worst = assessUrl("javascript:void(0)").level;
    expect(["LOW", "MEDIUM", "HIGH", null]).toContain(worst);
  });

  it("assessLinksInText dedupes hosts, caps at 5, and reports the worst level", () => {
    const list = assessLinksInText(["https://a.com", "a.com", "b.com", "c.com", "d.com", "e.com", "f.com"]);
    expect(list).toHaveLength(5);
    expect(worstUrlLevel(list)).toBeNull();
    expect(worstUrlLevel(assessLinksInText(["example.com", "ph4ntom.app"]))).toBe("HIGH");
  });
});

describe("URL reputation → risk engine", () => {
  const baseToken = (metadata: { name?: string; symbol?: string; description?: string }) =>
    evaluateTokenRisk({
      mintAddress: MINT.toBase58(),
      mint: parseMintAccount(MINT.toBase58(), parsedMint({})),
      mintStatus: "OK",
      rugcheck: null,
      concentration: null,
      concentrationStatus: "SKIPPED",
      metadata: { ...metadata, source: "HELIUS_DAS" },
      metadataStatus: "OK",
    });

  it("a phishing-pattern link in the token name adds evidence-backed URL signals; evidence is defanged", () => {
    const r = baseToken({ name: "Claim at ph4ntom-drop.xyz", symbol: "FREE" });
    const sig = r.signals.find((s) => s.code === "TOKEN_METADATA_PHISHING_URL")!;
    expect(sig.severity).toBe("HIGH");
    const ev = r.evidence.find((e) => e.id === sig.evidenceIds[0])!;
    expect(ev.id).toBe(`token:${MINT.toBase58()}:meta.linkReputation`);
    expect(ev.source).toBe("DETERMINISTIC_RULE");
    expect(String(ev.observed)).toContain("ph4ntom-drop[.]xyz");
    expect(r.evidence.find((e) => e.id.endsWith("meta.link"))?.observed).toBe("ph4ntom-drop[.]xyz");
    expect(r.level).not.toBe("CRITICAL");
  });

  it("an ordinary link in a token description is not flagged; a phishing one is", () => {
    const plain = baseToken({ name: "Good Token", symbol: "GOOD", description: "Website: https://goodtoken.com" });
    expect(plain.signals.map((s) => s.code).filter((c) => c.includes("URL"))).toEqual([]);
    const bad = baseToken({ name: "Good Token", symbol: "GOOD", description: "Support: https://solflare.com@wallet-restore.site" });
    expect(bad.signals.map((s) => s.code)).toContain("TOKEN_METADATA_PHISHING_URL");
  });

  const asset = (over: Partial<DigitalAsset>): DigitalAsset => ({
    id: MINT.toBase58(), kind: "nft", interface: "V1_NFT", compressed: false, name: "Art #1", symbol: null, description: null,
    image: null, externalUrl: null, jsonUri: null, owner: null, frozen: false, delegate: null, collection: null,
    collectionVerified: true, verifiedCreators: 1, burnt: false, mutable: null, tree: null, ...over,
  }) satisfies DigitalAsset;

  it("assets: unknown external_url is not flagged; shortener/look-alike links are", () => {
    expect(evaluateAssetRisk(asset({ externalUrl: "https://artist-site.com" })).signals.map((s) => s.code)).toEqual([]);
    expect(evaluateAssetRisk(asset({ externalUrl: "https://bit.ly/x" })).signals.map((s) => s.code)).toContain("ASSET_SUSPICIOUS_URL");
    expect(evaluateAssetRisk(asset({ description: "mint at magic3den.io" })).signals.map((s) => s.code)).toContain("ASSET_PHISHING_URL");
  });
});
