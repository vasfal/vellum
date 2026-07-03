"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// Theme provider (ADR-019). next-themes toggles a `light`/`dark` class on <html>
// via a blocking pre-paint script. Dark is the default for everyone (no System
// mode); the choice persists in localStorage. `disableTransitionOnChange`
// suppresses the app-wide color transition on a switch (otherwise every element
// cross-fades at once, which reads as jank rather than polish).
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
