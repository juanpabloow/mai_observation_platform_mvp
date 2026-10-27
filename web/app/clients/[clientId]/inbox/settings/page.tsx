import { connection } from "next/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { hasFullAccess } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { getInboxSettings } from "@worker/db/repositories/inboxSettings.js";
import { InboxSettingsPanel } from "@/components/inbox/InboxSettingsPanel";

/**
 * JP-2 — Inbox SETTINGS. AGENCY or CLIENT OWNER only: requireClientModulePage(inbox, inbox.view)
 * (so a Setter/Staff who can READ the inbox is still 404'd here) then the agency-or-owner tier check,
 * the same tier the server action re-enforces.
 */
export default async function InboxSettingsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "inbox", "inbox.view");
  if (!(hasFullAccess(scope) || scope.clientRole === "owner")) notFound();

  const settings = await getInboxSettings(scope.tenantId, client.id);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
      <Link
        href={`/clients/${client.id}/inbox`}
        className="u-th inline-flex w-fit items-center gap-1.5 rounded-md py-1 transition-colors hover:text-foreground"
      >
        ← Inbox
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">Ajustes del inbox</h1>
      <InboxSettingsPanel clientId={client.id} initialMinutes={settings.auto_return_minutes} />
    </main>
  );
}
