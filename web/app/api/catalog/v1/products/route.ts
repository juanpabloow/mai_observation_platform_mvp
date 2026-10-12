import { authenticateCatalog } from "@/lib/catalogApi";
import { priceLabelCOP } from "@/lib/money";
import { listActiveProducts } from "@worker/db/repositories/catalog/products.js";
import { normalizeName } from "@worker/scheduling/nameMatch.js";

/**
 * GET /api/catalog/v1/products?[q=][&category=] — the ACTIVE products of the resolved
 * client. MACHINE endpoint (Bearer + X-Workflow-Ref, capability catalog.read); tenant
 * and client are derived from the token, never sent by the caller. INFORM ONLY: there
 * are NO write endpoints — the bot can tell a customer what exists, what it costs, what
 * it is and whether it's available, but can't order, hold or reserve anything.
 *
 *  - Archived products are NEVER returned.
 *  - OUT-OF-STOCK products ARE returned with in_stock=false, so the bot can say "lo
 *    tenemos, pero ahora está agotado" instead of "no existe".
 *  - ?q= matches the NAME case- AND accent-insensitively ("balsamo" finds "Bálsamo"),
 *    via the same normalizeName the scheduling API uses — Postgres can't fold accents
 *    without an extension and the catalogue is small, so it's filtered here.
 *  - ?category= is an exact, case-insensitive category match (applied in SQL).
 *  - Sorted by (sort_order, name). Capped at CATALOG_RESULT_CAP; `truncated` is true
 *    when the cap hid rows, so a caller knows the list is partial.
 *  - An empty catalogue returns { products: [], truncated: false }, never an error.
 */
export const dynamic = "force-dynamic";

/** Response cap: an LLM tool loop reads this inline, so a few hundred is plenty while
 *  keeping the payload bounded. A real catalogue is far smaller. */
const CATALOG_RESULT_CAP = 200;

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateCatalog(req, "catalog.read");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const category = (url.searchParams.get("category") ?? "").trim();

  const rows = await listActiveProducts(auth.auth.tenantId, auth.auth.clientId, {
    category: category || null,
  });

  // Accent/case-insensitive name search over the bounded active list.
  const matched = q
    ? rows.filter((p) => normalizeName(p.name).includes(normalizeName(q)))
    : rows;

  const truncated = matched.length > CATALOG_RESULT_CAP;
  const chosen = truncated ? matched.slice(0, CATALOG_RESULT_CAP) : matched;

  return Response.json({
    products: chosen.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description, // null when empty
      price: p.price, // raw numeric string
      // The SAME canonical Colombian money label services use, so a product and a
      // service with the same price read identically to a customer.
      price_label: priceLabelCOP(p.price),
      category: p.category, // null when none
      in_stock: p.in_stock,
    })),
    truncated,
  });
}
