import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LOOP · Autonomous Self-Improving System",
  description:
    "LOOP — an autonomous self-improving system that defines its own input, refactors its own source code, verifies every change through structural + typecheck + debate + test gates, and pushes to GitHub as immutable proof. The user is the feedback signal.",
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
  authors: [{ name: "Z.ai Code" }],
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
