"use server";

import { revalidatePath } from "next/cache";
import { gateClientModule } from "./clientModuleAccess";
import { can, canAccessSchedulingSite, canAccessSchedulingStaff, type AccessScope } from "./access";
import { isUuid } from "./clientModuleValidation";
import { isUniqueViolation } from "@worker/db/client.js";
import { getAppointmentById } from "@worker/db/repositories/scheduling/appointments.js";
import { getPaymentById } from "@worker/db/repositories/scheduling/payments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { listActiveProducts } from "@worker/db/repositories/catalog/products.js";
import {
  completeWithPayment,
  getAppointmentPaymentHistory,
  getAppointmentPaymentView,
  recordPaymentForCompleted,
  voidPayment,
  type PaymentDraft,
  type PaymentError,
  type PaymentView,
} from "@worker/scheduling/payments.js";
import {
  addPaymentMethod,
  ensureClientPaymentMethods,
  listPaymentMethods,
  renamePaymentMethod,
  reorderPaymentMethods,
  setPaymentMethodActive,
} from "@worker/db/repositories/scheduling/paymentMethods.js";
import { updateStaffCommission } from "@worker/db/repositories/scheduling/staff.js";
import { listPendingPaymentAppointments, setPaymentsTrackingStartedAt } from "@worker/db/repositories/scheduling/paymentSettings.js";

/**
 * PY-1 server actions for payments + the two settings screens. Every action is gated server-side
 * on a permission key (web/lib/permissions/catalog.ts) through gateClientModule('scheduling', …):
 *   payments.record  → complete-with-payment / record a pending payment
 *   payments.view    → read an appointment's payment / the pending list
 *   payments.void    → void a payment
 *   payments.settings→ payment methods + staff commission config
 * commission fields are returned ONLY when the caller also holds commissions.view — the Setter
 * never receives them. scopeClientId is the VALIDATED client; the engine re-checks ownership.
 */

const GENERIC = "No disponible.";

export type PaymentActionResult<T = PaymentDTO> = { ok: true; value: T } | { ok: false; error: string };

/** Spanish copy for an engine error. */
function messageFor(error: PaymentError): string {
  switch (error) {
    case "invalid_status":
      return "Esta cita no admite ese cobro.";
    case "not_started":
      return "Se puede completar cuando la cita empiece.";
    case "product_inactive":
      return "Un producto del cobro ya no está activo. Quítalo o elige otro.";
    case "payment_exists":
      return "Esta cita ya tiene un cobro registrado.";
    case "method_inactive":
      return "Ese método de pago no está activo.";
    case "product_not_found":
      return "Un producto del cobro no existe en este negocio.";
    case "seller_not_found":
      return "Quien vende el producto no es un profesional de este negocio.";
    case "invalid_amount":
      return "Revisa los montos del cobro.";
    case "invalid_quantity":
      return "Cada producto necesita una cantidad de 1 o más.";
    case "adjustment_required":
      return "Indica el motivo cuando cobras menos del precio de lista (y una nota si es “otro”).";
    case "void_reason_required":
      return "Escribe el motivo para anular el cobro.";
    default:
      return GENERIC;
  }
}

// ── Response DTOs (commission stripped unless commissions.view) ────────────────────
export interface PaymentLineDTO {
  kind: "service" | "product";
  description: string;
  staffId: string | null;
  quantity: number;
  unitListPrice: string | null;
  unitCharged: string;
  lineTotal: string;
  adjustmentReason: string | null;
  adjustmentNote: string | null;
  /** Present only when the caller holds commissions.view. */
  commissionPct?: string;
  commissionAmount?: string;
}
export interface PaymentDTO {
  id: string;
  status: "recorded" | "voided";
  methodKey: string;
  total: string;
  note: string | null;
  paidAt: string;
  recordedBy: string;
  voidedBy: string | null;
  voidReason: string | null;
  outOfStockProductIds: string[];
  lines: PaymentLineDTO[];
}

function toDTO(view: PaymentView, withCommission: boolean): PaymentDTO {
  return {
    id: view.payment.id,
    status: view.payment.status,
    methodKey: view.payment.method_key,
    total: view.payment.total,
    note: view.payment.note,
    paidAt: view.payment.paid_at.toISOString(),
    recordedBy: view.payment.recorded_by,
    voidedBy: view.payment.voided_by,
    voidReason: view.payment.void_reason,
    outOfStockProductIds: view.outOfStockProductIds,
    lines: view.lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      staffId: l.staff_id,
      quantity: l.quantity,
      unitListPrice: l.unit_list_price,
      unitCharged: l.unit_charged,
      lineTotal: l.line_total,
      adjustmentReason: l.adjustment_reason,
      adjustmentNote: l.adjustment_note,
      ...(withCommission ? { commissionPct: l.commission_pct, commissionAmount: l.commission_amount } : {}),
    })),
  };
}

// ── Draft validation (the UI's input) ──────────────────────────────────────────────
export interface PaymentDraftInput {
  methodKey: string;
  note?: string | null;
  service?: { unitCharged?: number | null; adjustmentReason?: string | null; adjustmentNote?: string | null };
  products?: Array<{ productId: string; quantity: number; unitCharged: number; staffId?: string | null; adjustmentReason?: string | null; adjustmentNote?: string | null }>;
}

const ADJ = new Set(["promocion", "cortesia", "ajuste", "otro"]);
const asAdj = (v: string | null | undefined) => (v && ADJ.has(v) ? (v as PaymentDraft["service"]["adjustmentReason"]) : null);

/** Shape-validate the draft (UUIDs, finite numbers, positive quantities) before the engine. */
function toDraft(input: PaymentDraftInput): { ok: true; draft: PaymentDraft } | { ok: false } {
  if (typeof input?.methodKey !== "string" || input.methodKey.trim() === "") return { ok: false };
  const products: PaymentDraft["products"] = [];
  for (const p of input.products ?? []) {
    if (!isUuid(p.productId)) return { ok: false };
    if (p.staffId != null && !isUuid(p.staffId)) return { ok: false };
    if (!Number.isInteger(p.quantity) || p.quantity <= 0) return { ok: false };
    if (typeof p.unitCharged !== "number" || !Number.isFinite(p.unitCharged) || p.unitCharged < 0) return { ok: false };
    products.push({
      productId: p.productId,
      quantity: p.quantity,
      unitCharged: p.unitCharged,
      staffId: p.staffId ?? null,
      adjustmentReason: asAdj(p.adjustmentReason),
      adjustmentNote: p.adjustmentNote ?? null,
    });
  }
  const svc = input.service ?? {};
  if (svc.unitCharged != null && (typeof svc.unitCharged !== "number" || !Number.isFinite(svc.unitCharged) || svc.unitCharged < 0)) return { ok: false };
  return {
    ok: true,
    draft: {
      methodKey: input.methodKey.trim(),
      note: input.note ?? null,
      service: { unitCharged: svc.unitCharged ?? null, adjustmentReason: asAdj(svc.adjustmentReason), adjustmentNote: svc.adjustmentNote ?? null },
      products,
    },
  };
}

function agendaPath(clientId: string): string {
  return `/clients/${clientId}/scheduling/agenda`;
}

// ── Reach (agenda rules on every payment action) ─────────────────────────────────────

/**
 * A payment action may touch an appointment ONLY within the same reach as the agenda's own
 * writes: this client, a site the login may access, and — for a login bound to one
 * professional — that professional's column. Checked on the server, never by hiding buttons.
 */
async function appointmentInReach(scope: AccessScope, clientId: string, appointmentId: string) {
  const appt = await getAppointmentById(scope.tenantId, appointmentId);
  if (!appt || appt.client_id !== clientId) return null;
  if (!canAccessSchedulingSite(scope, appt.site_id) || !canAccessSchedulingStaff(scope, appt.staff_id)) return null;
  return appt;
}

// ── Payment actions ────────────────────────────────────────────────────────────────

async function doRecord(
  kind: "complete" | "pending",
  clientId: string,
  appointmentId: string,
  input: PaymentDraftInput,
): Promise<PaymentActionResult> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.record", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  // Completing with a charge is still COMPLETING: it never bypasses agenda.book, the
  // professional/site reach, or «only once it has started».
  if (kind === "complete" && !can(g.context.scope, "agenda.book", g.context.client.id)) return { ok: false, error: GENERIC };
  if (!(await appointmentInReach(g.context.scope, g.context.client.id, appointmentId))) return { ok: false, error: GENERIC };
  const draft = toDraft(input);
  if (!draft.ok) return { ok: false, error: "Revisa los datos del cobro." };
  const actor = { userId: g.context.scope.userId };
  const base = { tenantId: g.context.scope.tenantId, clientId: g.context.client.id, appointmentId, draft: draft.draft, actor };
  const r = kind === "complete" ? await completeWithPayment({ ...base, requireStarted: true }) : await recordPaymentForCompleted(base);
  if (!r.ok) return { ok: false, error: messageFor(r.error) };
  revalidatePath(agendaPath(g.context.client.id));
  return { ok: true, value: toDTO(r.value, can(g.context.scope, "commissions.view", g.context.client.id)) };
}

/** Complete a scheduled/confirmed appointment AND record its payment (the PY-2 completion step). */
export async function completeWithPaymentAction(clientId: string, appointmentId: string, input: PaymentDraftInput): Promise<PaymentActionResult> {
  return doRecord("complete", clientId, appointmentId, input);
}

/** Record the payment of an already-completed ("cobro pendiente") appointment. */
export async function recordPendingPaymentAction(clientId: string, appointmentId: string, input: PaymentDraftInput): Promise<PaymentActionResult> {
  return doRecord("pending", clientId, appointmentId, input);
}

/** Void a recorded payment (Client Owner / agency only). */
export async function voidPaymentAction(clientId: string, paymentId: string, reason: string): Promise<PaymentActionResult> {
  if (!isUuid(paymentId)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.void", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const p = await getPaymentById(g.context.scope.tenantId, g.context.client.id, paymentId);
  if (!p || !(await appointmentInReach(g.context.scope, g.context.client.id, p.appointment_id))) return { ok: false, error: GENERIC };
  const r = await voidPayment({ tenantId: g.context.scope.tenantId, clientId: g.context.client.id, paymentId, reason, actor: { userId: g.context.scope.userId } });
  if (!r.ok) return { ok: false, error: messageFor(r.error) };
  revalidatePath(agendaPath(g.context.client.id));
  return { ok: true, value: toDTO(r.value, can(g.context.scope, "commissions.view", g.context.client.id)) };
}

/** The payment of an appointment (amount + method; commission only with commissions.view). */
export async function getAppointmentPaymentAction(clientId: string, appointmentId: string): Promise<{ ok: true; value: PaymentDTO | null } | { ok: false; error: string }> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.view", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  if (!(await appointmentInReach(g.context.scope, g.context.client.id, appointmentId))) return { ok: false, error: GENERIC };
  const view = await getAppointmentPaymentView(g.context.scope.tenantId, g.context.client.id, appointmentId);
  return { ok: true, value: view ? toDTO(view, can(g.context.scope, "commissions.view", g.context.client.id)) : null };
}

export interface PendingPaymentDTO {
  appointmentId: string;
  startAt: string;
  serviceName: string;
  priceSnapshot: string | null;
  contactName: string | null;
  staffName: string | null;
}

/** The list of completed appointments awaiting a recorded payment. */
export async function listPendingPaymentsAction(clientId: string): Promise<{ ok: true; items: PendingPaymentDTO[] } | { ok: false; error: string }> {
  const g = await gateClientModule(clientId, "scheduling", "payments.view", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const scope = g.context.scope;
  const rows = (await listPendingPaymentAppointments(scope.tenantId, g.context.client.id)).filter((r) => canAccessSchedulingSite(scope, r.site_id) && canAccessSchedulingStaff(scope, r.staff_id));
  return {
    ok: true,
    items: rows.map((r) => ({
      appointmentId: r.appointment_id,
      startAt: r.start_at.toISOString(),
      serviceName: r.service_name,
      priceSnapshot: r.price_snapshot,
      contactName: r.contact_name,
      staffName: r.staff_name,
    })),
  };
}

/** Every payment of an appointment: the recorded one and the VOIDED history (who, when, why).
 *  payments.view + reach; commission only with commissions.view. */
export async function getAppointmentPaymentHistoryAction(clientId: string, appointmentId: string): Promise<{ ok: true; value: Array<PaymentDTO & { methodLabel: string }> } | { ok: false; error: string }> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.view", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  if (!(await appointmentInReach(g.context.scope, g.context.client.id, appointmentId))) return { ok: false, error: GENERIC };
  const [views, methods] = await Promise.all([
    getAppointmentPaymentHistory(g.context.scope.tenantId, g.context.client.id, appointmentId),
    listPaymentMethods(g.context.scope.tenantId, g.context.client.id),
  ]);
  const label = new Map(methods.map((m) => [m.key, m.label]));
  const withCommission = can(g.context.scope, "commissions.view", g.context.client.id);
  return { ok: true, value: views.map((v) => ({ ...toDTO(v, withCommission), methodLabel: label.get(v.payment.method_key) ?? v.payment.method_key })) };
}

export interface CheckoutOptions {
  methods: Array<{ key: string; label: string }>;
  /** Active catalogue products (empty when the business has no catalogue module). Out of
   *  stock ones are included and flagged — there is no stock model, so they stay sellable. */
  products: Array<{ id: string; name: string; price: string; category: string | null; inStock: boolean }>;
}

/** What the charge step offers: the business's ACTIVE payment methods and products. Gated
 *  like recording itself (payments.record); the engine re-checks both on save. */
export async function listCheckoutOptionsAction(clientId: string): Promise<{ ok: true; value: CheckoutOptions } | { ok: false; error: string }> {
  const g = await gateClientModule(clientId, "scheduling", "payments.record", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const { tenantId } = g.context.scope;
  const cid = g.context.client.id;
  await ensureClientPaymentMethods(tenantId, cid);
  const [methods, catalog] = await Promise.all([listPaymentMethods(tenantId, cid, { activeOnly: true }), isClientModuleEnabled(tenantId, cid, "catalog")]);
  const products = catalog ? await listActiveProducts(tenantId, cid) : [];
  return {
    ok: true,
    value: {
      methods: methods.map((m) => ({ key: m.key, label: m.label })),
      products: products.map((p) => ({ id: p.id, name: p.name, price: p.price, category: p.category, inStock: p.in_stock })),
    },
  };
}

// ── Settings actions (payments.settings) ─────────────────────────────────────────────

function methodsPath(clientId: string): string {
  return `/clients/${clientId}/scheduling/payment-methods`;
}

/** Slug a label into a stable method key. */
function slugKey(label: string): string {
  return label.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

export type SettingsResult = { ok: true } | { ok: false; error: string };

export async function addPaymentMethodAction(clientId: string, label: string): Promise<SettingsResult> {
  const g = await gateClientModule(clientId, "scheduling", "payments.settings", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const trimmed = (label ?? "").trim();
  if (trimmed === "" || trimmed.length > 80) return { ok: false, error: "Escribe un nombre de 1 a 80 caracteres." };
  const key = slugKey(trimmed);
  if (key === "") return { ok: false, error: "Ese nombre no es válido." };
  try {
    await addPaymentMethod(g.context.scope.tenantId, g.context.client.id, key, trimmed);
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: "Ya existe un método con ese nombre." };
    throw err;
  }
  revalidatePath(methodsPath(g.context.client.id));
  return { ok: true };
}

export async function renamePaymentMethodAction(clientId: string, id: string, label: string): Promise<SettingsResult> {
  if (!isUuid(id)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.settings", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const trimmed = (label ?? "").trim();
  if (trimmed === "" || trimmed.length > 80) return { ok: false, error: "Escribe un nombre de 1 a 80 caracteres." };
  const r = await renamePaymentMethod(g.context.scope.tenantId, g.context.client.id, id, trimmed);
  if (!r) return { ok: false, error: GENERIC };
  revalidatePath(methodsPath(g.context.client.id));
  return { ok: true };
}

export async function setPaymentMethodActiveAction(clientId: string, id: string, active: boolean): Promise<SettingsResult> {
  if (!isUuid(id)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.settings", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const r = await setPaymentMethodActive(g.context.scope.tenantId, g.context.client.id, id, active);
  if (!r) return { ok: false, error: GENERIC };
  revalidatePath(methodsPath(g.context.client.id));
  return { ok: true };
}

export async function reorderPaymentMethodsAction(clientId: string, orderedIds: string[]): Promise<SettingsResult> {
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => !isUuid(id))) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.settings", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  await reorderPaymentMethods(g.context.scope.tenantId, g.context.client.id, orderedIds);
  revalidatePath(methodsPath(g.context.client.id));
  return { ok: true };
}

/** Set an artist's commission percentages (0–100). Gated by payments.settings. */
export async function updateStaffCommissionAction(clientId: string, staffId: string, services: number, products: number): Promise<SettingsResult> {
  if (!isUuid(staffId)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "payments.settings", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
  if (!valid(services) || !valid(products)) return { ok: false, error: "La comisión debe estar entre 0 y 100." };
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // updateStaffCommission is CLIENT-scoped (joins the staff's site), so an owner can never edit
  // another client's staff even by passing a foreign staffId.
  const ok = await updateStaffCommission(g.context.scope.tenantId, g.context.client.id, staffId, { services: round2(services), products: round2(products) });
  if (!ok) return { ok: false, error: GENERIC };
  revalidatePath(`/clients/${g.context.client.id}/scheduling/staff`);
  return { ok: true };
}

/** Set the client's payments tracking-start instant (owner/agency). */
export async function setPaymentsTrackingStartedAtAction(clientId: string, isoDate: string): Promise<SettingsResult> {
  const g = await gateClientModule(clientId, "scheduling", "payments.settings", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const when = new Date(isoDate);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "La fecha no es válida." };
  await setPaymentsTrackingStartedAt(g.context.scope.tenantId, g.context.client.id, when);
  revalidatePath(methodsPath(g.context.client.id));
  return { ok: true };
}
