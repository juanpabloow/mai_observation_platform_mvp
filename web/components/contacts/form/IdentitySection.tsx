"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { lookupIdentityAction, type IdentityMatchView } from "@/lib/contactActions";
import {
  COPY,
  matchHeading,
  normalizeIdentity,
  relativeAge,
  type IdentityKindLite,
} from "@/lib/contactForm";
import { stageLabel } from "@/lib/contactLabels";
import { Avatar, Field, IconMail, IconPhone, TextInput, INPUT_CLS } from "./formPrimitives";

/**
 * IDENTITY — name (optional), N phones, N emails, and the inline duplicate check.
 *
 * THE RULE this section exists to express: at least one of phone or email; neither is
 * required on its own and the name is not required at all, because a great many leads
 * arrive as nothing but a number. The blocking message lives at the bottom of the
 * section rather than under a field, since neither field is individually at fault.
 *
 * THE DUPLICATE CHECK NEVER BLOCKS. It is a warning with a way forward ("Abrir contacto"
 * / "Continuar de todos modos"), never an error, because the operator in front of the
 * customer knows things the database doesn't. Phone and email are checked
 * INDEPENDENTLY and can sit in different states at once — one confirmed free while the
 * other is still resolving.
 */

type CheckState =
  | { kind: "idle" }
  | { kind: "invalid" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "matches"; matches: IdentityMatchView[]; total: number };

/** Keystrokes settle before we ask the server. 350ms is long enough that typing a
 *  10-digit number is ONE query rather than ten, and short enough that the answer is
 *  there before the operator has moved to the next field. */
const DEBOUNCE_MS = 350;

/** What the server last told us, and about WHICH normalized value. Keyed by value so a
 *  stale answer can be recognised as stale during render instead of being stored as if
 *  it described the current input. */
type RemoteAnswer = { value: string; state: CheckState };

/**
 * One debounced, race-safe check per field.
 *
 * Only the ASYNC half lives in an effect. idle/invalid/checking are pure functions of
 * what is currently typed, so they are derived during render — setting them from an
 * effect would be a cascading render, and would also let the panel briefly describe the
 * previous value.
 *
 * The staleness guard is doubled on purpose: the token ref drops an in-flight response
 * whose input has since changed, and the render-time `answer.value === normalized`
 * comparison means even a response that slips through describes the value it was asked
 * about or is ignored. Getting this wrong is how a duplicate panel ends up warning
 * about a number the operator can no longer see.
 */
function useIdentityCheck(
  clientId: string,
  kind: IdentityKindLite,
  raw: string,
  excludeContactId: string | null,
): CheckState {
  const [answer, setAnswer] = useState<RemoteAnswer | null>(null);
  const token = useRef(0);
  const typed = raw.trim();
  const normalized = normalizeIdentity(kind, raw);

  useEffect(() => {
    if (!normalized) return; // nothing meaningful to ask about
    const mine = ++token.current;
    const t = setTimeout(async () => {
      const r = await lookupIdentityAction(clientId, kind, normalized, excludeContactId);
      if (token.current !== mine) return; // a newer value won
      if (!r.ok) return; // leave it "checking" rather than claiming "no existe"
      setAnswer({
        value: normalized,
        state: r.total === 0 ? { kind: "none" } : { kind: "matches", matches: r.matches, total: r.total },
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [clientId, kind, normalized, excludeContactId]);

  if (!typed) return { kind: "idle" };
  // Not a usable value — mid-typing, or genuinely malformed. Either way, say so rather
  // than querying (and never claim the value is free).
  if (!normalized) return { kind: "invalid" };
  if (answer?.value === normalized) return answer.state;
  return { kind: "checking" };
}

function MatchCard({ clientId, match, now }: { clientId: string; match: IdentityMatchView; now: Date }) {
  const title = match.name?.trim() || match.matchedValue;
  const stage = stageLabel(match.stage);
  // The reference's second line: what we know about them, in the operator's terms —
  // "activa hace 3 días" for someone with history, "Sin nombre · creado hace 6 meses"
  // for a bare number.
  const sub = match.name?.trim()
    ? `${match.matchedValue} · ${stage.toLowerCase()} ${relativeAge(match.lastContactAt, now)}`
    : `Sin nombre · creado ${relativeAge(match.createdAt, now)}`;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2">
      <Avatar name={match.name} fallback={match.matchedValue} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <span className="truncate text-[11px] text-faint">{sub}</span>
      </span>
      <Link
        href={`/clients/${clientId}/contacts/${match.contactId}`}
        className="shrink-0 whitespace-nowrap rounded-md border border-line-strong px-2 py-1 text-xs text-foreground transition-colors hover:bg-subtle"
      >
        Abrir
      </Link>
    </div>
  );
}

/** The three states the reference draws under a field. Warning tone throughout — amber,
 *  never the danger red, because none of this stops the save. */
function CheckFeedback({
  clientId,
  state,
  kind,
  onContinue,
  dismissed,
  now,
}: {
  clientId: string;
  state: CheckState;
  kind: IdentityKindLite;
  onContinue: () => void;
  dismissed: boolean;
  now: Date;
}) {
  if (state.kind === "idle") return null;
  if (state.kind === "invalid") {
    return (
      <p className="mt-1 text-[11px] text-faint">{kind === "phone" ? COPY.invalidPhone : COPY.invalidEmail}</p>
    );
  }
  if (state.kind === "checking") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
        <span aria-hidden className="size-2.5 animate-spin rounded-full border border-line-strong border-t-transparent" />
        {COPY.checking}
      </p>
    );
  }
  if (state.kind === "none") {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-success">
        <span aria-hidden>✓</span>
        {COPY.noMatch}
      </p>
    );
  }
  if (dismissed) {
    return (
      <p className="mt-1 text-[11px] text-faint">
        {matchHeading(state.total, kind)} — continuarás de todos modos.
      </p>
    );
  }
  const hidden = state.total - state.matches.length;
  return (
    <div role="status" className="mt-1.5 rounded-lg border border-warn/35 bg-warn-soft p-2">
      <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-warn">
        <span aria-hidden>⚠</span>
        {matchHeading(state.total, kind)}
      </p>
      <div className="flex flex-col gap-1.5">
        {state.matches.map((m) => (
          <MatchCard key={m.contactId} clientId={clientId} match={m} now={now} />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 px-0.5">
        <span className="text-[11px] text-muted">
          {hidden > 0 ? (hidden === 1 ? "Hay 1 coincidencia más" : `Hay ${hidden} coincidencias más`) : ""}
        </span>
        <button
          type="button"
          onClick={onContinue}
          className="whitespace-nowrap text-[11px] font-medium text-warn transition-opacity hover:opacity-80"
        >
          {COPY.continueAnyway} →
        </button>
      </div>
    </div>
  );
}

/** One identity row: the input, its remove button, and its own check feedback. */
function IdentityRow({
  clientId,
  kind,
  value,
  onChange,
  onRemove,
  canRemove,
  excludeContactId,
  dismissedValues,
  onDismiss,
  now,
}: {
  clientId: string;
  kind: IdentityKindLite;
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
  canRemove: boolean;
  excludeContactId: string | null;
  dismissedValues: string[];
  onDismiss: (normalized: string) => void;
  now: Date;
}) {
  const state = useIdentityCheck(clientId, kind, value, excludeContactId);
  const normalized = normalizeIdentity(kind, value);
  const dismissed = normalized !== null && dismissedValues.includes(normalized);

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <TextInput
            value={value}
            onChange={onChange}
            placeholder={kind === "phone" ? "+57 300 000 0000" : "nombre@correo.com"}
            leading={kind === "phone" ? <IconPhone /> : <IconMail />}
            mono={kind === "phone"}
            inputMode={kind === "phone" ? "tel" : "email"}
            ariaLabel={kind === "phone" ? "Teléfono" : "Email"}
          />
        </div>
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={kind === "phone" ? "Quitar este teléfono" : "Quitar este email"}
            className="shrink-0 rounded-md border border-line px-2 py-2 text-sm leading-none text-faint transition-colors hover:border-line-strong hover:text-foreground"
          >
            ×
          </button>
        ) : null}
      </div>
      <CheckFeedback
        clientId={clientId}
        state={state}
        kind={kind}
        dismissed={dismissed}
        now={now}
        onContinue={() => normalized && onDismiss(normalized)}
      />
    </div>
  );
}

export function IdentitySection({
  clientId,
  name,
  onNameChange,
  phones,
  onPhonesChange,
  emails,
  onEmailsChange,
  excludeContactId = null,
  identityError,
}: {
  clientId: string;
  name: string;
  onNameChange: (v: string) => void;
  phones: string[];
  onPhonesChange: (v: string[]) => void;
  emails: string[];
  onEmailsChange: (v: string[]) => void;
  /** On EDIT, the contact being edited must not report itself as its own duplicate. */
  excludeContactId?: string | null;
  identityError: string | null;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const dismiss = useCallback((v: string) => setDismissed((d) => (d.includes(v) ? d : [...d, v])), []);
  // One clock for every relative age in the section, so two cards rendered in the same
  // pass can't disagree by a second.
  const now = useMemo(() => new Date(), []);

  const setAt = (list: string[], i: number, v: string) => list.map((x, k) => (k === i ? v : x));
  const removeAt = (list: string[], i: number) => list.filter((_, k) => k !== i);

  return (
    <div className="flex flex-col gap-3.5">
      <Field label="Nombre" hint="opcional" htmlFor="contact-name">
        <TextInput
          id="contact-name"
          value={name}
          onChange={onNameChange}
          placeholder="Agregar nombre…"
          leading={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
            </svg>
          }
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Teléfono</span>
        {phones.map((p, i) => (
          <IdentityRow
            key={`phone-${i}`}
            clientId={clientId}
            kind="phone"
            value={p}
            onChange={(v) => onPhonesChange(setAt(phones, i, v))}
            onRemove={() => onPhonesChange(removeAt(phones, i))}
            canRemove={phones.length > 1}
            excludeContactId={excludeContactId}
            dismissedValues={dismissed}
            onDismiss={dismiss}
            now={now}
          />
        ))}
        <button
          type="button"
          onClick={() => onPhonesChange([...phones, ""])}
          className="w-fit whitespace-nowrap rounded-md px-1 py-0.5 text-xs text-muted transition-colors hover:text-foreground"
        >
          {COPY.addPhone}
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">Email</span>
        {emails.map((e, i) => (
          <IdentityRow
            key={`email-${i}`}
            clientId={clientId}
            kind="email"
            value={e}
            onChange={(v) => onEmailsChange(setAt(emails, i, v))}
            onRemove={() => onEmailsChange(removeAt(emails, i))}
            canRemove={emails.length > 1}
            excludeContactId={excludeContactId}
            dismissedValues={dismissed}
            onDismiss={dismiss}
            now={now}
          />
        ))}
        <button
          type="button"
          onClick={() => onEmailsChange([...emails, ""])}
          className="w-fit whitespace-nowrap rounded-md px-1 py-0.5 text-xs text-muted transition-colors hover:text-foreground"
        >
          {COPY.addEmail}
        </button>
      </div>

      {/* The rule, stated once for the pair. Turns into the blocking message only when
          both lists are empty — see checkIdentity. */}
      <p className={`text-[11px] ${identityError ? "font-medium text-danger" : "text-faint"}`}>
        {identityError ?? COPY.identityHint}
      </p>
    </div>
  );
}

export { INPUT_CLS };
