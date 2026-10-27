import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { isGoogleConfigured } from "@/lib/auth";
import { getServerSession } from "@/lib/session";
import { countryOptions, isKnownCountry } from "@/lib/phone";
import { inviteAccessLabel, inviteBusinessName, inviterLabel } from "@/lib/inviteCopy";
import {
  getInvitationByTokenHash,
  hashInviteToken,
  normalizeEmail,
} from "@worker/db/repositories/invitations.js";
import { findUserIdByEmail, getMembershipForUser } from "@worker/db/repositories/tenantMembers.js";
import { getUserAvatarMeta, getUserProfile } from "@worker/db/repositories/userProfiles.js";
import { ACC, AccessHeading, AccessShell } from "@/components/access/AccessShell";
import { LoginForm } from "@/components/access/LoginForm";
import { InviteProfileFlow } from "@/components/access/InviteProfileFlow";
import { AcceptInviteButton } from "@/components/AcceptInviteButton";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** 2c/2g — the link can't be used. Generic for an unknown token (no existence signal). */
function InvalidInvite({ badge, title, body }: { badge: string; title: string; body: string }) {
  return (
    <AccessShell>
      <div className="flex flex-1 flex-col justify-center gap-3.5 lg:flex-none">
        <span className="self-start rounded-md bg-[#FFF4E0] px-2 py-[3px] text-xs text-[#8A5300]">{badge}</span>
        <AccessHeading title={title} lead={body} />
      </div>
      <Link href="/login" className={`${ACC.secondary} lg:hidden`}>
        Ya tengo perfil · Iniciar sesión
      </Link>
      <Link href="/login" className={`${ACC.link} hidden text-[15px] lg:inline`}>
        ¿Ya tienes perfil? Inicia sesión
      </Link>
    </AccessShell>
  );
}

/** The phone country to preselect: the region of a SPANISH browser locale (es-MX → MX), else
 *  Colombia, where the platform's businesses are. Only a default — the person changes it. */
function defaultCountryFrom(acceptLanguage: string | null): string {
  const m = /\bes-([A-Z]{2})\b/.exec(acceptLanguage ?? "");
  return m && isKnownCountry(m[1]) ? m[1] : "CO";
}

/**
 * /invite/accept?token=… — GET is side-effect free: it reads the invitation and shows the
 * right state; joining is always a server action that re-validates everything (recipient,
 * expiry, business and role come from the server row only).
 *
 *   not signed in, no account for the invited email  → 5a/5b «Crea tu perfil»
 *   not signed in, the account exists                → sign in (email fixed) and come back
 *   signed in as ANOTHER email                       → «Esta invitación es para…»
 *   signed in as the invited email, existing person  → «Aceptar invitación» (no new account,
 *                                                       no new password)
 *   back from Google in the create flow (&step=join) → accept + 5a step 2
 *   already accepted by this person, not onboarded   → 5a step 2 («Completa tu perfil»)
 */
export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  const sp = await searchParams;
  const token = first(sp.token) ?? "";
  const invite = token ? await getInvitationByTokenHash(hashInviteToken(token)) : null;

  if (!invite) {
    return (
      <InvalidInvite
        badge="Enlace no válido"
        title="Esta invitación ya no es válida"
        body="El enlace no es correcto o ya no existe. Pide a quien te invitó que te envíe uno nuevo."
      />
    );
  }

  const business = inviteBusinessName(invite);
  const access = inviteAccessLabel(invite);
  const inviter = inviterLabel(invite);
  const askNew = inviter ? `Pide a ${inviter} que te envíe una nueva.` : "Pide a quien te invitó que te envíe una nueva.";
  const session = await getServerSession();
  const currentEmail = session?.user?.email ? normalizeEmail(session.user.email) : null;
  const isInvitee = currentEmail === invite.email;

  // A person in the middle of the flow (the invite was just consumed by THEM) finishes step 2.
  if (invite.status === "accepted" && isInvitee && session) {
    const [profile, membership] = await Promise.all([getUserProfile(session.user.id), getMembershipForUser(session.user.id)]);
    if (!membership || membership.tenant_id !== invite.tenant_id || profile?.onboarded_at) redirect("/");
    const avatar = await getUserAvatarMeta(session.user.id);
    return (
      <InviteProfileFlow
        invite={{ token, email: invite.email, business, access, inviter }}
        googleEnabled={isGoogleConfigured}
        initialStep="complete"
        user={{
          id: session.user.id,
          name: session.user.name ?? "",
          providerImage: session.user.image ?? null,
          uploaded: avatar?.sha256 ?? null,
          via: session.session.authMethod === "google" ? "google" : "password",
        }}
        countries={countryOptions()}
        defaultCountry={defaultCountryFrom((await headers()).get("accept-language"))}
      />
    );
  }

  if (invite.status === "accepted") {
    return (
      <InvalidInvite
        badge="Invitación usada"
        title="Esta invitación ya se aceptó"
        body={`Si fuiste tú, inicia sesión con ${invite.email}. Si no, ${askNew.charAt(0).toLowerCase()}${askNew.slice(1)}`}
      />
    );
  }
  if (invite.status === "revoked") {
    return <InvalidInvite badge="Invitación anulada" title="Esta invitación ya no es válida" body={`Quien te invitó la anuló. ${askNew}`} />;
  }
  // eslint-disable-next-line react-hooks/purity -- dynamic per-request page (connection())
  if (invite.status !== "pending" || invite.expires_at.getTime() <= Date.now()) {
    return <InvalidInvite badge="Enlace vencido" title="Esta invitación ya no es válida" body={`Pasaron más de 7 días o ya se usó. ${askNew}`} />;
  }

  const acceptPath = `/invite/accept?token=${encodeURIComponent(token)}`;

  if (!session) {
    const exists = Boolean(await findUserIdByEmail(invite.email));
    if (!exists) {
      return (
        <InviteProfileFlow
          invite={{ token, email: invite.email, business, access, inviter }}
          googleEnabled={isGoogleConfigured}
          initialStep="create"
          user={null}
          countries={countryOptions()}
          defaultCountry={defaultCountryFrom((await headers()).get("accept-language"))}
        />
      );
    }
    // An existing person accepts with the account they already have — never a second one.
    return (
      <AccessShell
        aside={
          <h2 className="m-0 text-[34px] font-semibold leading-[1.15] tracking-[-.02em] text-[#ECECEE] [text-wrap:pretty]">
            Te invitaron a {business}.
          </h2>
        }
        mobileTop={
          <span className="text-sm text-[#A6A6AE]">
            {business} · {access}
          </span>
        }
        width={360}
      >
        <AccessHeading
          title="Entra para aceptar"
          lead={
            <>
              Ya tienes una cuenta con <span className="text-[#111]">{invite.email}</span>. Entra con ella y aceptarás el acceso
              como {access}.
            </>
          }
        />
        <LoginForm googleEnabled={isGoogleConfigured} destination={acceptPath} initialEmail={invite.email} emailLocked showSignup={false} />
      </AccessShell>
    );
  }

  if (!isInvitee) {
    const back = `/logout?next=${encodeURIComponent(acceptPath)}`;
    return (
      <AccessShell>
        <AccessHeading
          title="Esta invitación es para otra cuenta"
          lead={
            <>
              Es para <span className="text-[#111]">{invite.email}</span>, pero entraste como{" "}
              <span className="text-[#111]">{currentEmail}</span>. Cierra esta sesión y entra con el correo invitado.
            </>
          }
        />
        <Link href={back} className={`${ACC.primary} lg:w-auto lg:self-start lg:px-5`}>
          Cerrar sesión y continuar
        </Link>
      </AccessShell>
    );
  }

  // Signed in as the invited email.
  const membership = await getMembershipForUser(session.user.id);
  const fromCreateFlow = first(sp.step) === "join" && !membership;
  if (fromCreateFlow) {
    const avatar = await getUserAvatarMeta(session.user.id);
    return (
      <InviteProfileFlow
        invite={{ token, email: invite.email, business, access, inviter }}
        googleEnabled={isGoogleConfigured}
        initialStep="join"
        user={{
          id: session.user.id,
          name: session.user.name ?? "",
          providerImage: session.user.image ?? null,
          uploaded: avatar?.sha256 ?? null,
          via: "google",
        }}
        countries={countryOptions()}
        defaultCountry={defaultCountryFrom((await headers()).get("accept-language"))}
      />
    );
  }

  return (
    <AccessShell
      aside={
        <h2 className="m-0 text-[34px] font-semibold leading-[1.15] tracking-[-.02em] text-[#ECECEE] [text-wrap:pretty]">
          Te invitaron a {business}.
        </h2>
      }
    >
      <AccessHeading
        title={`Únete a ${business}`}
        lead={
          <>
            {inviter ? `${inviter} te invitó` : "Te invitaron"} con acceso como <span className="text-[#111]">{access}</span>. Usarás tu
            cuenta actual: no necesitas otra contraseña.
          </>
        }
      />
      <AcceptInviteButton token={token} />
    </AccessShell>
  );
}
