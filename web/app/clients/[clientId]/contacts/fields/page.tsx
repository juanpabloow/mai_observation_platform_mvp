import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { FieldDefinitions } from "@/components/contacts/FieldDefinitions";

/**
 * Custom-field DEFINITIONS for a client's contacts (C-2). Owner/admin only — a member
 * is refused server-side (indistinguishable 404). Placed under the Contacts surface
 * (the CRM home) rather than a new settings area: the person who curates contacts is
 * who defines contact fields, and it needs no new top-level route.
 */
export default async function ContactFieldsPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  if (!hasFullAccess(scope)) notFound(); // owner/admin only

  const defs = await listFieldDefinitions(scope.tenantId, client.id);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-6 py-6">
      <Link href={`/clients/${client.id}/contacts`} className="text-sm text-muted hover:text-foreground">
        ← Contacts
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Custom fields</h1>
        <p className="mt-0.5 text-sm text-muted">
          Extra fields on this client&rsquo;s contacts — the CRM analogue of workflow field mappings.
        </p>
      </div>
      <FieldDefinitions
        clientId={client.id}
        defs={defs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options, enabled: d.enabled, position: d.position }))}
      />
    </main>
  );
}
