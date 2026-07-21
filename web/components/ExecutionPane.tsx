"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SidePane } from "./SidePane";

/**
 * Client wrapper that drops the server-rendered execution detail into the shared
 * SidePane (H-8.2). The executions page (a server component) renders this with the
 * detail as children whenever ?execution=<id> is set; the ✕ / Esc close by dropping
 * that param (scroll:false, so the table position is kept). Because the page re-renders
 * server-side on an ?execution= change and this wrapper stays mounted, clicking another
 * row swaps the detail in place (no close/reopen). SidePane provides the sticky header,
 * so "Execution detail" + ✕ stay pinned while the body scrolls.
 */
export function ExecutionPane({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const close = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("execution");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  return (
    <SidePane
      paneType="execution"
      onClose={close}
      header={
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Execution detail
        </span>
      }
    >
      {children}
    </SidePane>
  );
}
