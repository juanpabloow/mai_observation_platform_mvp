"use client";

import { useId } from "react";
import { PUBLIC_REASON_LABEL, publicReasonPreview, publicReasonsFor, type PublicAbsenceReason } from "@/lib/publicAbsenceReason";

/**
 * "Qué verá el cliente" — the ONE control that decides whether a block's reason may reach a
 * customer (through the assistant). A controlled list, default "No mostrar motivo"; it is
 * independent of the internal "Motivo" field and never pre-filled from it. The preview
 * shows the exact sentence the assistant may use. Used by every block form (agenda time
 * off, Equipo, Agenda → Horarios y ausencias, desktop and phone).
 */

/** The value the form actually submits: a code the scope allows, else null. */
export function effectivePublicReason(value: PublicAbsenceReason | null, scope: "staff" | "site"): PublicAbsenceReason | null {
  return value && publicReasonsFor(scope).includes(value) ? value : null;
}

export function PublicReasonField({
  scope,
  value,
  onChange,
  who,
  variant = "desktop",
}: {
  scope: "staff" | "site";
  value: PublicAbsenceReason | null;
  onChange: (v: PublicAbsenceReason | null) => void;
  /** The professional's name for the preview; null for a site closure. */
  who: string | null;
  variant?: "desktop" | "mobile";
}) {
  const name = useId();
  const current = effectivePublicReason(value, scope);
  const options: Array<{ value: PublicAbsenceReason | null; label: string }> = [
    { value: null, label: "No mostrar motivo" },
    ...publicReasonsFor(scope).map((c) => ({ value: c, label: PUBLIC_REASON_LABEL[c] })),
  ];
  const m = variant === "mobile";
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className={`mb-1.5 p-0 ${m ? "text-[15px] font-semibold text-m-tx" : "text-xs font-medium text-foreground"}`}>Qué verá el cliente</legend>
      <div className={`flex flex-wrap ${m ? "gap-2" : "gap-1.5"}`}>
        {options.map((o) => {
          const on = current === o.value;
          return (
            <label
              key={o.value ?? "none"}
              className={`relative inline-flex cursor-pointer items-center rounded-full border font-medium transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-edge)] ${
                m ? "min-h-[44px] px-4 text-[15px]" : "min-h-[44px] px-3 text-xs lg:min-h-[32px]"
              } ${on ? (m ? "border-m-pri bg-m-pri text-m-onpri" : "border-foreground bg-foreground text-background") : m ? "border-m-bd text-m-tx2" : "border-line text-muted hover:bg-subtle"}`}
            >
              <input
                type="radio"
                name={name}
                checked={on}
                onChange={() => onChange(o.value)}
                className="absolute inset-0 m-0 cursor-pointer opacity-0"
              />
              {o.label}
            </label>
          );
        })}
      </div>
      <p className={`m-0 rounded-lg ${m ? "bg-m-sf2 px-3 py-2.5 text-[14px] leading-[1.45] text-m-tx2" : "bg-subtle px-3 py-2 text-xs leading-relaxed text-muted"}`}>
        <span className={m ? "font-semibold text-m-tx" : "font-medium text-foreground"}>El asistente podrá decir: </span>
        {publicReasonPreview(current, scope === "staff" ? who : null)}
        <span className="block">El «Motivo» interno nunca se comparte con el cliente.</span>
      </p>
      <span className={m ? "text-[13px] text-m-tx3" : "text-[0.6875rem] text-faint"}>
        No uses esta opción para motivos médicos o personales: elige «No mostrar motivo» o «No disponible».
      </span>
    </fieldset>
  );
}
