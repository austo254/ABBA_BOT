import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const grotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jet",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ABBA — Autonomous MT5 Scalping Terminal",
  description:
    "Abba: high-precision scalping engine for MetaTrader 5. Session targets, trailing-stop discipline, and real-time risk telemetry across London, New York and Asian sessions.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body className="bg-[#04060b] text-zinc-200 antialiased">{children}</body>
    </html>
  );
}
