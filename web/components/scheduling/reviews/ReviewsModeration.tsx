"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { moderateReviewAction } from "@/lib/reviewModerationActions";
import { longDate } from "@/lib/siteCalendar";
import { Alert, Button, CARD, Segmented } from "../ui/system";

/**
 * REVIEWS (moderation) — every submitted review of the client, newest first, split by
 * what the booking page does with it: Pendientes (waiting, not shown), Publicadas (shown
 * on /book) and Ocultas (never shown). A decision can be changed later; the customer is
 * never notified. Only approved reviews count towards the public rating.
 */

export interface ModerationItem {
  id: string;
  status: "pending" | "approved" | "hidden";
  rating: number;
  comment: string | null;
  author: string;
  service: string;
  staff: string | null;
  site: string;
  timezone: string;
  appointmentAt: string;
  submittedAt: string;
}

type Tab = ModerationItem["status"];
const TABS: readonly { value: Tab; label: string }[] = [
  { value: "pending", label: "Pendientes" },
  { value: "approved", label: "Publicadas" },
  { value: "hidden", label: "Ocultas" },
];
const EMPTY: Record<Tab, string> = {
  pending: "No hay reseñas esperando revisión.",
  approved: "Aún no has publicado reseñas.",
  hidden: "No hay reseñas ocultas.",
};

function Stars({ value }: { value: number }) {
  return (
    <span role="img" aria-label={`${value} de 5 estrellas`} className="flex gap-px">
      {Array.from({ length: 5 }, (_, i) => (
        <svg key={i} width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z" fill={i < value ? "#E8A317" : "var(--color-line-strong, #c9ccd1)"} />
        </svg>
      ))}
    </span>
  );
}

export function ReviewsModeration({ clientId, items: initial, footer = null }: { clientId: string; items: ModerationItem[]; footer?: React.ReactNode }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [tab, setTab] = useState<Tab>(initial.some((i) => i.status === "pending") || initial.length === 0 ? "pending" : "approved");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const count = (t: Tab) => items.filter((i) => i.status === t).length;
  const shown = items.filter((i) => i.status === tab);

  const decide = async (id: string, decision: "approved" | "hidden") => {
    setBusy(id);
    setError(null);
    const r = await moderateReviewAction(clientId, id, decision);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setItems((all) => all.map((i) => (i.id === id ? { ...i, status: decision } : i)));
    startTransition(() => router.refresh());
  };

  return (
    <PageShell className="overflow-y-auto" ariaLabel="Reseñas">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-[-0.025em] text-foreground">Reseñas</h1>
            <p className="mt-0.5 text-xs text-muted">Solo las publicadas aparecen en tu página de reservas y cuentan en la calificación.</p>
          </div>
          <Segmented
            label="Estado de las reseñas"
            value={tab}
            onChange={setTab}
            options={TABS.map((t) => ({ value: t.value, label: `${t.label} · ${count(t.value)}` }))}
          />
        </div>

        {error ? <Alert>{error}</Alert> : null}

        {shown.length === 0 ? (
          <div className={`${CARD} p-6 text-center text-sm text-muted`}>
            {EMPTY[tab]}
            {items.length === 0 ? (
              <span className="mt-1 block text-xs">Crea el enlace desde una cita completada (Agenda → cita → Reseña) o pídelo desde n8n.</span>
            ) : null}
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {shown.map((r) => (
              <li key={r.id} className={`${CARD} flex flex-col gap-2 p-4`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Stars value={r.rating} />
                  <span className="text-[14px] font-semibold">{r.author}</span>
                  <span className="text-xs text-muted">Recibida el {longDate(r.submittedAt, r.timezone)}</span>
                </div>
                <p className="text-xs text-muted">
                  {r.service}
                  {r.staff ? ` · ${r.staff}` : ""} · {r.site} · cita del {longDate(r.appointmentAt, r.timezone)}
                </p>
                {r.comment ? (
                  <p className="whitespace-pre-line text-[14px] leading-relaxed">{r.comment}</p>
                ) : (
                  <p className="text-[13px] italic text-muted">Sin comentario.</p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {r.status !== "approved" ? (
                    <Button size="sm" variant="primary" loading={busy === r.id} loadingLabel="Guardando…" disabled={busy !== null} onClick={() => decide(r.id, "approved")}>
                      Publicar
                    </Button>
                  ) : null}
                  {r.status !== "hidden" ? (
                    <Button size="sm" disabled={busy !== null} onClick={() => decide(r.id, "hidden")}>
                      Ocultar
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {footer}
      </div>
    </PageShell>
  );
}
