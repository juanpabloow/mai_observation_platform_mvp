"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import { apptClientLabel } from "@/lib/apptClientLabel";
import { ADJUSTMENT_LABEL, amountInput, checkCharge, parseAmount, toDraftInput, type AdjustmentReason, type ChargeForm, type ProductLine } from "@/lib/chargeDraft";
import { completeWithPaymentAction, listCheckoutOptionsAction, recordPendingPaymentAction, type CheckoutOptions } from "@/lib/paymentActions";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime } from "@/lib/siteCalendar";
import type { Appt } from "../AgendaView";
import { Alert, Button } from "../ui/system";
import { SidePanel, type SidePanelHandle } from "./SidePanel";

/**
 * PY-2 — THE CHARGE STEP inside «Completar cita» (and «Registrar cobro» for a completed,
 * pending one). It records a payment the BUSINESS received: it does not process cards, move
 * money or pretend to be a payment gateway.
 *
 *   form    → service + professional, the amount (the stored price; EMPTY and required when it
 *             is unknown — unknown is not $0), the discount reason when under the price («Otro»
 *             needs a note), the business's ACTIVE methods, optional products (search, quantity,
 *             unit price, subtotal), a note, and the ESTIMATED total.
 *   review  → a plain summary, then «Completar y registrar cobro» / «Registrar cobro».
 *
 * The server is the authority (src/scheduling/payments.ts): it recomputes the total, re-checks
 * the method and the products, and completes + records in ONE transaction — if either part
 * fails, neither is applied. Success is shown only after it answers; a failure keeps every
 * field. «Completar sin registrar cobro» stays available and says what it means.
 */
const REASONS = Object.keys(ADJUSTMENT_LABEL) as AdjustmentReason[];
const noopSubscribe = () => () => {};
const COP = (cents: number | null) => (cents == null ? "—" : priceLabelCOP(cents / 100) ?? "—");

export function ChargePanel(props: {
  clientId: string;
  appt: Appt;
  timezone: string;
  mode: "complete" | "record";
  onClose: () => void;
  /** After the server confirmed. */
  onDone: (message: string) => void;
  /** «Completar sin registrar cobro» (complete mode only): the agenda's own completion. */
  onCompleteWithout?: () => void;
}) {
  const { appt } = props;
  const handle = useRef<SidePanelHandle | null>(null);
  const [options, setOptions] = useState<{ state: "loading" } | { state: "error"; error: string } | { state: "ready"; value: CheckoutOptions }>({ state: "loading" });
  const initial = useMemo<ChargeForm>(() => ({ methodKey: "", service: { listPrice: appt.price, amount: amountInput(appt.price), reason: "", note: "" }, products: [], note: "" }), [appt.price]);
  const [form, setF] = useState<ChargeForm>(initial);
  const [step, setStep] = useState<"form" | "review">("form");
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
    if (sending.current || pending || !valid) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const input = toDraftInput(f, appt.staff_id);
        const r = props.mode === "complete" ? await completeWithPaymentAction(props.clientId, appt.id, input) : await recordPendingPaymentAction(props.clientId, appt.id, input);
        if (!r.ok) {
          // Keep everything; back to the form so the field can be fixed. A method or product that
          // stopped being offered refreshes the choices.
          setError(r.error);
          setStep("form");
          if (/método|producto/i.test(r.error)) load();
          return;
        }
        const total = priceLabelCOP(r.value.total) ?? r.value.total;
        props.onDone(props.mode === "complete" ? `Cita completada · cobro registrado (${total})` : `Cobro registrado (${total})`);
      } catch {
        setError("No se pudo guardar: revisa la conexión e inténtalo de nuevo. Tus datos se conservan.");
        setStep("form");
      } finally {
        sending.current = false;
      }
    });
  };

  const title = props.mode === "complete" ? "Completar cita" : "Registrar cobro";
  const subtitle = (
    <span className="tabular-nums">
      {apptClientLabel(appt)} · {fmtTime(appt.start_at, props.timezone)} – {fmtTime(appt.service_end_at, props.timezone)}
    </span>
  );
  const methodLabel = methods.find((m) => m.key === f.methodKey)?.label ?? "—";
  const svcUnder = check.serviceCents != null && appt.price != null && check.serviceCents < Math.round(Number(appt.price) * 100);

  const footer =
    step === "form" ? (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span aria-live="polite" className="min-w-0 flex-1 text-[13px] text-muted">
            Total estimado <span className="font-medium tabular-nums text-foreground">{COP(check.totalCents)}</span>
          </span>
          <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={options.state !== "ready"}
            onClick={() => {
              setTouched(true);
              if (valid) setStep("review");
            }}
          >
            Revisar cobro
          </Button>
        </div>
        {props.mode === "complete" && props.onCompleteWithout ? (
          <p className="text-[12.5px] leading-[1.45] text-muted">
            <button type="button" onClick={props.onCompleteWithout} disabled={pending} className="u-focus rounded text-[var(--ag-ink2)] underline underline-offset-[3px]">
              Completar sin registrar cobro
            </button>{" "}
            · la cita queda completada con «Cobro pendiente»; el cobro se registra después. Completada no significa cobrada.
          </p>
        ) : null}
      </div>
    ) : (
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-muted">El servidor confirma el total al guardar.</span>
        <Button onClick={() => setStep("form")} disabled={pending}>
          Volver
        </Button>
        <Button variant="primary" onClick={submit} loading={pending} loadingLabel="Guardando…">
          {props.mode === "complete" ? "Completar y registrar cobro" : "Registrar cobro"}
        </Button>
      </div>
    );

  // Portalled (inside the agenda's tokens): on a phone the detail lives in a portalled sheet
  // while the desktop column is hidden, so the step must not mount inside that column.
  const host = useSyncExternalStore(noopSubscribe, () => document.body, () => null);
  if (!host) return null;
  return createPortal(
    <div className="u-ag">
    <SidePanel name="charge" title={title} subtitle={subtitle} dirty={dirty && !pending} onClose={props.onClose} handleRef={handle} footer={footer}>
      <div className="flex flex-col gap-5">
        <p className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[12.5px] leading-[1.45] text-[var(--ag-ink2)]">
          Registra un pago que el negocio ya recibió. No procesa tarjetas ni mueve dinero.
        </p>
        {error ? <Alert>{error}</Alert> : null}

        {step === "form" ? (
          <>
            {/* Service + professional + amount */}
            <section aria-labelledby="ch-svc" className="flex flex-col gap-2">
              <h3 id="ch-svc" className="text-[15px] font-medium">Servicio</h3>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 text-[13.5px]">
                <span className="min-w-0 truncate">
                  {appt.service_name} <span className="text-muted">· {appt.staff_name ?? "Sin profesional"}</span>
                </span>
                <span className="tabular-nums text-muted">{appt.price == null ? "Sin precio guardado" : `Precio ${priceLabelCOP(appt.price)}`}</span>
              </div>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted">Importe cobrado por el servicio</span>
                <input
                  inputMode="decimal"
                  value={f.service.amount}
                  onChange={(e) => setSvc({ amount: e.target.value })}
                  placeholder={appt.price == null ? "Escribe el importe" : undefined}
                  aria-invalid={Boolean(err("amount")) || undefined}
                  aria-describedby={err("amount") ? "ch-amount-err" : undefined}
                  className="u-field u-focus h-[38px] rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[14px] tabular-nums"
                />
                {err("amount") ? <span id="ch-amount-err" className="text-[12.5px] text-danger">{err("amount")}</span> : null}
              </label>
              {svcUnder ? (
                <ReasonFields
                  id="svc"
                  reason={f.service.reason}
                  note={f.service.note}
                  onReason={(r) => setSvc({ reason: r })}
                  onNote={(n) => setSvc({ note: n })}
                  error={err("reason") ?? err("reasonNote")}
                  hint={`Cobras menos del precio (${priceLabelCOP(appt.price)}).`}
                />
              ) : null}
            </section>

            {/* Method */}
            <section aria-labelledby="ch-method" className="flex flex-col gap-2">
              <h3 id="ch-method" className="text-[15px] font-medium">Método de pago</h3>
              {options.state === "loading" ? (
                <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
                  <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-[var(--ag-ink2)]" />
                  Cargando métodos de pago…
                </p>
              ) : options.state === "error" ? (
                <div className="flex items-center gap-3 text-[13px] text-muted">
                  {options.error}
                  <Button size="sm" onClick={load}>Reintentar</Button>
                </div>
              ) : methods.length === 0 ? (
                <p className="text-[13px] text-muted">Este negocio no tiene métodos de pago activos. Actívalos en Métodos de pago.</p>
              ) : (
                <div role="radiogroup" aria-label="Método de pago" aria-invalid={Boolean(err("method")) || undefined} className="flex flex-wrap gap-1.5">
                  {methods.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      role="radio"
                      aria-checked={f.methodKey === m.key}
                      onClick={() => set({ methodKey: m.key })}
                      className={`u-focus h-[34px] rounded-[9px] border px-3 text-[13.5px] transition-colors ${f.methodKey === m.key ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--ink-fg)]" : "border-[var(--line-strong)] bg-[var(--surface)] hover:bg-[var(--subtle)]"}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
              {err("method") ? <span className="text-[12.5px] text-danger">{err("method")}</span> : null}
            </section>

            {/* Products */}
            {options.state === "ready" && products.length > 0 ? (
              <section aria-labelledby="ch-prod" className="flex flex-col gap-2">
                <h3 id="ch-prod" className="text-[15px] font-medium">
                  Productos <span className="font-normal text-muted">· opcional</span>
                </h3>
                <div className="relative">
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Buscar producto"
                    aria-label="Buscar producto"
                    className="u-field u-focus h-[38px] w-full rounded-[10px] bg-[var(--chip)] px-3 text-[14px]"
                  />
                  {matches.length > 0 ? (
                    <ul role="listbox" aria-label="Productos" className="u-pop-in absolute inset-x-0 top-[calc(100%+4px)] z-10 flex max-h-[240px] flex-col overflow-y-auto rounded-[12px] bg-[var(--surface)] p-1 shadow-[0_0_0_1px_var(--line),0_14px_36px_rgba(0,0,0,0.14)]">
                      {matches.map((p) => (
                        <li key={p.id}>
                          <button type="button" role="option" aria-selected={false} onClick={() => addProduct(p)} className="u-focus flex min-h-[40px] w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13.5px] hover:bg-[var(--subtle)]">
                            <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            {!p.inStock ? <span className="text-[12px] text-[var(--warn)]">Agotado</span> : null}
                            <span className="tabular-nums text-muted">{priceLabelCOP(p.price)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : q ? (
                    <p className="pt-1.5 text-[12.5px] text-muted">Ningún producto coincide con «{query}».</p>
                  ) : null}
                </div>
                {f.products.length > 0 ? (
                  <ul className="flex flex-col">
                    {f.products.map((p, i) => {
                      const unit = parseAmount(p.unit);
                      const under = unit != null && Math.round(unit * 100) < Math.round(Number(p.listPrice) * 100);
                      return (
                        <li key={p.productId} className="flex flex-col gap-2 py-2.5 shadow-[inset_0_-1px_0_var(--line-soft)]">
                          <div className="flex items-center gap-2 text-[13.5px]">
                            <span className="min-w-0 flex-1 truncate">
                              {p.name}
                              {!p.inStock ? <span className="text-[12px] text-[var(--warn)]"> · agotado (se puede vender)</span> : null}
                            </span>
                            <button type="button" aria-label={`Quitar ${p.name}`} onClick={() => setF((x) => ({ ...x, products: x.products.filter((_, j) => j !== i) }))} className="u-focus grid size-[32px] place-items-center rounded-[8px] text-muted hover:bg-[var(--subtle)]">
                              ×
                            </button>
                          </div>
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                            <div role="group" aria-label={`Cantidad de ${p.name}`} className="flex h-[34px] items-center rounded-[9px] border border-[var(--line-strong)]">
                              <button type="button" aria-label="Menos" disabled={p.quantity <= 1} onClick={() => setLine(i, { quantity: Math.max(1, p.quantity - 1) })} className="u-focus h-full w-[32px] text-[15px] disabled:opacity-40">
                                −
                              </button>
                              <span aria-live="polite" className="w-[28px] text-center text-[13.5px] tabular-nums">{p.quantity}</span>
                              <button type="button" aria-label="Más" onClick={() => setLine(i, { quantity: p.quantity + 1 })} className="u-focus h-full w-[32px] text-[15px]">
                                +
                              </button>
                            </div>
                            <label className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
                              <span className="shrink-0">c/u</span>
                              <input inputMode="decimal" value={p.unit} onChange={(e) => setLine(i, { unit: e.target.value })} aria-label={`Precio unitario de ${p.name}`} aria-invalid={Boolean(err(`unit-${i}`)) || undefined} className="u-field u-focus h-[34px] min-w-0 flex-1 rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-2.5 text-right text-[13.5px] tabular-nums text-foreground" />
                            </label>
                            <span className="text-right text-[13.5px] tabular-nums">{COP(check.lineCents[i])}</span>
                          </div>
                          {err(`unit-${i}`) || err(`qty-${i}`) ? <span className="text-[12.5px] text-danger">{err(`unit-${i}`) ?? err(`qty-${i}`)}</span> : null}
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

            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="text-muted">Nota · opcional</span>
              <input value={f.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} className="u-field u-focus h-[38px] rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[14px]" />
            </label>
          </>
        ) : (
          <section aria-labelledby="ch-review" className="flex flex-col gap-3">
            <h3 id="ch-review" className="text-[15px] font-medium">Resumen</h3>
            <dl className="flex flex-col text-[13.5px]">
              <Row k={`${appt.service_name} · ${appt.staff_name ?? "Sin profesional"}`} v={COP(check.serviceCents)} sub={svcUnder && f.service.reason ? `${ADJUSTMENT_LABEL[f.service.reason]}${f.service.reason === "otro" ? `: ${f.service.note.trim()}` : ""}` : undefined} />
              {f.products.map((p, i) => (
                <Row key={p.productId} k={`${p.name} × ${p.quantity}`} v={COP(check.lineCents[i])} sub={p.reason ? `${ADJUSTMENT_LABEL[p.reason]}${p.reason === "otro" ? `: ${p.note.trim()}` : ""}` : undefined} />
              ))}
              <Row k="Método de pago" v={methodLabel} />
              {f.note.trim() ? <Row k="Nota" v={f.note.trim()} /> : null}
              <div className="flex items-baseline justify-between gap-3 pt-3 text-[15px] font-medium">
                <dt>Total</dt>
                <dd className="tabular-nums">{COP(check.totalCents)}</dd>
              </div>
            </dl>
            <p className="text-[12.5px] leading-[1.45] text-muted">
              {props.mode === "complete" ? "Al confirmar, la cita queda completada y el cobro registrado en un solo paso: si algo falla, no se aplica ninguno de los dos." : "Al confirmar, el cobro queda registrado en esta cita."} El precio guardado de la cita no cambia.
            </p>
          </section>
        )}
      </div>
    </SidePanel>
    </div>,
    host,
  );
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 shadow-[inset_0_-1px_0_var(--line-soft)]">
      <dt className="min-w-0">
        <span className="block truncate">{k}</span>
        {sub ? <span className="block text-[12.5px] text-muted">{sub}</span> : null}
      </dt>
      <dd className="shrink-0 tabular-nums">{v}</dd>
    </div>
  );
}

function ReasonFields(props: { id: string; reason: AdjustmentReason | ""; note: string; onReason: (r: AdjustmentReason) => void; onNote: (n: string) => void; error?: string; hint: string }) {
  return (
    <fieldset className="flex flex-col gap-1.5 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5">
      <legend className="sr-only">Motivo del descuento</legend>
      <span className="text-[12.5px] text-[var(--warn)]">{props.hint} Indica el motivo.</span>
      <div role="radiogroup" aria-label="Motivo" className="flex flex-wrap gap-1.5">
        {REASONS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={props.reason === r} onClick={() => props.onReason(r)} className={`u-focus h-[30px] rounded-[8px] border px-2.5 text-[13px] ${props.reason === r ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--ink-fg)]" : "border-[var(--line-strong)] bg-[var(--surface)]"}`}>
            {ADJUSTMENT_LABEL[r]}
          </button>
        ))}
      </div>
      {props.reason === "otro" ? (
        <input value={props.note} maxLength={500} onChange={(e) => props.onNote(e.target.value)} aria-label="Explica el motivo" placeholder="Explica el motivo" className="u-field u-focus h-[34px] rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-2.5 text-[13.5px]" />
      ) : null}
      {props.error ? <span className="text-[12.5px] text-danger">{props.error}</span> : null}
    </fieldset>
  );
}
