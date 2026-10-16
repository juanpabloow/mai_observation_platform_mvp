"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestExternalReviewAction } from "@/lib/reviewModerationActions";
import { Alert, Button, CARD, TEXTAREA } from "../ui/system";

/**
 * REVIEWS IMPORTED FROM FRESHA — what the business sees of them: read-only. M_AI imports
 * them and reviews their provenance; only an M_AI administrator publishes or hides them.
 * The business can ASK for a review or a withdrawal (with a note) — nothing else: no stars,
 * text, author, date or origin can be changed from here, and the server refuses it too.
 * The evidence, the internal notes and the original text are not shown here.
 */
export interface ExternalItem {
  id: string;
  status: string;
  provenance: string;
  rating: number;
  comment: string | null;
  author: string;
  staff: string | null;
  service: string | null;
  writtenAt: string;
  site: string;
  openKinds: Array<"review" | "withdraw">;
}

const STATE = (x: ExternalItem) =>
  x.provenance === "rejected" ? "No publicada: su procedencia no se pudo comprobar" : x.status === "approved" ? "Publicada en la página" : x.status === "hidden" ? "Oculta" : "Pendiente de revisión por M_AI";

export function ExternalReviewsPanel({ clientId, items }: { clientId: string; items: ExternalItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<{ id: string; kind: "review" | "withdraw" } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return null;
  const send = () =>
    start(async () => {
      if (!open) return;
      const r = await requestExternalReviewAction(clientId, open.id, open.kind, note);
      if (!r.ok) return setError(r.error);
      setOpen(null);
      setNote("");
      router.refresh();
    });
  return (
    <section aria-labelledby="ext-reviews" className="flex flex-col gap-2.5">
      <div>
        <h2 id="ext-reviews" className="text-[15px] font-semibold">
          Reseñas importadas de Fresha ({items.length})
        </h2>
        <p className="mt-0.5 text-[13px] text-muted">
          M_AI las importa y revisa su procedencia; solo M_AI puede publicarlas u ocultarlas. En la página se muestran como «Reseña importada de Fresha», con su fecha original. Puedes pedir que se revise o se retire alguna.
        </p>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {items.map((x) => (
        <article key={x.id} className={`flex flex-col gap-1.5 p-4 text-sm ${CARD}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span aria-label={`${x.rating} de 5 estrellas`} className="font-semibold">
              {"★".repeat(x.rating)}
            </span>
            <span>{x.author}</span>
            <span className="text-muted">· escrita el {new Date(x.writtenAt).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" })}</span>
            <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem]">{STATE(x)}</span>
          </div>
          <p className="text-muted">
            {x.staff ?? "Sin atribuir a un artista"} · {x.service ?? "Servicio no indicado"} · {x.site}
          </p>
          {x.comment ? <p className="whitespace-pre-line">{x.comment}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {(["review", "withdraw"] as const).map((kind) =>
              x.openKinds.includes(kind) ? (
                <span key={kind} className="text-[12.5px] text-muted">
                  {kind === "review" ? "Revisión solicitada" : "Retirada solicitada"}
                </span>
              ) : (
                <Button key={kind} size="sm" variant="tertiary" onClick={() => setOpen({ id: x.id, kind })} disabled={pending}>
                  {kind === "review" ? "Solicitar revisión" : "Solicitar retirada"}
                </Button>
              ),
            )}
          </div>
          {open?.id === x.id ? (
            <div className="flex flex-col gap-2 rounded-sch-control border border-line p-3">
              <label className="flex flex-col gap-1 text-[13px]">
                {open.kind === "review" ? "¿Qué debería revisar M_AI?" : "¿Por qué debería retirarse?"} (opcional)
                <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
              </label>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setOpen(null)}>
                  Cancelar
                </Button>
                <Button size="sm" variant="primary" onClick={send} loading={pending} loadingLabel="Enviando…">
                  Enviar solicitud
                </Button>
              </div>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}
