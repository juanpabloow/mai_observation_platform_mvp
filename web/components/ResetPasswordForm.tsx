"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { mapAuthErrorParam, mapClientAuthError } from "@/lib/auth-errors";
import { ACC, Notice } from "@/components/access/AccessShell";
import { PasswordField } from "@/components/access/fields";

/**
 * Consumes the password-reset token minted by Better Auth. The user arrives
 * here via GET /api/auth/reset-password/:token, which validates the token and
 * redirects to this page with ?token=… (or ?error=INVALID_TOKEN). Submitting
 * calls the official resetPassword endpoint: the token is single-use, the old
 * password is replaced, and every existing session is revoked
 * (revokeSessionsOnPasswordReset) — then we send the user to /login to sign
 * in with the new password. One field with «Mostrar» (no "repeat password"), like the
 * profile screens.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const urlErrorMessage = mapAuthErrorParam(searchParams.get("error"));
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token === null || urlErrorMessage) {
    return (
      <div className="flex flex-col gap-4">
        <Notice tone="warn">{urlErrorMessage ?? "Este enlace no es válido o está incompleto."}</Notice>
        <Link href="/forgot-password" className={`${ACC.secondary} lg:w-auto lg:self-start`}>
          Pedir un enlace nuevo
        </Link>
      </div>
    );
  }

  const resetToken: string = token;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (password.length < 8) {
      setError("Usa al menos 8 caracteres.");
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token: resetToken });
      if (result.error) {
        setError(mapClientAuthError(result.error.code, "No pudimos cambiar la contraseña. Inténtalo otra vez."));
        return;
      }
      router.push("/login?reset=1");
    } catch {
      setError("No pudimos cambiar la contraseña. Inténtalo otra vez.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <PasswordField
        label="Contraseña nueva"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        invalid={Boolean(error)}
        hint={password.length >= 8 ? "✓ Contraseña válida" : "Mínimo 8 caracteres."}
        hintTone={password.length >= 8 ? "success" : "muted"}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <button type="submit" aria-busy={busy || undefined} className={ACC.primary}>
        {busy ? "Guardando…" : "Guardar contraseña"}
      </button>
    </form>
  );
}
