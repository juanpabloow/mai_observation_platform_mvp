import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { canManageClient } from "@/lib/access";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { FieldDefinitions } from "@/components/contacts/FieldDefinitions";

/**
 * Custom-field DEFINITIONS for a client's contacts (C-2). Agency or this client's owner only —
 * anyone else is refused server-side (indistinguishable 404). Placed under the Contacts surface
 * (the CRM home) rather than a new settings area: the person who curates contacts is
 * who defines contact fields, and it needs no new top-level route.
 */
export default async function ContactFieldsPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  if (!canManageClient(scope, clientId)) notFound(); // agency or this client's Owner

  const defs = await listFieldDefinitions(scope.tenantId, client.id);

  return (
    <FieldDefinitions
      clientId={client.id}
      defs={defs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options, enabled: d.enabled, position: d.position }))}
    />
  );
}
