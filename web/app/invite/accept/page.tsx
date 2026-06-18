import { connection } from "next/server";
import Link from "next/link";
import { getServerSession } from "@/lib/session";
import {
  getInvitationByTokenHash,
  hashInviteToken,
  normalizeEmail,
} from "@worker/db/repositories/invitations.js";
import { AcceptInviteButton } from "@/components/AcceptInviteButton";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Centered card shell matching the auth screens. */
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-16">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-faint">Invitation</p>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      <div className="space-y-4 text-sm text-muted">{children}</div>
    </main>
  );
}

/**
 * Invite accept page. GET-only / side-effect-free: it VALIDATES the token and
 * shows the right state; the actual join is the AcceptInviteButton → action.
 *
 * Token handling fails closed + doesn't leak: an unknown token gets the same
 * generic "invalid or expired" as a malformed one (no signal about whether a
 * tenant/email exists). A token that DOES resolve gets a specific reason
 * (used / revoked / expired) since its holder was the intended recipient.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const token = first((await searchParams).token) ?? "";
  const invite = token ? await getInvitationByTokenHash(hashInviteToken(token)) : null;

  if (!invite) {
    return (
      <Shell title="Invalid or expired invitation">
        <p>This invitation link is invalid or has expired. Ask whoever invited you to send a new one.</p>
        <Link href="/login" className="text-accent hover:opacity-80">Go to sign in</Link>
      </Shell>
    );
  }
  if (invite.status === "accepted") {
    return (
      <Shell title="Already used">
        <p>This invitation has already been accepted. If that was you, just sign in.</p>
        <Link href="/login" className="text-accent hover:opacity-80">Sign in</Link>
      </Shell>
    );
  }
  if (invite.status === "revoked") {
    return (
      <Shell title="No longer valid">
        <p>This invitation has been revoked and can no longer be used.</p>
      </Shell>
    );
  }
  if (invite.status !== "pending" || invite.expires_at.getTime() <= Date.now()) {
    return (
      <Shell title="Invitation expired">
        <p>This invitation has expired. Ask whoever invited you to send a new one.</p>
      </Shell>
    );
  }

  // Valid pending invite.
  const roleText =
    invite.role === "member" ? `a member of ${invite.client_name ?? "a client"}` : "an admin";
  const session = await getServerSession();
  const currentEmail = session?.user?.email ? normalizeEmail(session.user.email) : null;

  // Not signed in → prompt sign in/up AS the invited email, carrying the token so
  // they return here afterward (/invite is public, so the link survives).
  if (!currentEmail) {
    const acceptPath = `/invite/accept?token=${encodeURIComponent(token)}`;
    const q = `redirect=${encodeURIComponent(acceptPath)}&email=${encodeURIComponent(invite.email)}`;
    return (
      <Shell title={`Join ${invite.tenant_name}`}>
        <p>
          You&rsquo;ve been invited to join <strong className="text-foreground">{invite.tenant_name}</strong> as{" "}
          {roleText}. Sign in or create an account with <strong className="text-foreground">{invite.email}</strong> to
          accept.
        </p>
        <div className="flex gap-3 pt-1">
          <Link
            href={`/signup?${q}`}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Create account
          </Link>
          <Link
            href={`/login?${q}`}
            className="rounded-lg border border-line-strong px-4 py-2 text-sm transition-colors hover:bg-subtle"
          >
            Log in
          </Link>
        </div>
      </Shell>
    );
  }

  // Signed in as a DIFFERENT email → refuse (the invite binds to its email).
  if (currentEmail !== invite.email) {
    return (
      <Shell title="Wrong account">
        <p>
          This invitation is for <strong className="text-foreground">{invite.email}</strong>, but you&rsquo;re signed in
          as <strong className="text-foreground">{currentEmail}</strong>. Sign out and sign in as the invited address,
          then open this link again.
        </p>
        <Link href="/logout" className="text-accent hover:opacity-80">Log out</Link>
      </Shell>
    );
  }

  // Signed in as the invited email → confirm + accept.
  return (
    <Shell title={`Join ${invite.tenant_name}`}>
      <p>
        Accept this invitation to join <strong className="text-foreground">{invite.tenant_name}</strong> as {roleText}?
      </p>
      <AcceptInviteButton token={token} />
    </Shell>
  );
}
