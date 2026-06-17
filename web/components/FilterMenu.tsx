"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface FilterableField {
  /** field_mappings id (the URL references this, never the raw path). */
  id: string;
  label: string;
}

type CustomOperator = "equals" | "contains" | "not_empty";

const STATUS_OPTIONS = [
  { value: "success", label: "Success" },
  { value: "error", label: "Error" },
];
const OPERATORS: { value: CustomOperator; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "contains", label: "contains" },
  { value: "not_empty", label: "is not empty" },
];

const inputClass =
  "w-full rounded-lg border border-black/10 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-black/30 dark:border-line-strong dark:focus:border-line-strong";

/**
 * Unified Filter dropdown over the F1 backend. It ONLY constructs URL params
 * (status / from / to / cf=<mappingId>:<op>[:<value>]) and navigates — the
 * server re-renders and does all filtering safely. Custom fields are referenced
 * by mapping id; this never builds SQL or bypasses the validated param path.
 */
export function FilterMenu({ customFields }: { customFields: FilterableField[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<null | "status" | "date" | { id: string; label: string }>(null);
  const [operator, setOperator] = useState<CustomOperator>("equals");
  const [value, setValue] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function close() {
    setOpen(false);
    setPicked(null);
    setOperator("equals");
    setValue("");
    setFrom("");
    setTo("");
  }

  function apply(mutate: (p: URLSearchParams) => void) {
    const p = new URLSearchParams(searchParams.toString());
    mutate(p);
    p.delete("page"); // any filter change resets to page 1
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    close();
  }

  function applyCustom(fieldId: string) {
    const entry = operator === "not_empty" ? `${fieldId}:not_empty` : `${fieldId}:${operator}:${value}`;
    apply((p) => {
      if (!p.getAll("cf").includes(entry)) p.append("cf", entry);
    });
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
        aria-expanded={open}
      >
        <span aria-hidden>＋</span> Filter
      </button>

      {open ? (
        <div className="absolute left-0 z-20 mt-2 w-72 overflow-hidden rounded-xl border border-black/10 bg-white shadow-xl dark:border-line-strong dark:bg-neutral-900">
          {picked === null ? (
            <div className="flex flex-col py-1">
              <GroupLabel>Predefined</GroupLabel>
              <FieldButton onClick={() => setPicked("status")}>Status</FieldButton>
              <FieldButton
                onClick={() => {
                  setFrom(searchParams.get("from") ?? "");
                  setTo(searchParams.get("to") ?? "");
                  setPicked("date");
                }}
              >
                Date range
              </FieldButton>

              <GroupLabel>Node outputs</GroupLabel>
              {customFields.length === 0 ? (
                <p className="px-3 py-2 text-xs text-neutral-500">
                  No custom columns — add one to filter by it.
                </p>
              ) : (
                customFields.map((f) => (
                  <FieldButton key={f.id} onClick={() => { setOperator("equals"); setValue(""); setPicked({ id: f.id, label: f.label }); }}>
                    {f.label}
                  </FieldButton>
                ))
              )}
            </div>
          ) : picked === "status" ? (
            <Editor title="Status" onBack={() => setPicked(null)}>
              <div className="flex flex-wrap gap-2">
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => apply((p) => p.set("status", opt.value))}
                    className="rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] dark:border-line-strong dark:hover:bg-subtle"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Editor>
          ) : picked === "date" ? (
            <Editor title="Date range" onBack={() => setPicked(null)}>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                From
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                To
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
              </label>
              <ApplyButton
                disabled={!from && !to}
                onClick={() =>
                  apply((p) => {
                    if (from) p.set("from", from); else p.delete("from");
                    if (to) p.set("to", to); else p.delete("to");
                  })
                }
              />
            </Editor>
          ) : (
            <Editor title={picked.label} onBack={() => setPicked(null)}>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Condition
                <select
                  value={operator}
                  onChange={(e) => setOperator(e.target.value as CustomOperator)}
                  className={inputClass}
                >
                  {OPERATORS.map((op) => (
                    <option key={op.value} value={op.value}>{op.label}</option>
                  ))}
                </select>
              </label>
              {operator !== "not_empty" ? (
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  Value
                  <input
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="value…"
                    className={inputClass}
                  />
                </label>
              ) : null}
              <ApplyButton
                disabled={operator !== "not_empty" && value.trim() === ""}
                onClick={() => applyCustom(picked.id)}
              />
            </Editor>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </p>
  );
}

function FieldButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
    >
      <span className="truncate">{children}</span>
      <span aria-hidden className="text-neutral-500">›</span>
    </button>
  );
}

function Editor({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-xs text-neutral-500 transition-colors hover:text-foreground"
      >
        <span aria-hidden>‹</span> Back
      </button>
      <p className="truncate text-sm font-medium">{title}</p>
      {children}
    </div>
  );
}

function ApplyButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="self-start rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
    >
      Apply filter
    </button>
  );
}
