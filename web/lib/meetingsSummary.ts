/**
 * The ADAPTIVE content model for the Resumen view.
 *
 * ── Why this shape (third iteration) ──────────────────────────────────────
 *
 * v1 declared `decisions` and `risks` as fixed fields, so the screen had the
 * shape of a project kickoff and an interview rendered two empty headings.
 *
 * v2 replaced that with `findingGroups[]` composed into columns by item count.
 * That fixed the rigidity but kept a subtler problem: the layout was still
 * organised BY CATEGORY. "Decisiones" got a column because it was a category
 * with things in it, not because those things were the most important thing in
 * the meeting — and two comparable categories were forced side by side even
 * when one of them held the only fact that mattered.
 *
 * v3 (this one) organises EDITORIALLY, which is how a person reads a recap:
 *
 *   findings[]     ONE flat, RANKED list. The kind (decision / problem /
 *                  objection / …) is a property of the ITEM, not a container.
 *                  Index 0 is the most important thing that happened.
 *   highlights[]   2–4 facts, shown as "En una mirada".
 *   nextSteps[]    full-width table underneath.
 *
 * The view then splits `findings` by ROLE, not by category:
 *   · the LEAD column gets the ranked narrative items;
 *   · the ATTENTION card gets only exceptions — things that need a human.
 * See `composeSummary`.
 */

/* ── Datos destacados ("En una mirada") ───────────────────────────────────── */

/**
 * Semantic tone for a highlight's value. Red is reserved for genuinely critical
 * facts; amber for risk or pending; green for resolved; neutral/info for plain
 * information. A tone is OPTIONAL — most highlights are just text and should
 * not be dressed as a status.
 */
export type HighlightTone = "neutral" | "info" | "warn" | "danger" | "success";

/** Where a highlight leads when clicked. A datum with a destination is a link. */
export type HighlightTarget =
  | { kind: "transcript"; at: number }
  | { kind: "finding"; id: string }
  | { kind: "step"; id: string };

export interface Highlight {
  /**
   * The field NAME, picked for this meeting: "Necesidad", "Diagnóstico", "Rol",
   * "Tema central"… No enum on purpose — constraining it to a list is how the
   * strip became four fixed columns in the first place.
   */
  label: string;
  value: string;
  /** Present only when the value really is a status. */
  tone?: HighlightTone;
  target?: HighlightTarget;
}

/* ── Temas ────────────────────────────────────────────────────────────────── */

export interface Theme {
  label: string;
  /** Human range, e.g. "11:42–12:00". */
  range: string;
  /** Seconds to seek to — the chip navigates to the transcript. */
  at: number;
}

/* ── Hallazgos ────────────────────────────────────────────────────────────── */

/**
 * What KIND of thing a finding is. A label on the ITEM, not a section: a
 * meeting's most important finding might be a problem, an objection or a
 * conclusion, and none of those should wait for its category to earn a column.
 */
export type FindingKind =
  | "decision"
  | "agreement"
  | "conclusion"
  | "risk"
  | "dependency"
  | "question"
  | "objection"
  | "problem"
  | "need"
  | "idea"
  | "feedback"
  | "recommendation";

/** Severity. Only some kinds carry one (a risk does, an idea does not). */
export type FindingLevel = "critical" | "warning" | "info";

/** Where a finding is corroborated, beyond the transcript itself. */
export type FindingSource = "transcript" | "email" | "task" | "contact" | "appointment" | "document";

export const SOURCE_LABEL: Record<FindingSource, string> = {
  transcript: "Transcript",
  email: "Correo",
  task: "Tarea",
  contact: "Contacto",
  appointment: "Cita",
  document: "Documento",
};

export interface Finding {
  id: string;
  kind: FindingKind;
  /** ONE line: what this finding is. The headline a person scans. */
  title: string;
  /** One or two lines of context. Optional — some findings are self-evident. */
  detail?: string;
  level?: FindingLevel;
  /** Who said it, so the finding is attributable. */
  by: string;
  initials: string;
  stamp: string;
  at: number;
  /**
   * How sure the analysis is, 0–100. OPTIONAL and deliberately rare: a number
   * on every line trains people to ignore it. Present when it is low enough to
   * change what a person would do.
   */
  confidence?: number;
  /** Corroboration chips. `transcript` is implicit and always rendered first. */
  sources?: FindingSource[];
  /** Contextual actions, first one primary. Labels only — no behaviour yet. */
  actions?: { label: string; primary?: boolean }[];
  /**
   * Forces this finding into the ATTENTION card even when its kind would
   * normally be narrative — e.g. two sources the analysis could not reconcile.
   */
  needsPerson?: boolean;
}

/** Label per kind, so a finding is never identified by colour alone. */
export const FINDING_KIND: Record<FindingKind, { label: string; singular: string }> = {
  decision: { label: "Decisiones", singular: "Decisión" },
  agreement: { label: "Acuerdos", singular: "Acuerdo" },
  conclusion: { label: "Conclusiones", singular: "Conclusión" },
  risk: { label: "Riesgos", singular: "Riesgo" },
  dependency: { label: "Dependencias", singular: "Dependencia" },
  question: { label: "Preguntas abiertas", singular: "Pregunta abierta" },
  objection: { label: "Objeciones", singular: "Objeción" },
  problem: { label: "Problemas detectados", singular: "Problema" },
  need: { label: "Necesidades", singular: "Necesidad" },
  idea: { label: "Ideas", singular: "Idea" },
  feedback: { label: "Feedback", singular: "Feedback" },
  recommendation: { label: "Recomendaciones", singular: "Recomendación" },
};

/**
 * Kinds that are EXCEPTIONS: they describe something unresolved rather than
 * something that happened, so they belong in the attention card.
 *
 * `objection` is deliberately NOT here. An objection in a sales call is the
 * substance of the meeting, not an anomaly — it belongs in the narrative.
 */
const EXCEPTION_KINDS = new Set<FindingKind>(["risk", "question", "dependency"]);

export function isException(f: Finding): boolean {
  return Boolean(f.needsPerson) || EXCEPTION_KINDS.has(f.kind);
}

/* ── Próximos pasos ───────────────────────────────────────────────────────── */

/**
 * A due date, with its urgency as DATA rather than a string the view has to
 * interpret. v1 stored `due: "hoy"` and the view painted "hoy" red, which is
 * wrong: today is not late. Only `overdue` is red.
 */
export interface StepDue {
  label: string;
  state: "overdue" | "soon" | "scheduled" | "none";
}

export interface NextStep {
  id: string;
  text: string;
  owner: string | null;
  ownerInitials: string | null;
  /** null when the meeting produced a commitment with no date at all. */
  due: StepDue | null;
  evidence: { initials: string; stamp: string; at: number };
  /** `blocked` = the viewer's role cannot create CRM tasks. */
  state: "todo" | "created" | "blocked";
}

/* ── The summary as a whole ───────────────────────────────────────────────── */

export interface MeetingSummary {
  /** 3–4 lines, factual. Empty string when the analysis produced none. */
  executive: string;
  /** 2–4 entries for "En una mirada". Never padded to fill. */
  highlights: Highlight[];
  /** Empty when no reliable themes were detected — the section then hides. */
  themes: Theme[];
  /**
   * ONE ranked list. Order IS importance: index 0 is the most important thing
   * that happened in this meeting, whatever kind of thing it is.
   */
  findings: Finding[];
  /** Empty when the meeting produced no reliable follow-up. */
  nextSteps: NextStep[];
  /**
   * Short statements about what the analysis did NOT find, when the absence is
   * worth saying ("No se tomó una decisión de compra"). Quiet lines under the
   * narrative, never an empty section.
   */
  absences?: string[];
  /**
   * What the analysis deliberately withheld. Lives in the Inspector, beside the
   * rest of the analysis metadata — not in the summary body.
   */
  caveat?: string;
}

/** How many pending steps the bulk CTA would actually create. */
export function pendingStepCount(steps: NextStep[]): number {
  return steps.filter((s) => s.state === "todo").length;
}

/* ── Composición ──────────────────────────────────────────────────────────── */

/** One line in the attention card. */
export interface AttentionItem {
  id: string;
  title: string;
  note: string;
  tone: "danger" | "warn" | "neutral";
  target: HighlightTarget;
}

export interface SummaryComposition {
  /** Left column, in rank order. */
  lead: Finding[];
  /** Right column, exceptions only. Empty → the card is hidden. */
  attention: AttentionItem[];
  /** Right column, bottom card. */
  glance: Highlight[];
  /** True when there is nothing at all to show. */
  isEmpty: boolean;
}

/** How many narrative findings the lead column shows before "Ver todos". */
export const LEAD_LIMIT = 5;

/**
 * Split the summary by ROLE.
 *
 * The lead column keeps the ranked narrative; the attention card collects only
 * what needs a person. Crucially, "needs a person" is not only a category — an
 * unassigned commitment is an exception too, and it lives in `nextSteps`, so it
 * is DERIVED here rather than duplicated into the findings by whoever writes
 * the data.
 */
export function composeSummary(s: MeetingSummary): SummaryComposition {
  const lead = s.findings.filter((f) => !isException(f));
  const exceptions = s.findings.filter(isException);

  const attention: AttentionItem[] = exceptions.map((f) => ({
    id: f.id,
    title: f.title,
    note: f.detail ? f.detail.split(". ")[0] : FINDING_KIND[f.kind].singular + " · " + f.stamp,
    tone: f.level === "critical" ? "danger" : f.level === "warning" || f.kind === "dependency" ? "warn" : "neutral",
    target: { kind: "finding", id: f.id },
  }));

  // Commitments with nobody on them are the classic thing that quietly rots,
  // and they are invisible in a table of five rows.
  for (const step of s.nextSteps) {
    if (step.owner) continue;
    attention.push({
      id: "att-step-" + step.id,
      title: "Compromiso sin responsable",
      note: step.text,
      tone: "warn",
      target: { kind: "step", id: step.id },
    });
  }

  const isEmpty =
    !s.executive && s.highlights.length === 0 && s.themes.length === 0 && s.findings.length === 0 && s.nextSteps.length === 0;

  return { lead, attention, glance: s.highlights, isEmpty };
}
