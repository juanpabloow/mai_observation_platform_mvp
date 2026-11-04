import { logger } from "@worker/logger.js";
import { handleEvent, handleVerify, readWebhookConfig, WebhookCounters, type WebhookDeps } from "@/lib/whatsappWebhook";

/**
 * /api/whatsapp/webhook — receptor del webhook de WhatsApp de Meta (ver lib/whatsappWebhook.ts).
 *
 * MACHINE endpoint, público y sin cookie: lo protege la firma de Meta (`X-Hub-Signature-256`,
 * HMAC del cuerpo con META_APP_SECRET), no una sesión. GET es la verificación de Meta; POST
 * descarta los avisos de estado y reenvía los mensajes a WHATSAPP_FORWARD_URL.
 *
 * Inactivo hasta que se cambie la URL en Meta; sin las cuatro variables responde 503 (ver
 * docs/ops/whatsapp-webhook-filtro.md).
 */
export const dynamic = "force-dynamic";

// Una sola lectura por proceso: las variables de Railway no cambian sin reiniciar.
const deps: WebhookDeps = {
  config: readWebhookConfig(process.env),
  fetch: (...args) => fetch(...args),
  log: (level, entry) => logger[level](entry, `whatsapp webhook ${entry.outcome}`),
  counters: new WebhookCounters(),
};

export function GET(req: Request): Response {
  return handleVerify(new URL(req.url), deps);
}

export function POST(req: Request): Promise<Response> {
  return handleEvent(req, deps);
}
