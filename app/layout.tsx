import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import SecurityHeader from "@/components/SecurityHeader";
import WalletProviders from "@/components/providers/WalletProviders";
import { BRAND } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const TITLE = `${BRAND.name} — ${BRAND.tagline}`;

// Icons and share images come from the file conventions in app/ (icon.png, apple-icon.png,
// favicon.ico, opengraph-image.png, twitter-image.png); on Vercel their absolute URLs use the
// project's production domain.
export const metadata: Metadata = {
  title: TITLE,
  description: BRAND.description,
  applicationName: BRAND.name,
  openGraph: { title: TITLE, description: BRAND.description, siteName: BRAND.name, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: BRAND.description },
  // See translate="no" below.
  other: { google: "notranslate" },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Render per request: the CSP nonce from proxy.ts exists only at request time (a static page has no nonce).
  await connection();
  return (
    // Browser translation rewrites the text nodes React owns: reviews then stop updating (a clicked scenario
    // showed nothing in a translated Chrome), and a machine translation could change what a warning says.
    <html
      lang="en"
      translate="no"
      className={`notranslate dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-zinc-950 text-zinc-100">
        <WalletProviders>
          <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6">
            <SecurityHeader />
            <main className="flex flex-1 flex-col py-6">{children}</main>
            <footer className="border-t border-zinc-800 pt-5 text-center text-xs text-zinc-600">
              {BRAND.name} · Solana · Open source (Apache-2.0) · Read-only: never asks for private keys or seed phrases and never signs. Results are evidence-based signals, not guarantees — the decision is yours.
            </footer>
          </div>
        </WalletProviders>
      </body>
    </html>
  );
}
