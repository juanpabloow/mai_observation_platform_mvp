import Link from "next/link";
import { getServerSession } from "@/lib/session";

/**
 * Thin global top bar showing auth state, read SERVER-SIDE via getServerSession
 * (the data-layer session check — not middleware). Shows the logged-in user's
 * email + a logout link when a session exists, otherwise login/signup links.
 * Just enough to SEE auth working; route protection is a later step.
 */
export async function AuthHeader() {
  const session = await getServerSession();
  const user = session?.user ?? null;

  return (
    <header className="flex items-center justify-between border-b border-white/10 px-6 py-2.5 text-sm">
      <Link href="/" className="font-medium tracking-tight text-neutral-200 hover:text-white">
        Observability
      </Link>
      <div className="flex items-center gap-4">
        {user ? (
          <>
            <Link href="/settings/connections" className="text-neutral-400 transition-colors hover:text-white">
              Connections
            </Link>
            <span className="text-neutral-400">{user.email}</span>
            <Link href="/logout" className="text-neutral-400 transition-colors hover:text-white">
              Log out
            </Link>
          </>
        ) : (
          <>
            <Link href="/login" className="text-neutral-400 transition-colors hover:text-white">
              Log in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-emerald-600 px-3 py-1 text-white transition-colors hover:bg-emerald-500"
            >
              Sign up
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
