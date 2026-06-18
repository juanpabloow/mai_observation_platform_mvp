"use client";

import { ThemeProvider } from "next-themes";

/**
 * Client providers mounted in the root layout. next-themes manages CLASS-BASED
 * theming on <html>:
 *  - attribute="class": toggles the `.dark` class (which our globals.css tokens +
 *    Tailwind `dark:` custom-variant key off of).
 *  - defaultTheme="system" + enableSystem: first visit follows the OS preference;
 *    once the user picks Light/Dark it is persisted (localStorage) and overrides
 *    the OS; "System" re-follows it.
 *  - It injects a pre-paint inline script that sets the class before first paint,
 *    so there is no flash of the wrong theme (root <html> has
 *    suppressHydrationWarning so that script-set class doesn't trip hydration).
 *  - disableTransitionOnChange suppresses CSS transitions during the switch so
 *    colors don't animate weirdly when toggling.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </ThemeProvider>
  );
}
