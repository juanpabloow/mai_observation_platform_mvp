"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import {
  EMAIL_NOT_VERIFIED_CODE,
  EMAIL_NOT_VERIFIED_NOTICE,
  GENERIC_SIGN_IN_FAILED,
  RATE_LIMITED_NOTICE,
  VERIFICATION_RESENT_NOTICE,
  mapClientAuthError,
} from "@/lib/auth-errors";
import { VERIFIED_LOGIN_CALLBACK } from "@/lib/auth-verification";
import { KEEP_SESSION_STATE_KEY } from "@/lib/authStateKeys";
import { SESSION_CHANNEL } from "@/lib/accessCopy";
import { ACC, Divider, Notice } from "./AccessShell";
import { GoogleButton, KeepSessionCheckbox, PasswordField, TextField } from "./fields";

/**
 * 4a/4b — sign in. Google first, email + password as the alternative, and «Mantener mi sesión
 * en este equipo» ABOVE both (it is a choice about the session, not about the method):
 * unchecked by default, sent as rememberMe for a password and carried inside Better Auth's
 * encrypted OAuth state for Google. The server decides the final policy (lib/auth.ts).
 *
 * Errors are allowlist-mapped (lib/auth-errors.ts) and never say whether an account exists;
 * the typed email survives an error, the password is never stored anywhere but this state.
 * After success a HARD navigation to the (already sanitized) destination drops any stale
 * client state, and other tabs are told a session started.
 */
export function LoginForm({
  googleEnabled,
  destination,
  initialEmail = "",
  emailLocked = false,
  showSignup = true,
}: {
  googleEnabled: boolean;
  /** Already sanitized server-side (lib/safeRedirect.ts). */
  destination: string;
  initialEmail?: string;
  /** Invitation path: the address is the invited one. */
  emailLocked?: boolean;
  showSignup?: boolean;
}) {
  const [keep, setKeep] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"mail" | "google" | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);
  const [resend, setResend] = useState<"idle" | "sending" | "sent">("idle");
  const [tried, setTried] = useState(false);

  const emailMissing = tried && !email.trim();
  const passwordMissing = tried && !password;

  function announceSignedIn() {
    try {
      const ch = new BroadcastChannel(SESSION_CHANNEL);
      ch.postMessage({ type: "signed-in" });
      ch.close();
    } catch {
      // BroadcastChannel unsupported: other tabs resync on focus.
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    setError(null);
    setUnverified(null);
    setResend("idle");
    if (!email.trim() || !password) return;
    setBusy("mail");
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password, rememberMe: keep });
      if (result.error) {
        if (result.error.code === EMAIL_NOT_VERIFIED_CODE) {
          setUnverified(email.trim());
        } else if (result.error.status === 429) {
          setError(RATE_LIMITED_NOTICE);
        } else {
          setError(mapClientAuthError(result.error.code, GENERIC_SIGN_IN_FAILED));
        }
        setBusy(null);
        return;
      }
      announceSignedIn();
      window.location.assign(destination);
    } catch {
      setError("No pudimos conectar. Revisa tu conexión e inténtalo otra vez.");
      setBusy(null);
    }
  }

  async function onGoogle() {
    if (!googleEnabled || busy) return;
    setError(null);
    setBusy("google");
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: destination,
        errorCallbackURL: `/login?redirect=${encodeURIComponent(destination)}`,
        additionalData: { [KEEP_SESSION_STATE_KEY]: keep },
        ...(emailLocked && email ? { loginHint: email } : {}),
      });
      if (result.error) {
        setError(mapClientAuthError(result.error.code, "No pudimos abrir Google. Inténtalo otra vez."));
        setBusy(null);
      }
      // Success = the browser is on its way to Google; stay busy against double clicks.
    } catch {
      setError("No pudimos abrir Google. Inténtalo otra vez.");
      setBusy(null);
    }
  }

  async function onResend() {
    if (!unverified || resend === "sending") return;
    setResend("sending");
    try {
      await authClient.sendVerificationEmail({ email: unverified, callbackURL: VERIFIED_LOGIN_CALLBACK });
    } catch {
      // The public answer is generic either way.
    } finally {
      setResend("sent");
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4" aria-describedby={error ? "login-error" : undefined}>
      <KeepSessionCheckbox checked={keep} onChange={setKeep} />
      <GoogleButton onClick={onGoogle} disabled={!googleEnabled || busy === "mail"} busy={busy === "google"} />
      {!googleEnabled ? <p className={`${ACC.hint} -mt-2`}>El acceso con Google no está configurado en este entorno.</p> : null}
      <Divider>o con tu correo</Divider>
      {emailLocked ? (
        <div className="flex flex-col gap-1.5">
          <span className={ACC.label}>Correo</span>
          <input type="email" name="email" value={email} readOnly autoComplete="username" className={`${ACC.input} bg-[#F5F5F7] text-[#3A3A3C]`} aria-label="Correo" />
        </div>
      ) : (
        <TextField
          label="Correo"
          type="email"
          name="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          inputMode="email"
          error={emailMissing ? "Escribe tu correo." : null}
        />
      )}
      <PasswordField
        label="Contraseña"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        invalid={passwordMissing}
        hint={passwordMissing ? "Escribe tu contraseña." : undefined}
        hintTone="error"
        labelExtra={
          <Link href="/forgot-password" className={`${ACC.link} text-[13px]`}>
            ¿La olvidaste?
          </Link>
        }
      />
      {error ? (
        <div id="login-error">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
      {unverified ? (
        <Notice tone="warn">
          <span className="flex flex-col gap-2">
            <span>{EMAIL_NOT_VERIFIED_NOTICE}</span>
            {resend === "sent" ? (
              <span className="text-[13px]">{VERIFICATION_RESENT_NOTICE}</span>
            ) : (
              <button type="button" onClick={onResend} disabled={resend === "sending"} className={`${ACC.link} self-start text-[13px]`}>
                {resend === "sending" ? "Enviando…" : "Enviar el enlace otra vez"}
              </button>
            )}
          </span>
        </Notice>
      ) : null}
      <button type="submit" className={ACC.primary} aria-busy={busy === "mail" || undefined} disabled={busy === "google"}>
        {busy === "mail" ? "Entrando…" : "Entrar"}
      </button>
      {showSignup ? (
        <p className="m-0 text-center text-[13px] leading-normal text-[#6E6E73]">
          <span className="hidden lg:inline">¿Vas a registrar un negocio nuevo? </span>
          <span className="lg:hidden">¿Negocio nuevo? </span>
          <Link href="/signup" className={ACC.link}>
            Crear cuenta de negocio
          </Link>
        </p>
      ) : null}
    </form>
  );
}
