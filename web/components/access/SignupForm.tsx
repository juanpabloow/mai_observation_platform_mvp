"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { RATE_LIMITED_NOTICE, mapClientAuthError } from "@/lib/auth-errors";
import { VERIFIED_LOGIN_CALLBACK } from "@/lib/auth-verification";
import { normalizePersonName } from "@/lib/personName";
import { ACC, AccessHeading, Divider, Notice } from "./AccessShell";
import { GoogleButton, PasswordField, TextField } from "./fields";

/**
 * «Crear cuenta de negocio» — the open door for NEW businesses (the platform is not
 * invitation-only). Same Better Auth sign-up as before: the user-create hook provisions the
 * new workspace, and an email/password account must verify its email before it can sign in
 * (requireEmailVerification), so success ends on "check your inbox", not inside the app.
 * People who were INVITED use their invitation link instead (it joins the inviting business).
 */
export function SignupForm({ googleEnabled }: { googleEnabled: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"mail" | "google" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const nameCheck = normalizePersonName(name);
  const nameError = tried && !nameCheck.ok ? nameCheck.error : null;
  const emailError = tried && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "Escribe un correo válido." : null;
  const passError = tried && password.length < 8 ? "Usa al menos 8 caracteres." : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    setError(null);
    if (!nameCheck.ok || emailError || password.length < 8 || !email.trim()) return;
    setBusy("mail");
    try {
      const result = await authClient.signUp.email({
        name: nameCheck.name,
        email: email.trim(),
        password,
        callbackURL: VERIFIED_LOGIN_CALLBACK,
      });
      if (result.error) {
        setError(result.error.status === 429 ? RATE_LIMITED_NOTICE : mapClientAuthError(result.error.code, "No pudimos crear la cuenta. Inténtalo otra vez."));
        setBusy(null);
        return;
      }
      setSentTo(email.trim());
      setPassword("");
    } catch {
      setError("No pudimos conectar. Revisa tu conexión e inténtalo otra vez.");
    } finally {
      setBusy(null);
    }
  }

  async function onGoogle() {
    if (!googleEnabled || busy) return;
    setBusy("google");
    setError(null);
    try {
      const result = await authClient.signIn.social({ provider: "google", callbackURL: "/negocios", errorCallbackURL: "/signup" });
      if (result.error) {
        setError(mapClientAuthError(result.error.code, "No pudimos abrir Google. Inténtalo otra vez."));
        setBusy(null);
      }
    } catch {
      setError("No pudimos abrir Google. Inténtalo otra vez.");
      setBusy(null);
    }
  }

  if (sentTo) {
    return (
      <div role="status" className="flex flex-col gap-3.5">
        <AccessHeading
          title="Revisa tu correo"
          lead={
            <>
              Si podemos crear la cuenta, te llegará a <span className="text-[#111]">{sentTo}</span> un enlace para verificarla. Después
              inicia sesión.
            </>
          }
        />
        <Link href="/login" className={`${ACC.secondary} lg:w-auto lg:self-start`}>
          Ir a iniciar sesión
        </Link>
      </div>
    );
  }

  return (
    <>
      <AccessHeading title="Crea la cuenta de tu negocio" lead="Para negocios nuevos. Si te invitaron, usa el enlace de tu invitación." />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <GoogleButton onClick={onGoogle} disabled={!googleEnabled || busy === "mail"} busy={busy === "google"} />
        <Divider>o con tu correo</Divider>
        <TextField label="Tu nombre" value={name} onChange={setName} autoComplete="name" placeholder="Nombre y apellido" error={nameError} />
        <TextField label="Correo" type="email" value={email} onChange={setEmail} autoComplete="username" inputMode="email" error={emailError} />
        <PasswordField
          label="Contraseña"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          invalid={Boolean(passError)}
          hint={passError ?? (password.length >= 8 ? "✓ Contraseña válida" : "Mínimo 8 caracteres.")}
          hintTone={passError ? "error" : password.length >= 8 ? "success" : "muted"}
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button type="submit" className={ACC.primary} aria-busy={busy === "mail" || undefined} disabled={busy === "google"}>
          {busy === "mail" ? "Creando cuenta…" : "Crear cuenta"}
        </button>
        <p className="m-0 text-center text-[13px] text-[#6E6E73]">
          ¿Ya tienes cuenta?{" "}
          <Link href="/login" className={ACC.link}>
            Inicia sesión
          </Link>
        </p>
      </form>
    </>
  );
}
