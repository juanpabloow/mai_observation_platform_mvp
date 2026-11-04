import { redirect } from "next/navigation";

/**
 * /negocios — the old «¿A qué negocio entras?» stop after signing in, removed 2026-11-03: Inicio
 * (`/`) already lists every business with its doors, and the sidebar switches business. Kept as
 * a redirect so old links and bookmarks still land somewhere; `/` sends a member on to their
 * own business.
 */
export default function BusinessPickerPage() {
  redirect("/");
}
