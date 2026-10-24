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
  title: "Architecture Helper Pipeline · Autonomous Self-Enhancement",
  description:
    "Autonomous 6-stage code refactoring pipeline with Shannon entropy sanitization, AST symbol retention, dual-perspective review tribunal, and a halt governor. Runs in scheduled, watch, or continuous mode.",
  keywords: [
    "autonomous pipeline",
    "self-enhancement",
    "AST diff",
    "Shannon entropy",
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
