/**
 * INBOX PRESENTATION — the pure rules behind the inbox redesign ("Inbox de Gallery"):
 * Spanish 24-hour dates, the row/header title, the three state chips, the WhatsApp 24 h
 * window wording, the tabs and the search. CLIENT-SAFE (no server imports) and pure, so
 * every rule is unit-tested once and the list, the thread and the phone views agree.
 *
 * The design's three concepts, three signals:
 *   - who answers   → "Bot responde" · "Tú respondes" · "Diego responde"
 *   - attention     → "Necesita una persona" (the bot escalated and nobody took it — NOT "unread")
 *   - the 24 h window → "Ventana abierta · quedan 21 h" · "Ventana de 24 h vencida"
 * Each is derived from real fields (mode, assigned agent, the customer's last message);
 * nothing here invents a state the data does not have.
 */

import { formatConversationRef, type InboxConversationView, type InboxMode } from "./inboxView";

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAY_MS = 86_400_000;

/** "Lun", "Mar"… — Intl's "lun." without the dot, capitalised. */
function weekdayShort(d: Date): string {
  const w = d.toLocaleDateString("es-CO", { weekday: "short" }).replace(".", "");
  return w.charAt(0).toUpperCase() + w.slice(1);
}
/** "10 oct" (+ year when it is not this year). */
function dayMonth(d: Date, now: Date): string {
  const m = d.toLocaleDateString("es-CO", { month: "short" }).replace(".", "");
  return d.getFullYear() === now.getFullYear() ? `${d.getDate()} ${m}` : `${d.getDate()} ${m} ${d.getFullYear()}`;
}
/** Whole local days between two instants (0 = same day). */
function daysBetween(d: Date, now: Date): number {
  return Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / DAY_MS);
}

// ── Dates ───────────────────────────────────────────────────────────────────────

/** 24-hour clock: "14:08". */
export function clock24(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The queue stamp: today "14:08", yesterday "Ayer", within a week "Lun", then "10 oct". */
export function listStamp(d: Date, now: Date): string {
  const days = daysBetween(d, now);
  if (days <= 0) return clock24(d);
  if (days === 1) return "Ayer";
  if (days < 7) return weekdayShort(d);
  return dayMonth(d, now);
}

/** The thread's day seam: "Hoy", "Ayer", then "Sáb 10 oct". */
export function daySeam(d: Date, now: Date): string {
  const days = daysBetween(d, now);
  if (days <= 0) return "Hoy";
  if (days === 1) return "Ayer";
  return `${weekdayShort(d)} ${dayMonth(d, now)}`;
}

export { dayKey as localDayKey };

/** "hace 20 min", "hace 5 h", "hace 3 d". */
export function agoEs(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

// ── Identity ────────────────────────────────────────────────────────────────────

/** Is this conversation identifier a phone number (vs. an opaque channel id)? */
export function isPhoneRef(ref: string): boolean {
  const digits = ref.replace(/\D/g, "");
  return /^[+\d\s().-]+$/.test(ref) && digits.length >= 10 && digits.length <= 15;
}

/**
 * The title a row or header shows: the contact's NAME, else the known PHONE, else
 * "Contacto sin nombre". An opaque channel id is never presented as a number — it lives
 * in the ficha as "ID de canal".
 */
export function conversationTitle(name: string | null | undefined, ref: string): { text: string; kind: "name" | "phone" | "unknown" } {
  const n = name?.trim();
  if (n) return { text: n, kind: "name" };
  if (isPhoneRef(ref)) return { text: formatConversationRef(ref), kind: "phone" };
  return { text: "Contacto sin nombre", kind: "unknown" };
}

/** The avatar text: initials for a name, "#" for a bare phone, "?" when unknown. */
export function avatarText(name: string | null | undefined, ref: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) return words.slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return isPhoneRef(ref) ? "#" : "?";
}

// ── Who answers ─────────────────────────────────────────────────────────────────

export type ResponderKind = "pending" | "you" | "other" | "bot";

/** First name of a person, for "Diego responde" / "Tú (Laura)". */
export function firstName(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().split(/\s+/)[0];
  return n || null;
}

export function responder(
  mode: InboxMode,
  assignedUserId: string | null,
  assignedName: string | null,
  viewerUserId: string,
): { kind: ResponderKind; label: string } {
  if (mode === "pending") return { kind: "pending", label: "Necesita una persona" };
  if (mode === "bot") return { kind: "bot", label: "Bot responde" };
  if (assignedUserId && assignedUserId === viewerUserId) return { kind: "you", label: "Tú respondes" };
  const who = firstName(assignedName);
  return { kind: "other", label: who ? `${who} responde` : "Otra persona responde" };
}

// ── WhatsApp 24 h window ────────────────────────────────────────────────────────

export const WINDOW_HOURS = 24;

export type WindowState =
  | { state: "open"; hoursLeft: number }
  | { state: "closed"; closedFor: number }
  | { state: "never" };

/** From the customer's LAST inbound message (null = they never wrote). */
export function windowState(lastUserMessageAt: string | null, now: Date): WindowState {
  if (!lastUserMessageAt) return { state: "never" };
  const t = new Date(lastUserMessageAt).getTime();
  if (Number.isNaN(t)) return { state: "never" };
  const closes = t + WINDOW_HOURS * 3_600_000;
  if (now.getTime() < closes) return { state: "open", hoursLeft: Math.max(1, Math.ceil((closes - now.getTime()) / 3_600_000)) };
  return { state: "closed", closedFor: now.getTime() - closes };
}

/** The header chip. Null when the customer never wrote (no window to speak of yet). */
export function windowChip(w: WindowState): { open: boolean; label: string } | null {
  if (w.state === "open") return { open: true, label: `Ventana abierta · quedan ${w.hoursLeft} h` };
  if (w.state === "closed") return { open: false, label: "Ventana de 24 h vencida" };
  return null;
}

/** The one line that replaces the composer while the window is closed or never opened. */
export function windowClosedLine(w: WindowState): string | null {
  if (w.state === "closed") {
    return `La ventana de 24 h se cerró ${agoEs(w.closedFor)}. WhatsApp solo permite enviar una plantilla aprobada.`;
  }
  if (w.state === "never") return "WhatsApp solo permite escribir después de que la persona te escriba primero.";
  return null;
}

// ── Tabs, counts, search, day buckets ───────────────────────────────────────────

export type InboxTab = "all" | "pending" | "human" | "bot";

export const INBOX_TABS: ReadonlyArray<{ key: InboxTab; label: string; name: string }> = [
  { key: "all", label: "Todas", name: "Todas" },
  { key: "pending", label: "Escalado", name: "Necesitan una persona" },
  { key: "human", label: "", name: "Atiende una persona" },
  { key: "bot", label: "", name: "Atiende el bot" },
];

export function tabCounts(views: ReadonlyArray<Pick<InboxConversationView, "mode">>): Record<InboxTab, number> {
  const c = { all: views.length, pending: 0, human: 0, bot: 0 };
  for (const v of views) c[v.mode] += 1;
  return c;
}

export function inTab(mode: InboxMode, tab: InboxTab): boolean {
  return tab === "all" || mode === tab;
}

/** Counters are capped: "99+". */
export function capCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/**
 * Search: name, number (raw or as displayed), last message and workflow — case and
 * accent-insensitive. The NAME was missing before, even though the field promised it.
 */
export function matchesSearch(
  v: Pick<InboxConversationView, "contactName" | "conversationRef" | "lastMessageText" | "workflowName">,
  query: string,
): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = fold(query.trim());
  if (!needle) return true;
  const digits = needle.replace(/\D/g, "");
  const hay = [v.contactName ?? "", v.conversationRef, formatConversationRef(v.conversationRef), v.lastMessageText ?? "", v.workflowName ?? ""].map(fold);
  if (hay.some((h) => h.includes(needle))) return true;
  return digits.length >= 3 && v.conversationRef.replace(/\D/g, "").includes(digits);
}

export type DayBucketKey = "today" | "yesterday" | "older";
const BUCKET_LABEL: Record<DayBucketKey, string> = { today: "Hoy", yesterday: "Ayer", older: "Anteriores" };

/** Hoy · Ayer · Anteriores inside a group, by the conversation's last activity. Order kept. */
export function dayBuckets<T extends { lastMessageAt: string | null; createdAt: string }>(
  items: T[],
  now: Date,
): Array<{ key: DayBucketKey; label: string; items: T[] }> {
  const out: Record<DayBucketKey, T[]> = { today: [], yesterday: [], older: [] };
  for (const it of items) {
    const d = new Date(it.lastMessageAt ?? it.createdAt);
    const days = daysBetween(d, now);
    out[days <= 0 ? "today" : days === 1 ? "yesterday" : "older"].push(it);
  }
  return (["today", "yesterday", "older"] as const).filter((k) => out[k].length > 0).map((k) => ({ key: k, label: BUCKET_LABEL[k], items: out[k] }));
}

/** Two preview lines only where someone must act; one elsewhere, to keep rows short. */
export function previewLines(mode: InboxMode): 1 | 2 {
  return mode === "pending" ? 2 : 1;
}

// ── Take / return (replaces the Humano|Bot toggle) ──────────────────────────────────

export type ThreadActionKind = "take" | "return" | "dismiss";

export interface ThreadActionPlan {
  /** The ONE possible action, as a button. */
  primary: { kind: ThreadActionKind; label: string; disabledReason: string | null } | null;
  /** Pending only: hand it back to the bot without taking it (the old "Bot" segment). */
  secondary: { kind: "dismiss"; label: string } | null;
}

/**
 * Mirrors the server actions' rules (they re-check everything):
 *   bot / pending → anyone with access may TAKE it;
 *   pending       → anyone may also hand it back to the bot (dismiss);
 *   human         → the assigned person or an owner/admin may RETURN it; nobody can take
 *                   it from a colleague (the server refuses), so that is never offered.
 */
export function threadActionPlan(input: {
  mode: InboxMode;
  assignedUserId: string | null;
  assignedName: string | null;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
}): ThreadActionPlan {
  if (input.mode === "bot") return { primary: { kind: "take", label: "Tomar conversación", disabledReason: null }, secondary: null };
  if (input.mode === "pending") {
    return {
      primary: { kind: "take", label: "Tomar conversación", disabledReason: null },
      secondary: { kind: "dismiss", label: "Devolver al bot" },
    };
  }
  const mine = input.assignedUserId !== null && input.assignedUserId === input.viewerUserId;
  if (mine || input.viewerIsFullAccess) return { primary: { kind: "return", label: "Devolver al bot", disabledReason: null }, secondary: null };
  const who = firstName(input.assignedName) ?? "Otra persona";
  return {
    primary: { kind: "return", label: "Devolver al bot", disabledReason: `${who} está respondiendo. Solo esa persona o un administrador puede devolverla al bot.` },
    secondary: null,
  };
}

/** The confirmation copy — what will happen, in plain words. */
export function confirmCopy(kind: ThreadActionKind, customer: string, assignedName: string | null, viewerIsAssigned: boolean): { title: string; body: string; confirm: string } {
  if (kind === "take") {
    return {
      title: "¿Tomar esta conversación?",
      body: `El bot dejará de responder a ${customer}. Escribirás tú hasta que la devuelvas al bot.`,
      confirm: "Tomar conversación",
    };
  }
  if (kind === "dismiss") {
    return {
      title: "¿Devolver al bot sin tomarla?",
      body: `El bot seguirá respondiendo a ${customer} y la conversación saldrá de «Necesitan una persona».`,
      confirm: "Devolver al bot",
    };
  }
  const who = viewerIsAssigned ? "Tú dejarás de atenderla." : `${firstName(assignedName) ?? "La persona asignada"} dejará de atenderla.`;
  return { title: "¿Devolver al bot?", body: `El bot volverá a responder a ${customer}. ${who}`, confirm: "Devolver al bot" };
}
