"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createFieldDefinitionAction, updateFieldDefinitionAction } from "@/lib/fieldDefinitionActions";
import { Alert, Button, Field, INPUT, TEXTAREA, buttonClass } from "@/components/ui/controls";
import { Menu as ActionMenu, MenuButton } from "@/components/scheduling/ui/Menu";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, ErrorSummary, MetaChip, SaveBar, countChanges, type SummaryError } from "@/components/ui/module/Editor";
import { ChoiceChips, FieldGroup, Notice, ToggleRow } from "@/components/ui/module/FormKit";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";

/**
 * «Campos personalizados» (Configuración) — the extra fields of this client's CONTACTS
 * (client_field_definitions), in the module surface. Owner / agency only (server gate).
 *
 * What the model allows, and nothing more:
 *   - five types: text, number, date, select, boolean;
 *   - the KEY and the TYPE are fixed once created (changing them would strand the values
 *     already stored in contacts.custom_fields), so they are read-only when editing;
 *   - there is no delete: «Desactivar» hides the field from the forms and the CRM API
 *     and keeps every stored value;
 *   - a select's existing options are kept (a contact may hold one); new ones can be
 *     added.
 * There is no count of contacts per value in the product, so no impact numbers are shown.
 */

type FieldType = "text" | "number" | "date" | "select" | "boolean";
export interface DefView {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  enabled: boolean;
  position: number;
}

const TYPE_LABEL: Record<FieldType, string> = { text: "Texto", number: "Número", date: "Fecha", select: "Lista de opciones", boolean: "Sí / No" };
const TYPES: FieldType[] = ["text", "number", "date", "select", "boolean"];
const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
const DISABLED = "desactivados";

/** The repository's English errors, in the screen's language. */
function spanish(error: string): string {
  if (/already exists/i.test(error)) return "Ya existe un campo con esa clave.";
  if (/key must be/i.test(error)) return "La clave solo admite minúsculas, números y guion bajo, y empieza por una letra.";
  if (/at least one option/i.test(error)) return "Una lista necesita al menos una opción.";
  if (/label required/i.test(error)) return "Escribe la etiqueta del campo.";
  if (/not allowed/i.test(error)) return "No tienes permiso para cambiar los campos de este negocio.";
  return error;
}

const keyFrom = (label: string) =>
  label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 63);

const COLUMNS: ListColumn[] = [
  { key: "label", label: "Campo" },
  { key: "type", label: "Tipo", className: "w-[9.375rem]" },
  { key: "options", label: "Opciones", className: "hidden w-[28%] lg:table-cell" },
  { key: "state", label: "Estado", className: "w-[7.375rem]" },
];

export function FieldDefinitions({ clientId, defs }: { clientId: string; defs: DefView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useUrlState("tipo", "");
  const [query, setQuery] = useUrlState("q", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<DefView | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef("new");

  const enabled = defs.filter((d) => d.enabled);
  const view = filter === DISABLED || TYPES.includes(filter as FieldType) ? filter : "";
  const q = query.trim().toLocaleLowerCase("es");
  const shown = (view === DISABLED ? defs.filter((d) => !d.enabled) : enabled.filter((d) => !view || d.type === view)).filter(
    (d) => !q || d.label.toLocaleLowerCase("es").includes(q) || d.key.includes(q),
  );
  const groups: FilterGroup[] = [
    {
      label: "Tipo",
      options: [{ value: "", label: "Todos", count: enabled.length }, ...TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t], count: enabled.filter((d) => d.type === t).length }))],
    },
    { label: "Otros", options: [{ value: DISABLED, label: "Desactivados", count: defs.length - enabled.length }] },
  ];

  const setEnabled = (d: DefView, on: boolean) => {
    setMenu(null);
    setError(null);
    start(async () => {
      const r = await updateFieldDefinitionAction(clientId, d.id, { enabled: on });
      if (!r.ok) setError(spanish(r.error));
      else router.refresh();
    });
  };
  const open = (d: DefView | "new") => {
    setMenu(null);
    opener.current = d === "new" ? "new" : d.id;
    setEditing(d);
  };

  if (editing) {
    return (
      <ModuleSurface label="Campos personalizados">
        <FieldEditor
          key={editing === "new" ? "new" : editing.id}
          clientId={clientId}
          def={editing === "new" ? null : editing}
          nextPosition={Math.max(0, ...defs.map((d) => d.position)) + 1}
          onClose={(saved) => {
            setEditing(null);
            if (saved) router.refresh();
            returnFocus(opener.current);
          }}
        />
      </ModuleSurface>
    );
  }

  const stateChip = (d: DefView) => <span className={`rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${d.enabled ? "bg-success/15 text-success" : "bg-chip text-muted"}`}>{d.enabled ? "Activo" : "Desactivado"}</span>;
  const rowMenu = (d: DefView, at: "t" | "m") => (
    <ActionMenu label={`Acciones de ${d.label}`} open={menu === `${at}:${d.id}`} onToggle={() => setMenu(menu === `${at}:${d.id}` ? null : `${at}:${d.id}`)} onClose={() => setMenu(null)}>
      <MenuButton onClick={() => open(d)}>Editar</MenuButton>
      <MenuButton disabled={pending} onClick={() => setEnabled(d, !d.enabled)}>
        {d.enabled ? "Desactivar" : "Activar"}
      </MenuButton>
    </ActionMenu>
  );

  return (
    <ModuleSurface label="Campos personalizados">
      <SurfaceTop
        title="Campos personalizados"
        summary={`Datos extra en la ficha de tus contactos · ${enabled.length} activo${enabled.length === 1 ? "" : "s"}${defs.length - enabled.length ? ` · ${defs.length - enabled.length} desactivado${defs.length - enabled.length === 1 ? "" : "s"}` : ""}`}
        actions={
          <Link href={`/clients/${clientId}/contacts`} className={buttonClass()}>
            Ir a Contactos
          </Link>
        }
        primary={
          <Button variant="primary" data-open-key="new" onClick={() => open("new")}>
            <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 3v10M3 8h10" />
            </svg>
            Nuevo campo
          </Button>
        }
      >
        <RailToggle />
        <SearchField value={query} onChange={setQuery} label="Buscar campo" />
        <FilterSelect groups={groups} value={view} onChange={setFilter} label="Tipo" className="w-full sm:w-auto sm:min-w-[12rem]" />
      </SurfaceTop>
      <SurfaceBody rail={<FilterRail groups={groups} value={view} onChange={setFilter} />} railLabel="Tipos de campo">
        {error ? (
          <div className="px-4 pt-3 sm:px-6">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {defs.length === 0 ? (
          <EmptyState title="Todavía no hay campos personalizados" body="Añade datos que quieras guardar de cada contacto: barbero preferido, fecha de cumpleaños, cómo nos conoció…">
            <Button variant="primary" onClick={() => open("new")}>
              Nuevo campo
            </Button>
          </EmptyState>
        ) : shown.length === 0 ? (
          view === DISABLED && !q ? (
            <EmptyState title="No hay campos desactivados" body="Al desactivar un campo se oculta de los formularios y se conservan sus valores." />
          ) : !q && view === "" ? (
            // Nothing searched or filtered: there are simply no ACTIVE fields.
            <EmptyState
              title="No hay campos activos"
              body={`${defs.length - enabled.length === 1 ? "El único campo está desactivado" : `Los ${defs.length - enabled.length} campos están desactivados`}: no se muestran en los formularios y sus valores se conservan.`}
            >
              <Button variant="primary" onClick={() => open("new")}>
                Nuevo campo
              </Button>
              <Button onClick={() => setFilter(DISABLED)}>Ver desactivados</Button>
            </EmptyState>
          ) : !q ? (
            <EmptyState title={`No hay campos de tipo «${TYPE_LABEL[view as FieldType]}»`} body="Los campos de otros tipos están en «Todos».">
              <Button onClick={() => setFilter("")}>Ver todos</Button>
            </EmptyState>
          ) : (
            <NoResults>
              {q ? <Button onClick={() => setQuery("")}>Borrar búsqueda</Button> : null}
              {view ? <Button onClick={() => setFilter("")}>Ver todos</Button> : null}
            </NoResults>
          )
        ) : (
          <>
            <ListTable label="Campos personalizados" columns={COLUMNS}>
              <ListGroup span={COLUMNS.length + 1}>
                {shown.map((d) => (
                  <ListRow
                    key={d.id}
                    columns={COLUMNS}
                    name={d.label}
                    openKey={d.id}
                    onOpen={() => open(d)}
                    openLabel="Editar"
                    raised={menu === `t:${d.id}`}
                    dimmed={!d.enabled}
                    menu={rowMenu(d, "t")}
                    cells={[
                      <span key="l" className="flex min-w-0 flex-col py-1.5">
                        <span className="truncate">{d.label}</span>
                        <span className="u-mono truncate text-[0.75rem] font-normal text-muted">{d.key}</span>
                      </span>,
                      <span key="t">{TYPE_LABEL[d.type]}</span>,
                      <span key="o" className="text-muted">{d.type === "select" ? (d.options ?? []).join(", ") : "—"}</span>,
                      stateChip(d),
                    ]}
                  />
                ))}
              </ListGroup>
            </ListTable>
            <MobileList>
              <MobileGroup>
                {shown.map((d) => (
                  <MobileRow key={d.id} title={d.label} openKey={d.id} subtitle={`${TYPE_LABEL[d.type]} · ${d.key}`} badges={stateChip(d)} onOpen={() => open(d)} openLabel="Editar" menu={rowMenu(d, "m")} dimmed={!d.enabled} />
                ))}
              </MobileGroup>
            </MobileList>
            <ListFoot>Se usan en la ficha y los formularios de contacto, y en la API de CRM (solo los activos).</ListFoot>
          </>
        )}
      </SurfaceBody>
    </ModuleSurface>
  );
}

interface FieldForm {
  label: string;
  key: string;
  type: FieldType;
  options: string[];
  newOptions: string;
  enabled: boolean;
}

function FieldEditor({ clientId, def, nextPosition, onClose }: { clientId: string; def: DefView | null; nextPosition: number; onClose: (saved: boolean) => void }) {
  const initial = useMemo<FieldForm>(
    () => ({ label: def?.label ?? "", key: def?.key ?? "", type: def?.type ?? "text", options: def?.options ?? [], newOptions: "", enabled: def?.enabled ?? true }),
    [def],
  );
  const [f, setF] = useState<FieldForm>(initial);
  const [keyTouched, setKeyTouched] = useState(Boolean(def));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);
  const key = def ? def.key : keyTouched ? f.key : keyFrom(f.label);
  const added = f.newOptions
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
  const allOptions = [...new Set([...f.options, ...added])];
  const changes = countChanges(initial, { ...f, key });
  const set = <K extends keyof FieldForm>(k: K, v: FieldForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => onClose(saved.current) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };

  const errors: Partial<Record<"label" | "key" | "options", string>> = {};
  if (!f.label.trim()) errors.label = "Escribe la etiqueta del campo.";
  if (!def && !KEY_RE.test(key)) errors.key = "Solo minúsculas, números y guion bajo; empieza por una letra.";
  if (f.type === "select" && allOptions.length === 0) errors.options = "Una lista necesita al menos una opción.";
  const show = (k: keyof typeof errors) => (attempted ? errors[k] : "") || "";

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setError(null);
    const r = def
      ? await updateFieldDefinitionAction(clientId, def.id, {
          ...(f.label.trim() !== def.label ? { label: f.label.trim() } : {}),
          ...(def.type === "select" && added.length ? { options: allOptions } : {}),
          ...(f.enabled !== def.enabled ? { enabled: f.enabled } : {}),
        })
      : await createFieldDefinitionAction(clientId, { key, label: f.label.trim(), type: f.type, options: f.type === "select" ? allOptions : null, position: nextPosition });
    setSaving(false);
    if (!r.ok) {
      setError(`${spanish(r.error)} Lo que escribiste se conserva.`);
      return;
    }
    saved.current = true;
    guard.leave();
  };

  const summary: SummaryError[] = attempted
    ? [
        ...(errors.label ? [{ target: "fd-f-label", message: `Etiqueta: ${errors.label}` }] : []),
        ...(errors.key ? [{ target: "fd-f-key", message: `Clave: ${errors.key}` }] : []),
        ...(errors.options ? [{ target: "fd-f-options", message: `Opciones: ${errors.options}` }] : []),
      ]
    : [];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest("select, [role=menu]")) return;
        e.preventDefault();
        requestClose();
      }}
    >
      <EditorHeader
        title={def ? def.label : "Nuevo campo"}
        headingId="fd-editor-title"
        eyebrow={def ? "Editar campo personalizado" : "Configuración · Campos personalizados"}
        chips={
          <>
            <MetaChip>{TYPE_LABEL[f.type]}</MetaChip>
            <MetaChip>{key || "sin clave"}</MetaChip>
          </>
        }
        backLabel="Volver a Campos personalizados"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={def ? "Guardar cambios" : "Crear campo"}
        saving={saving}
        canSave={def ? changes > 0 : true}
      />
      <EditorFrame
        sections={[
          { id: "fd-basic", label: "Información básica", dirty: f.label !== initial.label || (!def && key !== initial.key), errors: attempted ? Number(Boolean(errors.label)) + Number(Boolean(errors.key)) : 0 },
          { id: "fd-type", label: "Tipo", dirty: f.type !== initial.type || added.length > 0, errors: attempted && errors.options ? 1 : 0 },
          { id: "fd-state", label: "Estado", dirty: f.enabled !== initial.enabled },
        ]}
        saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={def ? "Guardar" : "Crear"} canSave={def ? changes > 0 : true} />}
      >
        <ErrorSummary errors={summary} />
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <EditorSection id="fd-basic" title="Información básica" summary={`${f.label || "Sin etiqueta"} · ${key || "sin clave"}`}>
          <Field label="Etiqueta" hint="Lo que lee el equipo en la ficha del contacto." error={show("label")}>
            <input id="fd-f-label" value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="Ej. Barbero preferido" aria-invalid={Boolean(show("label"))} className={INPUT} />
          </Field>
          {def ? (
            <Field label="Clave" hint="No se puede cambiar: es como la guardan los contactos y la API.">
              <input value={def.key} readOnly aria-readonly className={`${INPUT} font-mono text-muted`} />
            </Field>
          ) : (
            <Field label="Clave" hint="La usan la API y las integraciones. Se genera de la etiqueta; después de crear el campo no se puede cambiar." error={show("key")}>
              <input
                id="fd-f-key"
                value={key}
                onChange={(e) => {
                  setKeyTouched(true);
                  set("key", e.target.value);
                }}
                aria-invalid={Boolean(show("key"))}
                className={`${INPUT} font-mono`}
              />
            </Field>
          )}
        </EditorSection>
        <EditorSection id="fd-type" title="Tipo" summary={TYPE_LABEL[f.type]}>
          {def ? (
            <>
              <FieldGroup legend="Tipo de dato">
                <span className="inline-flex h-[2.5rem] w-fit items-center rounded-sch-control border border-line bg-subtle px-3 text-[0.8125rem] font-medium">{TYPE_LABEL[def.type]}</span>
              </FieldGroup>
              <Notice>El tipo no se puede cambiar: los valores que ya tienen los contactos se conservan tal cual.</Notice>
            </>
          ) : (
            <FieldGroup legend="Tipo de dato" hint="Después de crear el campo no se puede cambiar.">
              <ChoiceChips name="fd-type" value={f.type} options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} onChange={(v) => set("type", v)} />
            </FieldGroup>
          )}
          {f.type === "select" ? (
            <>
              {f.options.length ? (
                <FieldGroup legend="Opciones actuales" hint={def ? "Se conservan: algún contacto puede tener una de ellas." : undefined}>
                  <span className="flex flex-wrap gap-1.5">
                    {f.options.map((o) => (
                      <span key={o} className="rounded-md bg-chip px-2 py-1 text-[0.7812rem]">
                        {o}
                      </span>
                    ))}
                  </span>
                </FieldGroup>
              ) : null}
              <Field label={def ? "Añadir opciones" : "Opciones"} optional={Boolean(def)} hint="Una por línea." error={show("options")}>
                <textarea id="fd-f-options" value={f.newOptions} onChange={(e) => set("newOptions", e.target.value)} rows={4} aria-invalid={Boolean(show("options"))} className={TEXTAREA} />
              </Field>
            </>
          ) : null}
        </EditorSection>
        <EditorSection id="fd-state" title="Estado" summary={f.enabled ? "Activo" : "Desactivado"}>
          <ToggleRow checked={f.enabled} onChange={(v) => set("enabled", v)} label="Activo" hint="Desactivado: deja de mostrarse en los formularios y en la API de CRM. Los valores guardados en los contactos se conservan; no se borra nada." />
        </EditorSection>
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en este campo. Si sales ahora, se pierden." /> : null}
    </div>
  );
}
