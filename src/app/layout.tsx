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
  title: "Architecture Helper Pipeline · LLM-Enhanced Autonomous Refactoring",
  description:
    "Autonomous 6-stage code refactoring pipeline with real LLM reasoning, TypeScript Compiler API AST verification, TF-IDF RAG memory, and an LLM-driven dual-perspective review tribunal. Runs in scheduled, watch, or continuous mode.",
  keywords: [
    "autonomous pipeline",
    "self-enhancement",
    "LLM refactoring",
    "z-ai-web-dev-sdk",
    "TypeScript Compiler API",
    "AST diff",
    "Shannon entropy",
    "TF-IDF RAG",
    "GitHub refactoring",
    "clean-room runtime",
    "code review tribunal",
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
