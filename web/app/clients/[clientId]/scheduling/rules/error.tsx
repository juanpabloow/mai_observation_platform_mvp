"use client";

import { ModuleRouteError } from "@/components/ui/module/RouteStates";

export default function Error({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  return <ModuleRouteError title="Reglas de reserva" error={error} retry={unstable_retry} />;
}
