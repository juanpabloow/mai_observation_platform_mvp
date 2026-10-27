"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { mapClientAuthError } from "@/lib/auth-errors";
import { normalizePersonName } from "@/lib/personName";
import type { CountryOption } from "@/lib/phone";
import { acceptInvitationAction, createProfileFromInvitationAction } from "@/lib/inviteActions";
import { completeProfileAction, updateMyNameAction } from "@/lib/accountActions";
import { ACC, AccessHeading, AccessShell, Divider, Notice } from "./AccessShell";
import { FixedEmail, GoogleButton, PasswordField, TextField } from "./fields";
import { Avatar, PHONE_HINT, PHOTO_HINT, PhoneField, PhotoControl, type AvatarState } from "./ProfileFields";

/**
 * 5a/5b — create and complete the profile from an invitation.
 *
 *   create    Google («Usaremos tu nombre y foto de Google»), or a name + a password. The
 *             email is the invitation's, fixed. The password path is ONE server action
 *             (createProfileFromInvitationAction) that also accepts and signs in.
 *   join      back from Google: accept the invitation (server re-checks everything).
 *   complete  optional phone + photo. «Ahora no» continues without saving anything more.
 *   done      «Todo listo» → into the business.
 *
 * Business, access and inviter are READ-ONLY (left panel / top band), from the server row.
 * Nothing here can pick a business or a role.
 */
export interface InviteFacts {
  token: string;
  email: string;
  business: string;
  access: string;
  inviter: string | null;
}

type Step = "create" | "join" | "complete" | "done";

export function InviteProfileFlow({
  invite,
  googleEnabled,
  initialStep,
  user,
  countries,
  defaultCountry,
}: {
  invite: InviteFacts;
  googleEnabled: boolean;
  initialStep: "create" | "join" | "complete";
  /** Present once signed in (join/complete). */
  user: { id: string; name: string; providerImage: string | null; uploaded: string | null; via: "google" | "password" } | null;
  countries: { priority: CountryOption[]; rest: CountryOption[] };
  defaultCountry: string;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [via, setVia] = useState<"google" | "password">(user?.via ?? "password");
  const [name, setName] = useState(user?.name ?? "");
  const [password, setPassword] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"create" | "google" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [country, setCountry] = useState(defaultCountry);
  const [national, setNational] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarState>({
    userId: user?.id ?? "",
    name: user?.name ?? "",
    uploaded: user?.uploaded ?? null,
    providerImage: user?.providerImage ?? null,
  });
  const headingRef = useRef<HTMLDivElement>(null);

  // Move focus to the new step's heading so screen readers and keyboards follow along
  // (not on the first render: the page load already starts at the top).
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    headingRef.current?.querySelector("h1")?.focus();
  }, [step]);

  // join: accept once, on arrival from Google.
  const joined = useRef(false);
  useEffect(() => {
    if (step !== "join" || joined.current) return;
    joined.current = true;
    acceptInvitationAction(invite.token)
      .then((r) => {
        if (r.ok) setStep("complete");
        else setJoinError(r.error ?? "No pudimos aceptar la invitación.");
      })
      .catch(() => setJoinError("No pudimos aceptar la invitación. Inténtalo otra vez."));
  }, [step, invite.token]);

  const nameCheck = normalizePersonName(name);
  const nameError = tried && !nameCheck.ok ? nameCheck.error : null;
  const passOk = password.length >= 8 && password.length <= 128;
  const passError = tried && !passOk ? (password.length > 128 ? "Usa como máximo 128 caracteres." : "Usa al menos 8 caracteres.") : null;
  const acceptPath = `/invite/accept?token=${encodeURIComponent(invite.token)}`;

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    setError(null);
    if (!nameCheck.ok || !passOk) return;
    setBusy("create");
    try {
      const r = await createProfileFromInvitationAction({ token: invite.token, name: nameCheck.name, password });
      if (!r.ok) {
        if (r.code === "exists" || r.code === "invalid") {
          // The page knows the right state now (sign in to accept / link no longer valid).
          window.location.assign(acceptPath);
          return;
        }
        setError(r.error);
        setBusy(null);
        return;
      }
      // Same sign-in as /login (session policy + cookie set by Better Auth's endpoint).
      const signed = await authClient.signIn.email({ email: r.email, password, rememberMe: false });
      setPassword("");
      if (signed.error || !signed.data?.user) {
        setError("Tu perfil se creó, pero no pudimos iniciar la sesión. Entra con tu correo y contraseña.");
        setBusy(null);
        return;
      }
      setVia("password");
      setAvatar((a) => ({ ...a, name: nameCheck.name, userId: signed.data.user.id }));
      setBusy(null);
      setStep("complete");
    } catch {
      setError("No pudimos conectar. Revisa tu conexión e inténtalo otra vez.");
      setBusy(null);
    }
  }

  async function onGoogle() {
    if (!googleEnabled || busy) return;
    setBusy("google");
    setError(null);
    try {
      const r = await authClient.signIn.social({
        provider: "google",
        callbackURL: `${acceptPath}&step=join`,
        errorCallbackURL: acceptPath,
        loginHint: invite.email,
      });
      if (r.error) {
        setError(mapClientAuthError(r.error.code, "No pudimos abrir Google. Inténtalo otra vez."));
        setBusy(null);
      }
    } catch {
      setError("No pudimos abrir Google. Inténtalo otra vez.");
      setBusy(null);
    }
  }

  async function finish(skip: boolean) {
    if (busy) return;
    setPhoneError(null);
    setError(null);
    setBusy("save");
    try {
      // A Google profile without a name asks for it here (only what is missing).
      if (!skip && !user?.name && via === "google") {
        if (!nameCheck.ok) {
          setTried(true);
          setBusy(null);
          return;
        }
        const n = await updateMyNameAction(nameCheck.name);
        if (!n.ok) {
          setError(n.error);
          setBusy(null);
          return;
        }
      }
      const r = await completeProfileAction({ country, national: skip ? "" : national, skip });
      if (!r.ok) {
        if (r.field === "phone") setPhoneError(r.error);
        else setError(r.error);
        setBusy(null);
        return;
      }
      setSkipped(skip);
      setBusy(null);
      setStep("done");
    } catch {
      setError("No pudimos guardar. Tus datos siguen aquí; inténtalo otra vez.");
      setBusy(null);
    }
  }

  const stepIdx = step === "create" ? 1 : 2;
  const shownName = (avatar.name || name || "").trim();
  const first = shownName.split(/\s+/)[0] || "";

  const aside = (
    <>
      <h2 className="m-0 text-[34px] font-semibold leading-[1.15] tracking-[-.02em] text-[#ECECEE] [text-wrap:pretty]">
        Te invitaron a {invite.business}.
      </h2>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-[#80808A]">Datos del negocio · los gestiona tu administrador</span>
        <dl className="m-0 flex flex-col">
          {[
            ["Negocio", invite.business],
            ["Acceso", invite.access],
            ...(invite.inviter ? [["Invitado por", invite.inviter] as const] : []),
          ].map(([k, v], i, arr) => (
            <div
              key={k}
              className={`flex h-10 items-center justify-between gap-4 border-t border-[#2A2C31] text-sm ${i === arr.length - 1 ? "border-b" : ""}`}
            >
              <dt className="text-[#80808A]">{k}</dt>
              <dd className="m-0 truncate text-[#ECECEE]">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ol className="m-0 flex list-none gap-4 p-0 text-[13px]" aria-label={`Paso ${stepIdx} de 2`}>
        <li className={stepIdx === 1 ? "text-[#ECECEE]" : "text-[#80808A]"} aria-current={stepIdx === 1 ? "step" : undefined}>
          1 · Crear perfil
        </li>
        <li className={stepIdx === 2 ? "text-[#ECECEE]" : "text-[#80808A]"} aria-current={stepIdx === 2 ? "step" : undefined}>
          2 · Completar (opcional)
        </li>
      </ol>
    </>
  );
  const mobileTop = (
    <>
      <span className="text-sm text-[#A6A6AE]">
        {invite.business} · {invite.access}
      </span>
      <div className="flex gap-1.5" role="img" aria-label={`Paso ${stepIdx} de 2`}>
        <span className="h-[3px] flex-1 rounded-sm bg-[#ECECEE]" />
        <span className={`h-[3px] flex-1 rounded-sm ${stepIdx === 2 ? "bg-[#ECECEE]" : "bg-[#3A3C42]"}`} />
      </div>
    </>
  );

  return (
    <AccessShell aside={aside} mobileTop={mobileTop} width={step === "complete" ? 420 : 380}>
      <div ref={headingRef} className="contents">
        {step === "create" ? (
          <>
            <AccessHeading title="Crea tu perfil" lead="Elige cómo vas a entrar." />
            <form onSubmit={onCreate} noValidate className="flex flex-col gap-4">
              <GoogleButton onClick={onGoogle} disabled={!googleEnabled || busy === "create"} busy={busy === "google"} />
              <span className={`${ACC.hint} -mt-1.5`}>
                {googleEnabled
                  ? `Usaremos tu nombre y foto de Google. La cuenta de Google debe ser ${invite.email}.`
                  : "El acceso con Google no está configurado en este entorno."}
              </span>
              <Divider>o crea una contraseña</Divider>
              <FixedEmail email={invite.email} />
              <TextField
                label="Nombre completo"
                value={name}
                onChange={setName}
                autoComplete="name"
                placeholder="Nombre y apellido"
                error={nameError}
              />
              <PasswordField
                label="Contraseña"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                invalid={Boolean(passError)}
                hint={passError ?? (passOk ? "✓ Contraseña válida" : "Mínimo 8 caracteres.")}
                hintTone={passError ? "error" : passOk ? "success" : "muted"}
              />
              {error ? <Notice tone="error">{error}</Notice> : null}
              <button type="submit" className={ACC.primary} aria-busy={busy === "create" || undefined} disabled={busy === "google"}>
                {busy === "create" ? "Creando perfil…" : "Crear perfil"}
              </button>
            </form>
          </>
        ) : null}

        {step === "join" ? (
          joinError ? (
            <>
              <AccessHeading title="No pudimos aceptar la invitación" lead={joinError} />
              <a href="/logout?next=/login" className={`${ACC.secondary} lg:w-auto lg:self-start`}>
                Usar otra cuenta
              </a>
            </>
          ) : (
            <div role="status" className="flex flex-col gap-2">
              <AccessHeading title="Uniéndote a tu equipo…" lead={`Estamos activando tu acceso a ${invite.business}.`} />
            </div>
          )
        ) : null}

        {step === "complete" ? (
          <div className="flex flex-col gap-[18px]">
            <AccessHeading
              eyebrow={<span className="text-[13px] text-[#1E7A44]">✓ Perfil creado</span>}
              title="Completa tu perfil"
              lead="Opcional. Puedes hacerlo después desde tu cuenta."
            />
            <div className="flex items-center gap-3.5 border-y border-[#ECECEE] py-3.5">
              <Avatar state={{ ...avatar, name: shownName }} look="access" size={56} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-base text-[#111]">{shownName || "Sin nombre"}</span>
                <span className="truncate text-[13px] text-[#6E6E73]">
                  {invite.email} · {via === "google" ? "Entra con Google" : "Entra con contraseña"}
                </span>
              </span>
            </div>
            {!user?.name && via === "google" ? (
              <TextField label="Nombre completo" value={name} onChange={setName} autoComplete="name" error={nameError} />
            ) : null}
            <PhotoControl look="access" state={{ ...avatar, name: shownName }} onChange={setAvatar} hint={PHOTO_HINT} />
            <PhoneField
              look="access"
              countries={countries}
              country={country}
              onCountry={(c) => {
                setCountry(c);
                setPhoneError(null);
              }}
              national={national}
              onNational={setNational}
              error={phoneError}
              hint={PHONE_HINT}
            />
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-col-reverse gap-2 pt-1 lg:flex-row">
              <button type="button" onClick={() => finish(true)} disabled={busy === "save"} className={`${ACC.secondary} lg:w-auto lg:px-4`}>
                Ahora no
              </button>
              <button type="button" onClick={() => finish(false)} aria-busy={busy === "save" || undefined} className={`${ACC.primary} lg:flex-1`}>
                {busy === "save" ? "Guardando…" : "Guardar y entrar"}
              </button>
            </div>
            <span className="text-xs leading-normal text-[#6E6E73]">
              Estos son tus datos personales. Tu rol y el negocio los cambia tu administrador.
            </span>
          </div>
        ) : null}

        {step === "done" ? (
          <div role="status" className="flex flex-col gap-3.5">
            <span className="flex size-10 items-center justify-center rounded-full bg-[#E7F5EC] text-xl text-[#1E7A44]" aria-hidden>
              ✓
            </span>
            <AccessHeading
              title={first ? `Todo listo, ${first}` : "Todo listo"}
              lead={
                skipped
                  ? "Entraste sin completar el perfil. Puedes añadir teléfono y foto cuando quieras desde tu cuenta."
                  : "Tu perfil quedó guardado. Puedes cambiar estos datos cuando quieras desde tu cuenta."
              }
            />
            <button type="button" className={ACC.primary} onClick={() => window.location.assign("/")}>
              Ir a {invite.business}
            </button>
          </div>
        ) : null}
      </div>
    </AccessShell>
  );
}
