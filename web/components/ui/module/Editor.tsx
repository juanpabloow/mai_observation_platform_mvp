"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Spinner } from "@/components/ui/controls";
import { SurfaceBody } from "./ModuleSurface";
import { scrollWithin } from "./scrollWithin";

/**
 * THE EDITOR FRAME — editing happens IN the module surface, not in a side panel: the
 * form is long and a panel would squeeze it. Same anatomy everywhere:
 *
 *   EditorHeader   ‹ back · title · meta chips        «2 cambios sin guardar» Cancelar Guardar
 *   index (lg+)    the sections, the one in view marked, a dot on sections with changes
 *                  and the number of errors on sections that have them
 *   sections       one column, labels always visible, help / errors beside each field
 *   SaveBar (<lg)  a fixed bar with the same Cancelar / Guardar, so saving is always
 *                  reachable on a phone; sections fold there and show a summary.
 *
 * Saving is explicit (no autosave). «Guardar» is enabled only with changes and says how
 * many; leaving with changes asks first (useEditorGuard). The frame is pure layout — the
 * module owns its fields, validation and save.
 */

export interface EditorSectionMeta {
  id: string;
  label: string;
  /** This section holds unsaved changes. */
  dirty?: boolean;
  /** Errors to fix in this section (shown after a save attempt). */
  errors?: number;
}

/** How many top-level fields differ — the honest «N cambios sin guardar». */
export function countChanges<T extends object>(initial: T, current: T): number {
  let n = 0;
  for (const k of Object.keys(current) as (keyof T)[]) {
    if (JSON.stringify(initial[k]) !== JSON.stringify(current[k])) n += 1;
  }
  return n;
}

export function changesLabel(n: number): string {
  return n === 0 ? "Sin cambios" : `${n} cambio${n === 1 ? "" : "s"} sin guardar`;
}

export function EditorHeader({
  title,
  headingId,
  eyebrow,
  chips,
  status,
  backLabel,
  onBack,
  changes,
  onCancel,
  onSave,
  saveLabel = "Guardar cambios",
  saving = false,
  canSave,
  readOnly = false,
}: {
  title: string;
  /** id of the <h1>, focusable (-1) so opening the editor can move focus to it. */
  headingId?: string;
  /** "Editar servicio" / "Nuevo producto" — what kind of edit this is. */
  eyebrow: string;
  /** Short real facts about the item (category, duration, price…). */
  chips?: ReactNode;
  status?: ReactNode;
  backLabel: string;
  onBack: () => void;
  changes: number;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
  saving?: boolean;
  /** Defaults to "there are changes". */
  canSave?: boolean;
  /** Viewing without permission to edit: no Cancelar/Guardar, a «Solo lectura» chip. */
  readOnly?: boolean;
}) {
  const enabled = canSave ?? changes > 0;
  return (
    <header className="flex shrink-0 items-center gap-2.5 border-b border-line px-3 py-3 sm:px-5">
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        title={backLabel}
        className="u-focus inline-flex size-[44px] shrink-0 items-center justify-center rounded-sch-control text-muted transition-colors hover:bg-subtle hover:text-foreground lg:size-[2.25rem]"
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M10 3.5 5.5 8l4.5 4.5" />
        </svg>
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 id={headingId} tabIndex={-1} className="truncate text-[1.1875rem] outline-none font-semibold tracking-[-0.015em] text-foreground sm:text-[1.3125rem]">{title}</h1>
          {status}
          {readOnly ? <span className="shrink-0 rounded-full bg-chip px-2 py-0.5 text-[0.7188rem] font-medium text-muted">Solo lectura</span> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[0.7812rem] text-muted">
          <span>{eyebrow}</span>
          {chips}
        </div>
      </div>
      {readOnly ? null : (
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <span aria-live="polite" className="mr-1 text-[0.7812rem] text-muted">
            {changes > 0 ? changesLabel(changes) : ""}
          </span>
          <Button onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={onSave} disabled={!enabled} loading={saving} loadingLabel="Guardando…">
            {saveLabel}
          </Button>
        </div>
      )}
    </header>
  );
}

/** A small neutral fact chip for the editor header. */
export function MetaChip({ children, dot }: { children: ReactNode; dot?: string }) {
  return (
    <span className="inline-flex max-w-[14rem] items-center gap-1.5 truncate rounded-md bg-chip px-1.5 py-0.5 text-[0.75rem] font-medium text-foreground/80">
      {dot ? <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Which section is in view, for the index. A section counts as current once its top
 * crosses the upper third of the scrolling area.
 */
function useSectionSpy(ids: string[], root: RefObject<HTMLDivElement | null>) {
  const [current, setCurrent] = useState(ids[0] ?? "");
  const key = ids.join("|");
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const sections = key.split("|").map((id) => document.getElementById(id)).filter((x): x is HTMLElement => Boolean(x));
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + el.clientHeight / 3;
      let pick = sections[0]?.id ?? "";
      for (const s of sections) if (s.getBoundingClientRect().top <= top) pick = s.id;
      // At the very bottom the last section is current even if it is short.
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4 && sections.length) pick = sections[sections.length - 1].id;
      setCurrent(pick);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [key, root]);
  return current;
}

function EditorIndex({ sections, current, onJump }: { sections: EditorSectionMeta[]; current: string; onJump: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2.5 pb-1.5 pt-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">Secciones</p>
      {sections.map((s) => {
        const on = s.id === current;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={on ? "location" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onJump(s.id);
            }}
            className={`u-focus flex h-[2.25rem] items-center gap-2 rounded-sch-control px-2.5 text-[0.8438rem] transition-colors ${
              on ? "bg-subtle font-semibold text-foreground" : "text-muted hover:bg-subtle hover:text-foreground"
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            {s.errors ? (
              <span className="u-mono rounded-full bg-danger/12 px-1.5 text-[0.6875rem] font-semibold text-danger">
                <span className="sr-only">Errores: </span>
                {s.errors}
              </span>
            ) : s.dirty ? (
              <span className="size-1.5 shrink-0 rounded-full bg-service-purple" title="Con cambios sin guardar">
                <span className="sr-only">Con cambios sin guardar</span>
              </span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}

/**
 * The editor body: index on the left (lg+, always open — it is navigation, not a
 * filter), the sections in one readable column, and the phone save bar.
 */
export function EditorFrame({
  sections,
  children,
  saveBar,
  bodyRef,
  aside,
  asideOpen = true,
  asideLabel,
  layout = "index",
}: {
  sections: EditorSectionMeta[];
  children: ReactNode;
  /** <SaveBar/> for widths without the header buttons. */
  saveBar?: ReactNode;
  bodyRef?: RefObject<HTMLDivElement | null>;
  /** A companion column on the right from xl (a live preview). It can be folded
   *  (`asideOpen`) so a laptop gives the form its width back; below xl it is drawn at
   *  the END of the content instead, never squeezing the form. */
  aside?: ReactNode;
  asideOpen?: boolean;
  asideLabel?: string;
  /**
   * «index» (default): the section index on the left and one centred column.
   * «rows»: for short forms — no index; each section is a settings ROW at xl, its name
   * and explanation on the left and its controls on the right, using the full width.
   */
  layout?: "index" | "rows";
}) {
  const withIndex = layout === "index";
  const own = useRef<HTMLDivElement>(null);
  const ref = bodyRef ?? own;
  const current = useSectionSpy(
    sections.map((s) => s.id),
    ref,
  );
  const jump = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    scrollWithin(el);
    // Move focus with the reader so keyboard users land in the section.
    el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  };
  return (
    <div className="flex min-h-0 flex-1">
      <SurfaceBody rail={withIndex ? <EditorIndex sections={sections} current={current} onJump={jump} /> : undefined} railLabel="Secciones" railAlwaysOpen contentRef={ref}>
        <div className={withIndex ? "mx-auto flex w-full max-w-[47.5rem] flex-col px-4 pb-8 pt-5 sm:px-6 lg:px-8" : "flex w-full max-w-[72rem] flex-col px-4 pb-8 pt-2 sm:px-6"}>
          <SectionLayout.Provider value={layout}>{children}</SectionLayout.Provider>
          {aside ? (
            <section aria-label={asideLabel} className="mt-2 border-t border-line pt-6 xl:hidden">
              {aside}
            </section>
          ) : null}
        </div>
        {saveBar}
      </SurfaceBody>
      {aside && asideOpen ? (
        <aside id="editor-aside" aria-label={asideLabel} className="hidden w-[21.25rem] shrink-0 overflow-y-auto border-l border-line bg-subtle/40 px-5 py-5 xl:block">
          {aside}
        </aside>
      ) : null}
    </div>
  );
}

/** How EditorFrame lays its sections out (read by EditorSection). */
const SectionLayout = createContext<"index" | "rows">("index");

/**
 * One section of an editor. Desktop: always open, a plain heading. Below lg: a fold
 * with its summary visible when closed (relations like «Profesionales · 2»), so a long
 * form is scannable on a phone without hiding what it holds.
 */
export function EditorSection({
  id,
  title,
  description,
  summary,
  error,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  /** One-line summary shown on the folded phone header. */
  summary?: ReactNode;
  /** A section-level error (e.g. "choose at least one site"). */
  error?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // «rows» (short forms, xl+): name + explanation on the left, controls on the right.
  const rows = useContext(SectionLayout) === "rows";
  const grid = rows ? "xl:grid xl:grid-cols-[18rem_minmax(0,1fr)] xl:items-start xl:gap-x-12" : "";
  const bodyId = useId();
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={`scroll-mt-4 border-b border-line py-6 first:pt-1 last:border-b-0 ${grid}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-h`} tabIndex={-1} className="text-[0.9688rem] font-semibold text-foreground outline-none">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[0.8125rem] text-muted">{description}</p> : null}
          {!open && summary ? <p className="mt-1 text-[0.8125rem] text-foreground lg:hidden">{summary}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? "Plegar" : "Desplegar"} ${title}`}
          className="u-focus -mr-2 -mt-2 inline-flex size-[44px] shrink-0 items-center justify-center rounded-sch-control text-muted hover:bg-subtle lg:hidden"
        >
          <svg aria-hidden viewBox="0 0 16 16" className={`size-4 motion-safe:transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>
      <div id={bodyId} className={`${open ? "" : "max-lg:hidden"} mt-4 flex flex-col gap-4 ${rows ? "xl:col-start-2 xl:mt-0" : ""}`}>
        {children}
      </div>
      {error ? (
        <p role="alert" className={`${rows ? "xl:col-start-2" : ""} mt-3 text-[0.8125rem] text-danger`}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

export interface SummaryError {
  /** id of the control to focus. */
  target: string;
  message: string;
}

/** «Revisa N campos antes de guardar» — every error, each a link that focuses its field. */
export function ErrorSummary({ errors, title }: { errors: SummaryError[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = errors.length > 0;
  useEffect(() => {
    if (shown && ref.current) {
      ref.current.focus({ preventScroll: true });
      scrollWithin(ref.current, { smooth: false });
    }
  }, [shown]);
  if (!shown) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mb-2 rounded-sch-card border border-danger/35 bg-danger/8 px-4 py-3 outline-none">
      <p className="text-[0.8438rem] font-semibold text-danger">{title ?? `Revisa ${errors.length} campo${errors.length === 1 ? "" : "s"} antes de guardar`}</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {errors.map((e) => (
          <li key={e.target + e.message}>
            <a
              href={`#${e.target}`}
              onClick={(ev) => {
                ev.preventDefault();
                const el = document.getElementById(e.target);
                if (!el) return;
                scrollWithin(el, { block: "center" });
                el.focus({ preventScroll: true });
              }}
              className="text-[0.8125rem] text-danger underline underline-offset-2"
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The phone / tablet save bar (below lg): always reachable, never covering a field. */
export function SaveBar({
  changes,
  onCancel,
  onSave,
  saveLabel = "Guardar",
  saving = false,
  canSave,
}: {
  changes: number;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
  saving?: boolean;
  canSave?: boolean;
}) {
  const enabled = canSave ?? changes > 0;
  return (
    <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-line bg-surface/95 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
      <span aria-live="polite" className="min-w-0 flex-1 truncate text-[0.7812rem] text-muted">
        {changes > 0 ? changesLabel(changes) : "Sin cambios"}
      </span>
      <Button onClick={onCancel} disabled={saving}>
        Cancelar
      </Button>
      <Button variant="primary" onClick={onSave} disabled={!enabled} loading={saving} loadingLabel="Guardando…">
        {saveLabel}
      </Button>
    </div>
  );
}

/** «Guardando…» / «Guardado» inline note for screens that save in place. */
export function SaveNote({ state }: { state: "idle" | "saving" | "saved" }) {
  if (state === "idle") return null;
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-[0.7812rem] text-muted">
      {state === "saving" ? <Spinner /> : null}
      {state === "saving" ? "Guardando…" : "Cambios guardados"}
    </span>
  );
}
