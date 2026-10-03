import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.name} — ${BRAND.tagline}`,
    short_name: BRAND.name,
    description: BRAND.description,
    start_url: "/",
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/brand/presign-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/presign-icon.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
