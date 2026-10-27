"use client";

import { useId, useState, type ReactNode } from "react";
import { ACC, GoogleMark } from "./AccessShell";

/**
 * Password with «Mostrar / Ocultar». The toggle only flips the input type: the value, the
 * caret and the focus stay where they were (mousedown is prevented so the field keeps
 * focus), it is a real button reachable by keyboard (aria-pressed + aria-controls), and the
 * field keeps its name/autocomplete so password managers fill and save it.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  invalid,
  hint,
  hintTone = "muted",
  labelExtra,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  invalid?: boolean;
  hint?: ReactNode;
  hintTone?: "muted" | "error" | "success";
  labelExtra?: ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={ACC.label}>
          {label}
        </label>
        {labelExtra}
      </div>
      <div className="relative flex">
        <input
          id={id}
          name="password"
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={hint ? hintId : undefined}
          className={`${ACC.input} pr-[88px] lg:pr-[84px]`}
        />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-controls={id}
          aria-label={shown ? "Ocultar contraseña" : "Mostrar contraseña"}
          className="u-focus absolute right-0.5 top-0.5 h-11 min-w-11 rounded-[10px] px-3 text-sm text-[#3A3A3C] hover:bg-[#F2F2F4] lg:right-1 lg:top-1 lg:h-9 lg:rounded-lg lg:px-2.5 lg:text-[13px]"
        >
          {shown ? "Ocultar" : "Mostrar"}
        </button>
      </div>
      {hint ? (
        <span
          id={hintId}
          className={hintTone === "error" ? ACC.error : hintTone === "success" ? "text-[13px] text-[#1E7A44]" : ACC.hint}
          role={hintTone === "error" ? "alert" : undefined}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** «Mantener mi sesión en este equipo» — unchecked by default; the whole row is the target. */
export function KeepSessionCheckbox({ checked, onChange, device = "computador" }: { checked: boolean; onChange: (v: boolean) => void; device?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-12 cursor-pointer items-start gap-3 lg:min-h-11 lg:gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={`${id}-d`}
        className="u-focus mt-px size-[22px] flex-none cursor-pointer accent-[#111] lg:size-[18px]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-base text-[#111] lg:text-sm">Mantener mi sesión en este equipo</span>
        <span id={`${id}-d`} className="text-[13px] leading-[1.4] text-[#6E6E73]">
          <span className="lg:hidden">No lo selecciones si otras personas usan este teléfono.</span>
          <span className="hidden lg:inline">No lo selecciones si otras personas usan este {device}.</span>
        </span>
      </span>
    </label>
  );
}

export function GoogleButton({
  onClick,
  disabled,
  busy,
  label = "Continuar con Google",
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} className={ACC.secondary}>
      <GoogleMark />
      {busy ? "Abriendo Google…" : label}
    </button>
  );
}

/** A labelled text field (label stays visible, error/hint announced). */
export function TextField({
  label,
  labelAside,
  value,
  onChange,
  error,
  hint,
  type = "text",
  autoComplete,
  inputMode,
  placeholder,
  autoFocus,
  name,
}: {
  label: string;
  labelAside?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: ReactNode;
  type?: "text" | "email";
  autoComplete?: string;
  inputMode?: "email" | "text";
  placeholder?: string;
  autoFocus?: boolean;
  name?: string;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={ACC.label}>
          {label}
        </label>
        {labelAside ? <span className="text-[13px] text-[#6E6E73]">{labelAside}</span> : null}
      </div>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoCapitalize={type === "email" ? "none" : undefined}
        spellCheck={type === "email" ? false : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? msgId : undefined}
        className={ACC.input}
      />
      {error ? (
        <span id={msgId} role="alert" className={ACC.error}>
          {error}
        </span>
      ) : hint ? (
        <span id={msgId} className={ACC.hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** The email fixed by an invitation — a read-only input (password managers still see it). */
export function FixedEmail({ email, note = "De la invitación" }: { email: string; note?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={ACC.label}>
        Correo
      </label>
      <div className={ACC.fixed}>
        <input
          id={id}
          type="email"
          name="email"
          value={email}
          readOnly
          autoComplete="username"
          aria-describedby={`${id}-n`}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-base text-[#3A3A3C] outline-none"
        />
        <span id={`${id}-n`} className="hidden flex-none text-xs text-[#6E6E73] sm:inline">
          {note}
        </span>
      </div>
    </div>
  );
}
