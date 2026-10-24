"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import { apptClientLabel } from "@/lib/apptClientLabel";
import { ADJUSTMENT_LABEL, amountInput, checkCharge, parseAmount, toDraftInput, type AdjustmentReason, type ChargeForm, type ProductLine } from "@/lib/chargeDraft";
import { completeWithPaymentAction, listCheckoutOptionsAction, recordPendingPaymentAction, type CheckoutOptions } from "@/lib/paymentActions";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime } from "@/lib/siteCalendar";
import type { Appt } from "../AgendaView";
import { SidePanel, type SidePanelHandle } from "./SidePanel";
import { dayLabel } from "./AppointmentCard";
import { STATUS_NAME } from "./status";

/**
 * PY-2 — THE CHARGE STEP inside «Completar cita» (and «Registrar cobro» for a completed,
 * pending one), in the card language 5a. It records a payment the BUSINESS received: it does
 * not process cards, move money or pretend to be a payment gateway.
 *
 * One step, top to bottom: the service amount (the stored price; EMPTY and required when it is
 * unknown — unknown is not $0) with the discount reason when under the list price («Otro»
 * needs a note) → optional products (search, quantity, unit price, subtotal) → the business's
 * ACTIVE methods → a note → «Resumen» (what will be saved). The footer keeps the ESTIMATED
 * total in view with «Completar sin cobro» / «Cancelar» and the primary.
 *
 * The server is the authority (src/scheduling/payments.ts): it recomputes the total, re-checks
 * the method and the products, and completes + records in ONE transaction — if either part
 * fails, neither is applied. Success is shown only after it answers (the panel closes, the
 * detail shows «Cobro registrado»); a failure keeps every field; a payment someone else
 * recorded meanwhile blocks a second one. Double submits are ignored while it saves.
 */
const REASONS = Object.keys(ADJUSTMENT_LABEL) as AdjustmentReason[];
const noopSubscribe = () => () => {};
const COP = (cents: number | null) => (cents == null ? "—" : priceLabelCOP(cents / 100) ?? "—");
/** The engine's `payment_exists` (paymentActions.messageFor): someone recorded it meanwhile. */
const ALREADY = "Esta cita ya tiene un cobro registrado.";

export function ChargePanel(props: {
  clientId: string;
  appt: Appt;
  timezone: string;
  mode: "complete" | "record";
  onClose: () => void;
  /** After the server confirmed. */
  onDone: (message: string) => void;
  /** «Completar sin cobro» (complete mode only): the agenda's own completion. */
  onCompleteWithout?: () => void;
  /** The service family class (the header bar takes its colour). */
  toneClass?: string;
}) {
  const { appt } = props;
  const handle = useRef<SidePanelHandle | null>(null);
  const [options, setOptions] = useState<{ state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: CheckoutOptions }>({ state: "loading" });
  const initial = useMemo<ChargeForm>(() => ({ methodKey: "", service: { listPrice: appt.price, amount: amountInput(appt.price), reason: "", note: "" }, products: [], note: "" }), [appt.price]);
  const [form, setF] = useState<ChargeForm>(initial);
  const [already, setAlready] = useState(false);
  const [touched, setTouched] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  // A method no longer offered (deactivated since the step opened) simply stops being the
  // choice — derived, so the person picks again; the server would refuse it anyway.
  const offered = options.state === "ready" ? options.value.methods : [];
  const f: ChargeForm = form.methodKey && options.state === "ready" && !offered.some((m) => m.key === form.methodKey) ? { ...form, methodKey: "" } : form;
  const check = checkCharge(f);
  const valid = Object.keys(check.errors).length === 0;
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listCheckoutOptionsAction(props.clientId)
      .then((r) => alive && setOptions(r.ok ? { state: "ready", value: r.value } : { state: "error", error: r.error }))
      .catch(() => alive && setOptions({ state: "error", error: "No pudimos cargar los métodos de pago." }));
    return () => {
      alive = false;
    };
  }, [props.clientId, tick]);
  const load = () => {
    setOptions({ state: "loading" });
    setTick((n) => n + 1);
  };
  const methods = offered;

  const set = (patch: Partial<ChargeForm>) => setF((x) => ({ ...x, ...patch }));
  const setSvc = (patch: Partial<ChargeForm["service"]>) => setF((x) => ({ ...x, service: { ...x.service, ...patch } }));
  const setLine = (i: number, patch: Partial<ProductLine>) => setF((x) => ({ ...x, products: x.products.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  // From the latest state: quick taps on «+» each count.
  const bump = (i: number, by: number) => setF((x) => ({ ...x, products: x.products.map((p, j) => (j === i ? { ...p, quantity: Math.max(1, p.quantity + by) } : p)) }));
  const addProduct = (p: CheckoutOptions["products"][number]) => {
    setF((x) => {
      const at = x.products.findIndex((l) => l.productId === p.id);
      if (at >= 0) return { ...x, products: x.products.map((l, j) => (j === at ? { ...l, quantity: l.quantity + 1 } : l)) };
      return { ...x, products: [...x.products, { productId: p.id, name: p.name, listPrice: p.price, quantity: 1, unit: amountInput(p.price), reason: "", note: "", inStock: p.inStock }] };
    });
    setQuery("");
  };
  const products = options.state === "ready" ? options.value.products : [];
  const q = query.trim().toLocaleLowerCase("es");
  const matches = q ? products.filter((p) => p.name.toLocaleLowerCase("es").includes(q)).slice(0, 8) : [];
  const err = (k: string) => (touched ? check.errors[k] : undefined);

  const submit = () => {
    if (sending.current || pending || !valid || already) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const input = toDraftInput(f, appt.staff_id);
        const r = props.mode === "complete" ? await completeWithPaymentAction(props.clientId, appt.id, input) : await recordPendingPaymentAction(props.clientId, appt.id, input);
        if (!r.ok) {
          // Keep everything so the field can be fixed. A method or product that stopped being
          // offered refreshes the choices; a payment someone else recorded blocks a second one.
          if (r.error === ALREADY) setAlready(true);
          else setError(r.error);
          if (/método|producto/i.test(r.error)) load();
          return;
        }
        const total = priceLabelCOP(r.value.total) ?? r.value.total;
        props.onDone(props.mode === "complete" ? `Cita completada · cobro registrado (${total})` : `Cobro registrado (${total})`);
      } catch {
        setError("No se pudo guardar: revisa la conexión e inténtalo de nuevo.");
      } finally {
        sending.current = false;
      }
    });
  };

  const title = props.mode === "complete" ? "Completar cita" : "Registrar cobro";
  const subtitle = `${apptClientLabel(appt)} · ${appt.service_name}${appt.staff_name ? ` con ${appt.staff_name}` : ""} · ${dayLabel(appt.start_at, props.timezone)}, ${fmtTime(appt.start_at, props.timezone)} · ${STATUS_NAME[appt.status] ?? appt.status}`;
  const methodLabel = methods.find((m) => m.key === f.methodKey)?.label ?? null;
  const svcUnder = check.serviceCents != null && appt.price != null && check.serviceCents < Math.round(Number(appt.price) * 100);
  const blocked = already || options.state !== "ready";
  const primaryLabel = pending ? "Guardando…" : already ? "Ya hay un cobro" : props.mode === "complete" ? "Completar y registrar cobro" : "Guardar cobro";

  const footer = (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-[var(--c5-sec)]">Total</span>
        <span aria-live="polite" className="c5-total">
          {COP(check.totalCents)}
        </span>
      </div>
      {props.mode === "complete" && props.onCompleteWithout ? (
        <span className="c5-note">«Completar sin cobro» deja la cita completada con «Cobro pendiente»: completada no significa cobrada.</span>
      ) : null}
      <div className="flex gap-2">
        {props.mode === "complete" && props.onCompleteWithout ? (
          <button type="button" className="u-focus c5-btn" onClick={props.onCompleteWithout} disabled={pending || already}>
            Completar sin cobro
          </button>
        ) : (
          <button type="button" className="u-focus c5-btn" onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </button>
        )}
        <button
          type="button"
          data-kind="primary"
          aria-busy={pending || undefined}
          aria-disabled={blocked || undefined}
          className="u-focus c5-btn"
          onClick={() => {
            if (blocked) return;
            setTouched(true);
            if (valid) submit();
          }}
        >
          {primaryLabel}
        </button>
      </div>
    </>
  );

  // Portalled (inside the agenda's tokens): on a phone the detail lives in a portalled sheet
  // while the desktop column is hidden, so the step must not mount inside that column.
  const host = useSyncExternalStore(noopSubscribe, () => document.body, () => null);
  if (!host) return null;
  return createPortal(
    <div className="u-ag">
      <SidePanel
        name="charge"
        variant="card"
        title={title}
        subtitle={subtitle}
        leading={<span aria-hidden className={`${props.toneClass ?? ""} c5-bar`} style={{ background: "var(--appt-rule, var(--c5-sec))" }} />}
        dirty={dirty && !pending}
        onClose={props.onClose}
        handleRef={handle}
        footer={footer}
      >
        {already ? (
          <div role="alert" className="c5-box c5-amber mt-3">
            <span className="font-[590]">Esta cita ya tiene un cobro registrado</span>
            <span className="text-[12px]">Alguien lo registró mientras este panel estaba abierto. No se guardará un segundo cobro: cierra y revisa el registro existente, o anúlalo para registrar el correcto.</span>
          </div>
        ) : error ? (
          <div role="alert" className="c5-box c5-red mt-3 flex-row items-center gap-2.5">
            <span className="flex-1">{error} Tus datos se conservan.</span>
            <button type="button" data-size="sm" className="u-focus c5-btn border-[var(--c5-red-bd)] bg-transparent text-[var(--c5-red-fg)]" onClick={() => valid && submit()} disabled={pending}>
              Reintentar
            </button>
          </div>
        ) : null}

        {/* Service amount */}
        <section aria-labelledby="ch-svc" className="c5-sec">
          <label id="ch-svc" htmlFor="ch-amount" className="text-[13px] text-[var(--c5-tx2)]">
            Importe del servicio <span className="text-[var(--c5-sec)]">· {appt.service_name}</span>
          </label>
          <div className="u-focus c5-affix" aria-invalid={Boolean(err("amount")) || undefined}>
            <span aria-hidden className="text-[var(--c5-sec)]">$</span>
            <input
              id="ch-amount"
              inputMode="decimal"
              value={f.service.amount}
              onChange={(e) => setSvc({ amount: e.target.value })}
              placeholder={appt.price == null ? "Escribe el importe" : undefined}
              aria-invalid={Boolean(err("amount")) || undefined}
              aria-describedby={err("amount") ? "ch-amount-err" : undefined}
            />
            <span className="c5-num shrink-0 whitespace-nowrap text-[12px] text-[var(--c5-sec)]">{appt.price == null ? "Sin precio guardado" : `Lista ${priceLabelCOP(appt.price)}`}</span>
          </div>
          {err("amount") ? (
            <span id="ch-amount-err" className="text-[12px] text-[var(--c5-red-fg)]">
              {err("amount")}
            </span>
          ) : null}
          {svcUnder ? (
            <ReasonFields
              id="svc"
              reason={f.service.reason}
              note={f.service.note}
              onReason={(r) => setSvc({ reason: r })}
              onNote={(n) => setSvc({ note: n })}
              error={err("reason") ?? err("reasonNote")}
              hint={`Cobras menos del precio de lista (${priceLabelCOP(appt.price)}).`}
            />
          ) : null}
        </section>

        {/* Products */}
        {options.state === "ready" && products.length > 0 ? (
          <section aria-labelledby="ch-prod" className="c5-sec gap-1">
            <h3 id="ch-prod" className="c5-cap pb-1">
              Productos · opcional
            </h3>
            <div className="relative">
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar producto" aria-label="Buscar producto" className="u-focus c5-field w-full" />
              {matches.length > 0 ? (
                <ul role="listbox" aria-label="Productos" className="u-pop-in absolute inset-x-0 top-[calc(100%+4px)] z-10 flex max-h-[240px] flex-col overflow-y-auto rounded-[12px] border border-[var(--c5-ctrl-bd)] bg-[var(--c5-bg)] p-1 shadow-[0_14px_36px_rgba(0,0,0,0.18)]">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <button type="button" role="option" aria-selected={false} onClick={() => addProduct(p)} className="u-focus flex min-h-[44px] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[14px] hover:bg-[var(--c5-hover)]">
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {!p.inStock ? <span className="text-[12px] text-[var(--c5-amber-fg)]">Agotado</span> : null}
                        <span className="c5-num text-[var(--c5-sec)]">{priceLabelCOP(p.price)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : q ? (
                <p className="c5-note pt-1.5">Ningún producto coincide con «{query}».</p>
              ) : null}
            </div>
            {f.products.length > 0 ? (
              <ul className="flex flex-col pt-1">
                {f.products.map((p, i) => {
                  const unit = parseAmount(p.unit);
                  const under = unit != null && Math.round(unit * 100) < Math.round(Number(p.listPrice) * 100);
                  return (
                    <li key={p.productId} className="flex flex-col gap-1.5 py-1.5">
                      <div className="c5-row gap-2.5">
                        <span className="min-w-0 flex-1 truncate">
                          {p.name}
                          {!p.inStock ? <span className="text-[12px] text-[var(--c5-amber-fg)]"> · agotado (se puede vender)</span> : null}
                        </span>
                        <span className="c5-num w-[84px] shrink-0 text-right text-[14px]">{COP(check.lineCents[i])}</span>
                        <div role="group" aria-label={`Cantidad de ${p.name}`} className="c5-stepper">
                          <button
                            type="button"
                            aria-label={p.quantity <= 1 ? `Quitar ${p.name}` : "Menos"}
                            onClick={() => (p.quantity <= 1 ? setF((x) => ({ ...x, products: x.products.filter((_, j) => j !== i) })) : bump(i, -1))}
                            className="u-focus"
                          >
                            −
                          </button>
                          <span aria-live="polite" className="c5-num w-[24px] text-center">
                            {p.quantity}
                          </span>
                          <button type="button" aria-label="Más" onClick={() => bump(i, 1)} className="u-focus">
                            +
                          </button>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-[13px] text-[var(--c5-sec)]">
                        <span className="shrink-0">Precio c/u</span>
                        <input
                          inputMode="decimal"
                          value={p.unit}
                          onChange={(e) => setLine(i, { unit: e.target.value })}
                          aria-label={`Precio unitario de ${p.name}`}
                          aria-invalid={Boolean(err(`unit-${i}`)) || undefined}
                          className="u-focus c5-field h-[36px] w-[120px] text-right text-[14px]"
                        />
                        <span className="c5-num">lista {priceLabelCOP(p.listPrice)}</span>
                      </label>
                      {err(`unit-${i}`) || err(`qty-${i}`) ? <span className="text-[12px] text-[var(--c5-red-fg)]">{err(`unit-${i}`) ?? err(`qty-${i}`)}</span> : null}
                      {under ? (
                        <ReasonFields
                          id={`p${i}`}
                          reason={p.reason}
                          note={p.note}
                          onReason={(r) => setLine(i, { reason: r })}
                          onNote={(n) => setLine(i, { note: n })}
                          error={err(`reason-${i}`) ?? err(`reasonNote-${i}`)}
                          hint={`Cobras menos del precio de lista (${priceLabelCOP(p.listPrice)}).`}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        ) : null}

        {/* Method */}
        <section aria-labelledby="ch-method" className="c5-sec gap-2">
          <h3 id="ch-method" className="c5-cap">
            Método de pago
          </h3>
          {options.state === "loading" ? (
            <p role="status" className="c5-small flex items-center gap-2 text-[var(--c5-sec)]">
              <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-current" />
              Cargando métodos de pago…
            </p>
          ) : options.state === "error" ? (
            <p className="c5-small flex items-center gap-3">
              <span className="text-[var(--c5-red-fg)]">{options.error}</span>
              <button type="button" className="u-focus c5-link" onClick={load}>
                Reintentar
              </button>
            </p>
          ) : methods.length === 0 ? (
            <p className="c5-small">Este negocio no tiene métodos de pago activos. Actívalos en Métodos de pago.</p>
          ) : (
            <div role="radiogroup" aria-label="Método de pago" aria-invalid={Boolean(err("method")) || undefined} className="flex flex-wrap gap-1.5">
              {methods.map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={f.methodKey === m.key} onClick={() => set({ methodKey: m.key })} className="u-focus c5-choice">
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {err("method") ? <span className="text-[12px] text-[var(--c5-red-fg)]">{err("method")}</span> : null}
          {options.state === "ready" && methods.length > 0 ? <span className="c5-note">Solo aparecen los métodos activos en Métodos de pago.</span> : null}
        </section>

        <section aria-labelledby="ch-note" className="c5-sec">
          <label id="ch-note" htmlFor="ch-note-input" className="text-[13px] text-[var(--c5-tx2)]">
            Nota · opcional
          </label>
          <input id="ch-note-input" value={f.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} className="u-focus c5-field" />
        </section>

        {/* Summary — what will be saved, before saving. */}
        <section aria-labelledby="ch-sum" className="c5-sec">
          <h3 id="ch-sum" className="c5-cap pb-0.5">
            Resumen
          </h3>
          <dl className="flex flex-col gap-1.5">
            <SumRow
              k={`${appt.service_name}${appt.staff_name ? ` · ${appt.staff_name}` : ""}`}
              v={COP(check.serviceCents)}
              sub={svcUnder && f.service.reason ? `${ADJUSTMENT_LABEL[f.service.reason]}${f.service.reason === "otro" && f.service.note.trim() ? `: ${f.service.note.trim()}` : ""}` : undefined}
            />
            {f.products.map((p, i) => (
              <SumRow key={p.productId} k={`${p.name} × ${p.quantity}`} v={COP(check.lineCents[i])} sub={p.reason ? `${ADJUSTMENT_LABEL[p.reason]}${p.reason === "otro" && p.note.trim() ? `: ${p.note.trim()}` : ""}` : undefined} />
            ))}
            <SumRow k="Método de pago" v={methodLabel ?? "Sin elegir"} />
          </dl>
          {check.totalCents === 0 ? <span className="text-[12px] text-[var(--c5-amber-fg)]">Total $0: se guardará como atención sin cargo, no como precio desconocido.</span> : null}
          <span className="c5-note">
            Registra un pago que el negocio ya recibió: no procesa tarjetas ni mueve dinero.{" "}
            {props.mode === "complete" ? "La cita queda completada y el cobro registrado en un solo paso; si algo falla, no se aplica ninguno de los dos." : "El cobro queda registrado en esta cita."} El precio guardado de la cita no cambia y el total lo confirma el servidor.
          </span>
        </section>
      </SidePanel>
    </div>,
    host,
  );
}

function SumRow({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="c5-text c5-num flex items-baseline justify-between gap-3">
      <dt className="min-w-0 text-[var(--c5-tx2)]">
        <span className="block truncate">{k}</span>
        {sub ? <span className="block text-[12px] text-[var(--c5-sec)]">{sub}</span> : null}
      </dt>
      <dd className="shrink-0">{v}</dd>
    </div>
  );
}

function ReasonFields(props: { id: string; reason: AdjustmentReason | ""; note: string; onReason: (r: AdjustmentReason) => void; onNote: (n: string) => void; error?: string; hint: string }) {
  return (
    <fieldset className="c5-box c5-amber mt-1 gap-2">
      <legend className="sr-only">Motivo del descuento</legend>
      <span className="text-[12px]">{props.hint} Indica el motivo (obligatorio).</span>
      <div role="radiogroup" aria-label="Motivo" className="flex flex-wrap gap-1.5">
        {REASONS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={props.reason === r} onClick={() => props.onReason(r)} data-size="sm" className="u-focus c5-choice">
            {ADJUSTMENT_LABEL[r]}
          </button>
        ))}
      </div>
      {props.reason === "otro" ? (
        <input value={props.note} maxLength={500} onChange={(e) => props.onNote(e.target.value)} aria-label="Explica el motivo" placeholder="Explica el motivo" className="u-focus c5-field h-[40px] bg-[var(--c5-bg)] text-[15px]" />
      ) : null}
      {props.error ? <span className="text-[12px] text-[var(--c5-red-fg)]">{props.error}</span> : null}
    </fieldset>
  );
}
