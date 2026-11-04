import { redirect } from "next/navigation";

/**
 * `/clients` — «Clientes y workflows» now lives on the home (`/`): every business with its
 * doors and its management (create, rename, color, logo, modules, members, delete, move
 * workflows). Kept as a redirect so old links and bookmarks still land somewhere useful; the
 * home applies the same owner/admin gate.
 */
export default function ClientsPage() {
  redirect("/");
}
