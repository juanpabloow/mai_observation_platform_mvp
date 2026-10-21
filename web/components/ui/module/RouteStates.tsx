"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonClass } from "@/components/ui/controls";
import { ModuleSurface, SurfaceHeader } from "./ModuleSurface";
import { LoadError, NoAccess } from "./States";

/**
 * ROUTE-LEVEL states of a module screen, used by each module route's error.tsx and
 * not-found.tsx so every module looks the same when it fails and when it cannot be opened.
 *
 * There is deliberately NO loading.tsx on these routes: a loading boundary makes the
 * response stream before the page's permission gate runs, and a denied page then answers
 * HTTP 200 (with noindex) instead of the 404 it must return. The gates stay first.
 */

/** error.tsx body: what failed, and a «Reintentar» that re-fetches the segment. Nothing
 *  the user typed lives at this level (editors keep their own drafts), so retrying is safe. */
export function ModuleRouteError({ title, error, retry }: { title: string; error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ModuleSurface label={title}>
      <SurfaceHeader title={title} />
      <div className="border-t border-line">
        <LoadError>
          <Button variant="primary" onClick={retry}>
            Reintentar
          </Button>
        </LoadError>
      </div>
    </ModuleSurface>
  );
}

/** not-found.tsx body. The response stays a 404: it says nothing about whether the
 *  client or the module exists, only that this account cannot open it. */
export function ModuleNotFound() {
  return (
    <ModuleSurface label="Sin acceso">
      <div className="flex flex-1 items-center justify-center">
        <NoAccess>
          <Link href="/" className={buttonClass()}>
            Ir al inicio
          </Link>
        </NoAccess>
      </div>
    </ModuleSurface>
  );
}
