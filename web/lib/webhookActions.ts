"use server";

import { revalidatePath } from "next/cache";
import { requireFullAccessForAction } from "./access";
import { validateWebhookUrl } from "./webhookUrl";
import {
  deleteWebhook,
  revealWebhookSecret,
  rotateWebhookSecret,
  setWebhookEnabled,
  upsertWebhook,
} from "@worker/db/repositories/webhooks.js";

/**
 * Handoff-webhook registration actions. OWNER/ADMIN ONLY — requireFullAccessForAction
 * throws for a member, so the gate is at the DATA LAYER (a member is denied here, not
 * merely hidden). Tenant id comes from the session scope; the workflow id is the
 * n8n_workflow_id from the settings route. Secrets are returned to the client ONLY on
 * explicit generate/regenerate/reveal (the customer needs the symmetric secret to
 * verify signatures on their side).
 */

type SaveResult =
  | { ok: true; createdSecret: string | null }
  | { ok: false; error: string };

/** Create or update the webhook URL. First creation mints + returns the secret once. */
export async function configureWebhookAction(
  workflowId: string,
  url: string,
): Promise<SaveResult> {
  const { tenantId } = await requireFullAccessForAction();
  const validated = validateWebhookUrl(url);
  if (!validated.ok) return { ok: false, error: validated.error };
  const { createdSecret } = await upsertWebhook({
    tenantId,
    n8nWorkflowId: workflowId,
    url: validated.url,
  });
  revalidateSettings(workflowId);
  return { ok: true, createdSecret };
}

/** Regenerate the secret. The OLD secret stops validating immediately. */
export async function regenerateWebhookSecretAction(
  workflowId: string,
): Promise<{ ok: boolean; secret?: string; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const secret = await rotateWebhookSecret(tenantId, workflowId);
  if (!secret) return { ok: false, error: "No webhook is configured for this workflow." };
  revalidateSettings(workflowId);
  return { ok: true, secret };
}

/** Reveal the current secret to the owner/admin (explicit click). */
export async function revealWebhookSecretAction(
  workflowId: string,
): Promise<{ ok: boolean; secret?: string; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const secret = await revealWebhookSecret(tenantId, workflowId);
  if (!secret) return { ok: false, error: "No webhook is configured for this workflow." };
  return { ok: true, secret };
}

/** Enable/disable sending for this workflow (kill switch). */
export async function setWebhookEnabledAction(
  workflowId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  const changed = await setWebhookEnabled(tenantId, workflowId, enabled);
  if (!changed) return { ok: false, error: "No webhook is configured for this workflow." };
  revalidateSettings(workflowId);
  return { ok: true };
}

/** Delete the webhook entirely. */
export async function deleteWebhookAction(
  workflowId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { tenantId } = await requireFullAccessForAction();
  await deleteWebhook(tenantId, workflowId);
  revalidateSettings(workflowId);
  return { ok: true };
}

function revalidateSettings(workflowId: string): void {
  // The settings page is nested under a client/workflow path; revalidate broadly so
  // the status re-renders regardless of which client URL it was reached through.
  revalidatePath(`/clients`, "layout");
  void workflowId;
}
