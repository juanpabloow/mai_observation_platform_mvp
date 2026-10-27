"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { GENERIC_RESET_NOTICE, RATE_LIMITED_NOTICE } from "@/lib/auth-errors";
import { RESET_PASSWORD_PATH } from "@/lib/auth-verification";
import { ACC, Notice } from "@/components/access/AccessShell";
import { TextField } from "@/components/access/fields";

/**
 * Public "recover access" form. Better Auth's /request-password-reset answers
 * generically whether or not the account exists, and this component mirrors
 * that: every outcome except an explicit rate limit shows the same notice, so
 * the UI can't be used to enumerate accounts either.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: RESET_PASSWORD_PATH,
      });
      setNotice(result.error?.status === 429 ? RATE_LIMITED_NOTICE : GENERIC_RESET_NOTICE);
    } catch {
      setNotice(GENERIC_RESET_NOTICE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <TextField label="Correo" type="email" name="email" value={email} onChange={setEmail} autoComplete="username" inputMode="email" />
      <button type="submit" aria-busy={busy || undefined} className={ACC.primary}>
        {busy ? "Enviando…" : "Enviar enlace"}
      </button>
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      <p className="m-0 text-center text-[13px] text-[#6E6E73]">
        ¿La recordaste?{" "}
        <Link href="/login" className={ACC.link}>
          Volver a iniciar sesión
        </Link>
      </p>
    </form>
  );
}
