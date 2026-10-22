import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getAccessScope, memberLandingHref } from "@/lib/access";
import { NoAccess } from "@/components/ui/module/States";

/**
 * Where a member lands when its role opens NO page of its business (a custom role saved
 * without permissions, or one whose access was taken away while signed in). Session-gated
 * like every page; if the role DOES open something now (it was just fixed), it goes there.
 */
export default async function NoAccessPage() {
  await connection();
  const scope = await getAccessScope();
  const home = memberLandingHref(scope);
  if (home !== "/no-access") redirect(home);
  return (
    <main className="flex w-full flex-1 flex-col">
      <NoAccess />
    </main>
  );
}
