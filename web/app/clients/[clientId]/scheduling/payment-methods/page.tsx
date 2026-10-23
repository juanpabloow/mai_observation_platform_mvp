import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listPaymentMethods } from "@worker/db/repositories/scheduling/paymentMethods.js";
import { getPaymentsTrackingStartedAt } from "@worker/db/repositories/scheduling/paymentSettings.js";
import { PaymentMethodsPanel } from "@/components/scheduling/PaymentMethodsPanel";

/**
 * «Métodos de pago» — a scheduling settings page (PY-1). SAME gate as the other scheduling
 * settings screens: the module page gate (URL client validated against the session's tenant +
 * scope, non-default, module enabled — any failure an indistinguishable 404), then the
 * payments.settings permission (agency or Client Owner; setters and staff 404). Data is loaded
 * with the VALIDATED client id.
 */
export default async function PaymentMethodsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling", "payments.settings");
  const [methods, trackingStartedAt] = await Promise.all([
    listPaymentMethods(scope.tenantId, client.id),
    getPaymentsTrackingStartedAt(scope.tenantId, client.id),
  ]);
  return (
    <PaymentMethodsPanel
      clientId={client.id}
      clientName={client.name}
      methods={methods.map((m) => ({ id: m.id, key: m.key, label: m.label, active: m.active }))}
      trackingStartedAt={trackingStartedAt ? trackingStartedAt.toISOString() : null}
    />
  );
}
