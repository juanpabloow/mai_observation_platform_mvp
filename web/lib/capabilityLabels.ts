import { ALL_CAPABILITIES, type Capability } from "@worker/capabilities.js";

/**
 * Spanish presentation for every machine-token capability, shown in the token editor
 * (web/components/MachineTokens.tsx). Typed `Record<Capability, …>` ON PURPOSE: a new entry in
 * ALL_CAPABILITIES (src/capabilities.ts) is a COMPILE ERROR here until it is given a label, so the
 * editor can never again be missing a checkbox. Presentation only — the server action re-validates
 * every capability against the canonical vocabulary (web/lib/handoffTokenActions.ts).
 *
 * This file imports ONLY the dependency-free vocabulary module, so it is safe to pull into the
 * "use client" editor bundle (no pg / token repo comes with it).
 */
export const CAPABILITY_LABELS: Record<Capability, { label: string; hint: string }> = {
  handoff: { label: "Handoff (traspaso a humano)", hint: "Mensajes de la conversación, modo y escalamiento a un humano." },
  "handoff.context.read": { label: "Leer el contexto de la conversación", hint: "Mensajes recientes del cliente, del bot y los enviados por humanos, para que el bot se recupere; es opcional." },
  "scheduling.read": { label: "Leer la agenda", hint: "Servicios, profesionales, disponibilidad y lectura de citas." },
  "scheduling.write": { label: "Reservar y cambiar citas", hint: "Crear, cancelar, reprogramar, confirmar y completar." },
  "crm.read": { label: "Leer contactos", hint: "Buscar y leer fichas de contacto." },
  "crm.write": { label: "Crear y actualizar contactos", hint: "Alta, notas, etiquetas, campos y consentimiento." },
  "pipeline.write": { label: "Calificar oportunidades", hint: "Permite que el bot califique la venta de una conversación (lead → calificado) con evidencia." },
  "catalog.read": { label: "Leer el catálogo de productos", hint: "Listar productos, precios y disponibilidad." },
};

/**
 * The editor's checklist, DERIVED from ALL_CAPABILITIES so it always lists every capability in the
 * canonical order. Never hand-maintain this list — add the capability to src/capabilities.ts and its
 * label above, and it appears here automatically.
 */
export const CAPABILITY_CHOICES: { key: Capability; label: string; hint: string }[] = ALL_CAPABILITIES.map(
  (key) => ({ key, ...CAPABILITY_LABELS[key] }),
);
