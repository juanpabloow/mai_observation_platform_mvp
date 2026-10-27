import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { isGoogleConfigured } from "@/lib/auth";
import { getServerSession } from "@/lib/session";
import { getSessionScope } from "@/lib/access";
import { EMAIL_VERIFIED_NOTICE, PASSWORD_RESET_DONE_NOTICE, mapAuthErrorParam } from "@/lib/auth-errors";
import { END_REASON_MESSAGE, parseEndReason } from "@/lib/accessCopy";
import { DEFAULT_AFTER_LOGIN, destinationLabel, safeInternalPath } from "@/lib/safeRedirect";
import { ACC, AccessHeading, AccessShell, Notice } from "@/components/access/AccessShell";
import { LoginForm } from "@/components/access/LoginForm";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * /login — 4a/4b, plus the states that land here:
 *   ?reason=idle|max|persist|ended  → 4e/4f «Tu sesión se cerró» + back to where you were;
 *   ?reason=revoked                 → 4i (closed from another session or by an admin);
 *   ?error=forbidden|no-tenant      → 4j «Esta cuenta no tiene acceso» (signed in, no access);
 *   ?error=<oauth code>             → the allowlisted message;
 *   ?verified=1 / ?reset=1          → the email-verification / password-reset outcome.
 * ?redirect is sanitized server-side (internal paths only). A visitor who is already signed
 * in AND has access goes straight to the destination.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const sp = await searchParams;
  const destination = safeInternalPath(first(sp.redirect));
  const reason = parseEndReason(first(sp.reason));
  const errorCode = first(sp.error);
  const session = await getServerSession();

  // 4j — signed in, but the account has no (valid) membership.
  if (session?.user && (errorCode === "forbidden" || errorCode === "no-tenant")) {
    return (
      <AccessShell>
        <AccessHeading
          title="Esta cuenta no tiene acceso"
          lead="Tu acceso fue retirado o la cuenta está desactivada. Pide a un administrador de tu negocio que lo revise."
        />
        <Link href="/logout?next=/login" className={`${ACC.secondary} lg:w-auto lg:self-start`}>
          Usar otra cuenta
        </Link>
      </AccessShell>
    );
  }
  if (session?.user && !errorCode && !reason) {
    const scope = await getSessionScope();
    if (scope) redirect(destination);
  }

  // 4i — the session was closed from another session / by an admin.
  if (reason === "revoked") {
    const again = destination !== DEFAULT_AFTER_LOGIN ? `/login?redirect=${encodeURIComponent(destination)}` : "/login";
    return (
      <AccessShell>
        <AccessHeading
          title="Tu sesión se cerró en este equipo"
          lead="Se cerró desde otra de tus sesiones o por un administrador. Si no fuiste tú, cambia tu contraseña después de entrar."
        />
        <Link href={again} className={`${ACC.primary} lg:w-auto lg:self-start lg:px-5`}>
          Iniciar sesión
        </Link>
      </AccessShell>
    );
  }

  const urlError = errorCode && errorCode !== "forbidden" && errorCode !== "no-tenant" ? mapAuthErrorParam(errorCode) : null;
  const success = urlError
    ? null
    : first(sp.reset) === "1"
      ? PASSWORD_RESET_DONE_NOTICE
      : first(sp.verified) === "1"
        ? EMAIL_VERIFIED_NOTICE
        : null;
  const where = destinationLabel(destination);
  const ended = reason && reason !== "signed-out" ? reason : null;

  return (
    <AccessShell width={ended ? 380 : 360}>
      {ended ? (
        <Notice tone="info" title="Tu sesión se cerró">
          {END_REASON_MESSAGE[ended]}
        </Notice>
      ) : null}
      {reason === "signed-out" ? <Notice tone="info">{END_REASON_MESSAGE["signed-out"]}</Notice> : null}
      <AccessHeading
        title={ended ? "Vuelve a entrar" : "Inicia sesión"}
        lead={
          ended ? (
            <>
              {where ? (
                <>
                  Te llevaremos de vuelta a <span className="text-[#111]">{where}</span>.{" "}
                </>
              ) : (
                "Te llevaremos de vuelta a donde estabas. "
              )}
              Los cambios que no guardaste no se conservan.
            </>
          ) : (
            "Entra con el correo con el que te invitaron."
          )
        }
      />
      {urlError ? <Notice tone="warn">{urlError}</Notice> : null}
      {success ? <Notice tone="success">{success}</Notice> : null}
      <LoginForm googleEnabled={isGoogleConfigured} destination={destination} initialEmail={first(sp.email) ?? ""} />
    </AccessShell>
  );
}
