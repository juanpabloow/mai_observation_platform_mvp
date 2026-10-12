/**
 * Server-side validation for a PRODUCT — pure functions so each rule is testable on
 * its own and the catalog actions can't drift from the DB CHECKs (migration CATALOG-2).
 *
 * The description rule is the same as a service's (migration 1797): undefined / blank /
 * whitespace-only → NULL; trimmed, plain text, ≤500 chars otherwise; longer is rejected
 * naming the field. The money representation is shared too — a product price is a
 * numeric(10,2) like a service price — but a product price is REQUIRED and must be > 0.
 */

export const PRODUCT_DESCRIPTION_MAX = 500;
export const PRODUCT_NAME_MAX = 200;

export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** name: required, trimmed, non-blank, ≤200 chars. */
export function normalizeProductName(raw: string | null | undefined): FieldResult<string> {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: false, error: 'name: a product name is required.' };
  if (trimmed.length > PRODUCT_NAME_MAX) {
    return { ok: false, error: `name: must be ${PRODUCT_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

/** description: optional; blank/whitespace → NULL; plain text ≤500 chars; else rejected. */
export function normalizeProductDescription(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null }; // whitespace-only → NULL
  if (trimmed.length > PRODUCT_DESCRIPTION_MAX) {
    return { ok: false, error: `description: must be ${PRODUCT_DESCRIPTION_MAX} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

/** category: optional free text; blank/whitespace → NULL; trimmed otherwise. */
export function normalizeProductCategory(raw: string | null | undefined): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

/**
 * price: required, a finite number strictly greater than 0, rounded to 2 decimals (the
 * numeric(10,2) column's precision). Accepts a number or a numeric string (a form field),
 * rejects NaN / ≤ 0 / non-finite — naming the field.
 */
export function normalizeProductPrice(raw: number | string | null | undefined): FieldResult<number> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'price: a price is required.' };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'price: must be a number.' };
  if (n <= 0) return { ok: false, error: 'price: must be greater than 0.' };
  return { ok: true, value: Math.round(n * 100) / 100 };
}
