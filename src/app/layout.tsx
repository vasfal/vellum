import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

// Inter for UI, Geist Mono for timestamps/code (ADR-004). The variable names
// are referenced from globals.css `@theme` (--font-inter, --font-geist-mono).
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vellum",
  description: "Local-first design review recorder and analyzer.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Light + dark, switchable (ADR-019). next-themes sets the theme class on
  // <html> before paint, so `suppressHydrationWarning` is required (the server
  // renders without the class; the client script adds it pre-hydration).
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <ThemeProvider>
          {/* One shared tooltip provider (TASK-37): a global open delay + the
              instant-open grouping between adjacent library tooltips. */}
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
