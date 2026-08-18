"use client";

import type { FieldDefView } from "../ContactProperties";
import { ChipSelect, Field, INPUT_CLS } from "./formPrimitives";

/**
 * "CONFIGURADO POR EL NEGOCIO" — the second of the form's two levels.
 *
 * Everything above it is GENERIC (identity, owner, stage, consent): the same fields for
 * a barbershop and a law firm. Everything here comes from the TENANT'S OWN
 * client_field_definitions — the same definitions the contact record's "CLIENT FIELDS ·
 * Manage" block reads, and the same ones validateCustomFieldValues type-checks on write.
 * Nothing about any vertical is hardcoded: "Intereses" and "Origen" are DATA in the
 * reference, not cases in this file, which is why a client with no definitions renders
 * no section at all rather than an empty heading.
 *
 * Values render by TYPE, never by key. A `select` becomes the reference's chip row
 * (options are already a bounded list, so chips beat a dropdown — they show every
 * choice at once); a `boolean` becomes two chips; text/number/date stay inputs.
 *
 * KNOWN GAP, deliberately not faked: the reference shows "Intereses" with TWO chips
 * lit, i.e. multi-select. The field-definition schema has no multi type (`select` is
 * one-of, and the stored value is a scalar), so this renders it single-select. Adding
 * a real `multi_select` means a migration plus a validateCustomFieldValues branch —
 * flagged rather than approximated with a comma-joined string that would break the
 * type check on the next write.
 */
export function ClientFieldsSection({
  fieldDefs,
  values,
  onChange,
}: {
  fieldDefs: FieldDefView[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const set = (key: string, value: unknown) => {
    const next = { ...values };
    if (value === null || value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3.5">
      {fieldDefs.map((d) => {
        const raw = values[d.key];

        if (d.type === "select") {
          const current = typeof raw === "string" ? raw : "";
          return (
            <Field key={d.id} label={d.label}>
              <ChipSelect
                multi={false}
                ariaLabel={d.label}
                values={d.options ?? []}
                selected={current ? [current] : []}
                // Clicking the lit chip clears it — a single-select chip row with no way
                // back to "unset" would make an accidental tap permanent.
                onToggle={(v) => set(d.key, v === current ? null : v)}
              />
            </Field>
          );
        }

        if (d.type === "boolean") {
          const current = raw === true ? "Sí" : raw === false ? "No" : "";
          return (
            <Field key={d.id} label={d.label}>
              <ChipSelect
                multi={false}
                ariaLabel={d.label}
                values={["Sí", "No"]}
                selected={current ? [current] : []}
                onToggle={(v) => set(d.key, v === current ? null : v === "Sí")}
              />
            </Field>
          );
        }

        const asString = raw === undefined || raw === null ? "" : String(raw);
        return (
          <Field key={d.id} label={d.label} htmlFor={`cf-${d.key}`}>
            <input
              id={`cf-${d.key}`}
              value={asString}
              type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") set(d.key, null);
                // number must reach the server as a NUMBER — validateCustomFieldValues
                // rejects "12" for a number field, by design.
                else if (d.type === "number") set(d.key, Number(v));
                else set(d.key, v);
              }}
              className={INPUT_CLS}
            />
          </Field>
        );
      })}
    </div>
  );
}
