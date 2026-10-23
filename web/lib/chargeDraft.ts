/**
 * PY-2 charge step — the PURE rules of the form inside «Completar cita» / «Registrar cobro».
 * They mirror the engine (src/scheduling/payments.ts) so the person sees a problem before
 * saving, but the server stays the authority: it recomputes the total, re-checks the method,
 * the products and every reason, and ignores anything here it disagrees with.
 *
 * Money is typed the Colombian way («45.000» = forty-five thousand; «12,5» = twelve and a half)
 * and kept as cents internally so a total never drifts.
 */

export type AdjustmentReason = "promocion" | "cortesia" | "ajuste" | "otro";

export const ADJUSTMENT_LABEL: Record<AdjustmentReason, string> = {
  promocion: "Promoción",
  cortesia: "Cortesía",
  ajuste: "Ajuste de precio",
  otro: "Otro (explica)",
};

/** «45.000» / «45000» / «$ 45.000» / «12,5» → a number, or null when it is not an amount.
 *  Empty is null: an unknown price is NOT $0. */
export function parseAmount(raw: string): number | null {
  const t = raw.replace(/[\s$]/g, "");
  if (t === "") return null;
  let norm: string;
  if (t.includes(",")) norm = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) norm = t.replace(/\./g, "");
  else norm = t;
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  const n = Number(norm);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export const toCents = (n: number): number => Math.round(n * 100);

export interface ServiceLine {
  /** The appointment's stored price (string decimal) or null when unknown. */
  listPrice: string | null;
  amount: string;
  reason: AdjustmentReason | "";
  note: string;
}
export interface ProductLine {
  productId: string;
  name: string;
  listPrice: string;
  quantity: number;
  unit: string;
  reason: AdjustmentReason | "";
  note: string;
  inStock: boolean;
}
export interface ChargeForm {
  methodKey: string;
  service: ServiceLine;
  products: ProductLine[];
  note: string;
}

/** A reason is required when the line is charged UNDER its known list price. */
export function needsReason(listPrice: string | null, charged: number | null): boolean {
  if (listPrice == null || charged == null) return false;
  return toCents(charged) < toCents(Number(listPrice));
}

export interface ChargeCheck {
  /** Per-field messages, in Spanish, keyed by field id. */
  errors: Record<string, string>;
  /** Estimated total in cents (null while an amount is missing/invalid). */
  totalCents: number | null;
  serviceCents: number | null;
  lineCents: Array<number | null>;
}

export function checkCharge(f: ChargeForm): ChargeCheck {
  const errors: Record<string, string> = {};
  if (!f.methodKey) errors.method = "Elige el método de pago.";
  const svc = parseAmount(f.service.amount);
  if (svc == null) errors.amount = f.service.listPrice == null ? "Escribe el importe: este servicio no tiene precio guardado." : "Revisa el importe del servicio.";
  if (svc != null && needsReason(f.service.listPrice, svc)) {
    if (!f.service.reason) errors.reason = "Cobras menos del precio del servicio: indica el motivo.";
    else if (f.service.reason === "otro" && !f.service.note.trim()) errors.reasonNote = "Explica el motivo «Otro».";
  }
  const lineCents: Array<number | null> = f.products.map((p, i) => {
    const u = parseAmount(p.unit);
    if (!Number.isInteger(p.quantity) || p.quantity < 1) errors[`qty-${i}`] = "La cantidad debe ser 1 o más.";
    if (u == null) {
      errors[`unit-${i}`] = "Revisa el precio.";
      return null;
    }
    if (needsReason(p.listPrice, u)) {
      if (!p.reason) errors[`reason-${i}`] = "Cobras menos del precio de lista: indica el motivo.";
      else if (p.reason === "otro" && !p.note.trim()) errors[`reasonNote-${i}`] = "Explica el motivo «Otro».";
    }
    return toCents(u) * Math.max(0, p.quantity);
  });
  const serviceCents = svc == null ? null : toCents(svc);
  const totalCents = serviceCents == null || lineCents.some((c) => c == null) ? null : serviceCents + lineCents.reduce<number>((a, c) => a + (c ?? 0), 0);
  return { errors, totalCents, serviceCents, lineCents };
}

/** The draft the server action receives (no total: the server computes it). */
export function toDraftInput(f: ChargeForm, sellerStaffId: string | null) {
  const svc = parseAmount(f.service.amount);
  const svcUnder = needsReason(f.service.listPrice, svc);
  return {
    methodKey: f.methodKey,
    note: f.note.trim() || null,
    service: {
      unitCharged: svc,
      adjustmentReason: svcUnder ? f.service.reason || null : null,
      adjustmentNote: svcUnder && f.service.reason === "otro" ? f.service.note.trim() : null,
    },
    products: f.products.map((p) => {
      const u = parseAmount(p.unit) ?? 0;
      const under = needsReason(p.listPrice, u);
      return {
        productId: p.productId,
        quantity: p.quantity,
        unitCharged: u,
        staffId: sellerStaffId,
        adjustmentReason: under ? p.reason || null : null,
        adjustmentNote: under && p.reason === "otro" ? p.note.trim() : null,
      };
    }),
  };
}

/** The amount as typed for a stored price: «45000.00» → «45000», «12.50» → «12,5». */
export function amountInput(price: string | null): string {
  if (price == null) return "";
  const n = Number(price);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}
