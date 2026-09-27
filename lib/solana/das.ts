import { z } from "zod";

/**
 * Helius DAS asset normalization (pure). All text fields are UNTRUSTED
 * provider/creator supplied content and must never be treated as instructions.
 */

export type AssetKind = "compressed-nft" | "nft" | "fungible" | "other";

export interface DigitalAsset {
  id: string;
  kind: AssetKind;
  interface: string;
  compressed: boolean;
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  externalUrl: string | null;
  jsonUri: string | null;
  owner: string | null;
  frozen: boolean;
  delegate: string | null;
  collection: string | null;
  collectionVerified: boolean;
  verifiedCreators: number;
  burnt: boolean;
  mutable: boolean | null;
  tree: string | null;
}

const text = (max: number) =>
  z.string().transform((v) => v.slice(0, max)).optional().nullable();

const assetSchema = z.object({
  id: z.string().min(32).max(44),
  interface: z.string().default("Unknown"),
  content: z
    .object({
      json_uri: text(512),
      metadata: z
        .object({ name: text(200), symbol: text(50), description: text(2000) })
        .partial()
        .optional(),
      links: z.object({ image: text(512), external_url: text(512) }).partial().optional(),
    })
    .partial()
    .optional(),
  compression: z
    .object({ compressed: z.boolean().optional(), tree: z.string().optional() })
    .partial()
    .optional(),
  ownership: z
    .object({
      owner: z.string().optional(),
      frozen: z.boolean().optional(),
      delegated: z.boolean().optional(),
      delegate: z.string().nullable().optional(),
    })
    .partial()
    .optional(),
  grouping: z
    .array(
      z.object({
        group_key: z.string(),
        group_value: z.string().nullable().optional(),
        verified: z.boolean().optional(),
      }),
    )
    .optional(),
  creators: z.array(z.object({ address: z.string(), verified: z.boolean().optional() })).optional(),
  burnt: z.boolean().optional(),
  mutable: z.boolean().optional(),
});

function kindOf(iface: string, compressed: boolean): AssetKind {
  if (compressed) return "compressed-nft";
  if (iface === "FungibleToken" || iface === "FungibleAsset") return "fungible";
  if (/NFT|Programmable|MplCore/i.test(iface)) return "nft";
  return "other";
}

export function parseDasAsset(raw: unknown): DigitalAsset | null {
  const r = assetSchema.safeParse(raw);
  if (!r.success) return null;
  const a = r.data;
  const compressed = a.compression?.compressed === true;
  const collection = a.grouping?.find((g) => g.group_key === "collection");
  return {
    id: a.id,
    kind: kindOf(a.interface, compressed),
    interface: a.interface,
    compressed,
    name: a.content?.metadata?.name ?? null,
    symbol: a.content?.metadata?.symbol ?? null,
    description: a.content?.metadata?.description ?? null,
    image: a.content?.links?.image ?? null,
    externalUrl: a.content?.links?.external_url ?? null,
    jsonUri: a.content?.json_uri ?? null,
    owner: a.ownership?.owner ?? null,
    frozen: a.ownership?.frozen === true,
    delegate: a.ownership?.delegated ? (a.ownership.delegate ?? null) : null,
    collection: collection?.group_value ?? null,
    collectionVerified: collection?.verified === true,
    verifiedCreators: (a.creators ?? []).filter((c) => c.verified).length,
    burnt: a.burnt === true,
    mutable: a.mutable ?? null,
    tree: a.compression?.tree ?? null,
  };
}
