import type { Metadata } from "next";
// Self-hosted Geist via the `geist` package instead of next/font/google —
// next/font/google fetches from fonts.googleapis.com at build time, which
// fails the build entirely when the network is unreachable ("Failed to
// fetch Geist"). The geist package serves the same fonts locally with the
// SAME CSS variable names (--font-geist-sans / --font-geist-mono), so this
// is a drop-in replacement.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "LOOP",
  description:
    "A program that rewrites its own code, fails, remembers why, and never makes the same mistake twice.",
  keywords: [
    "autonomous self-improvement",
    "self-enhancing loop",
    "LLM refactoring",
    "self-modifying system",
    "z-ai-web-dev-sdk",
    "TypeScript Compiler API",
    "characterization tests",
    "ratchet",
    "GitHub audit trail",
    "Next.js",
  ],
  authors: [{ name: "craighckby-stack" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
