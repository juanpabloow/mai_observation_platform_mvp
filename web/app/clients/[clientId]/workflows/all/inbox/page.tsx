import { redirect } from "next/navigation";

/**
 * `all/inbox` is a legacy alias — the Inbox is client-level now (W-2), scoped by the
 * header switcher. Redirect to the client inbox, which resolves the remembered scope
 * (cookie) itself.
 */
export default async function AllInboxRedirect({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  redirect(`/clients/${clientId}/inbox`);
}
