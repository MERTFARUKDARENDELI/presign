import "server-only";

export type Cluster = "mainnet-beta" | "devnet";

export interface RpcProvider {
  name: "helius" | "fallback";
  source: "HELIUS_RPC" | "PUBLIC_RPC";
  /** Contains the API key for Helius — never log or return to clients. */
  url: string;
  /** Helius DAS (getAsset, getAssetsByOwner) is only available on Helius. */
  supportsDas: boolean;
}

const PUBLIC_RPC: Record<Cluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

export function getCluster(): Cluster {
  return process.env.SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";
}

export function getRpcProviders(): RpcProvider[] {
  const cluster = getCluster();
  const providers: RpcProvider[] = [];
  const key = process.env.HELIUS_API_KEY?.trim();

  if (key) {
    const host = cluster === "devnet" ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
    providers.push({
      name: "helius",
      source: "HELIUS_RPC",
      url: `https://${host}/?api-key=${encodeURIComponent(key)}`,
      supportsDas: true,
    });
  }

  if (process.env.SOLANA_DISABLE_PUBLIC_FALLBACK !== "true") {
    providers.push({
      name: "fallback",
      source: "PUBLIC_RPC",
      url: process.env.SOLANA_FALLBACK_RPC_URL?.trim() || PUBLIC_RPC[cluster],
      supportsDas: false,
    });
  }

  return providers;
}

export function isHeliusConfigured(): boolean {
  return Boolean(process.env.HELIUS_API_KEY?.trim());
}
