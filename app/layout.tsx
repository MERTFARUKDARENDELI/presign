import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SecurityHeader from "@/components/SecurityHeader";
import WalletProviders from "@/components/providers/WalletProviders";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Web3 Security Agent & Defender",
  description: "Simulate before you sign. Detect scams. Clean your wallet. Solana wallet, token and transaction security.",
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-zinc-950 text-zinc-100">
        <WalletProviders>
          <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-6 sm:px-6">
            <SecurityHeader />
            <main className="flex flex-1 flex-col py-6">{children}</main>
            <footer className="border-t border-zinc-800 pt-5 text-center text-xs text-zinc-600">
              AI Web3 Security Agent &amp; Defender · Solana · This tool never asks for private keys or seed phrases. Risk results are evidence-based signals, not guarantees — you make the final decision.
            </footer>
          </div>
        </WalletProviders>
      </body>
    </html>
  );
}
