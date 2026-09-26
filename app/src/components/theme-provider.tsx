"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// System, light or dark, chosen in Settings and remembered by the browser
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
