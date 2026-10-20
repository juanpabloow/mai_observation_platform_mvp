"use client";

import { ThemeProvider } from "next-themes";
import { SidebarProvider } from "@/components/SidebarContext";

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
/**
 * The pre-paint script must stay EXECUTABLE in the server HTML (that is what prevents the
 * flash). On the client React 19 re-renders the same <script> element and warns that
 * scripts inside components never run there — which is fine, it already ran. Giving the
 * CLIENT render a non-executable type silences that dev error without changing the
 * server output; next-themes marks the element suppressHydrationWarning, so the differing
 * `type` attribute is not a hydration error.
 */
const THEME_SCRIPT_PROPS = typeof window === "undefined" ? undefined : { type: "application/json" };

export function Providers({ children, sidebarCollapsed = false }: { children: React.ReactNode; sidebarCollapsed?: boolean }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange scriptProps={THEME_SCRIPT_PROPS}>
      <SidebarProvider initialCollapsed={sidebarCollapsed}>{children}</SidebarProvider>
    </ThemeProvider>
  );
}
