import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * El token de lease: opaco, hasheado, y **ligado a (job, intento, credencial)**.
 *
 * ── Por qué esas tres cosas y no sólo el job ────────────────────────────────
 *
 * El token dice «yo soy quien está procesando esto ahora mismo». Cada una de las
 * tres ataduras cierra una forma de que eso deje de ser verdad:
 *
 *   · **job** — obvio: un token no vale para otro trabajo.
 *   · **intento** — un worker que se quedó colgado, revivió y manda `complete`
 *     con su token del intento 2 mientras otro worker está en el intento 3. Sin
 *     el intento dentro del token, el mensaje del muerto ganaría, y el
 *     resultado que se ingiere sería el del proceso que ya nadie supervisa.
 *   · **credencial** — si una credencial se revoca, sus leases dejan de valer
 *     sin necesidad de recorrer los jobs: el token ya no verifica.
 *
 * ── Qué se guarda ───────────────────────────────────────────────────────────
 *
 * En la base sólo el SHA-256 (`meeting_processing_jobs.lease_token_hash`, con su
 * CHECK de formato). El claro se devuelve UNA vez en la respuesta del claim y no
 * se persiste en ningún sitio. Si se pierde, no se recupera: el lease caduca y
 * el job se requeuea, que es exactamente el comportamiento deseado.
 *
 * ── Y por qué la comparación es timing-safe ─────────────────────────────────
 *
 * `verifyLeaseToken` compara digestos con `timingSafeEqual`, no con `===`. La
 * comparación de cadenas de Node sale en el primer byte distinto, así que el
 * tiempo de respuesta filtra cuántos caracteres acertaste. Con un token de 32
 * bytes aleatorios eso no es explotable en la práctica, pero la alternativa
 * cuesta una línea y no hay que razonar sobre si el margen es suficiente.
 */

/** 32 bytes de aleatoriedad criptográfica: 256 bits, base64url. */
const TOKEN_BYTES = 32;
const PREFIX = 'mlt_';

export interface LeaseBinding {
  readonly jobId: string;
  readonly attempt: number;
  readonly credentialId: string;
}

export interface MintedLeaseToken {
  /** Se devuelve al worker UNA vez y no se persiste. */
  readonly token: string;
  /** Lo único que va a la base. */
  readonly tokenHash: string;
}

/**
 * El hash liga el secreto a su contexto: es el digesto de
 * `secreto|job|intento|credencial`. Un token robado de otro job no verifica
 * aquí aunque el secreto sea correcto, porque el contexto entra en el hash.
 */
function bindingDigest(secret: string, binding: LeaseBinding): string {
  return createHash('sha256')
    .update(`${secret}|${binding.jobId}|${binding.attempt}|${binding.credentialId}`)
    .digest('hex');
}

export function mintLeaseToken(binding: LeaseBinding): MintedLeaseToken {
  const secret = `${PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token: secret, tokenHash: bindingDigest(secret, binding) };
}

/**
 * ¿Este token claro corresponde a este hash CON este contexto? Un `false` no
 * distingue «token equivocado» de «intento equivocado» de «credencial
 * equivocada», y el llamador tampoco debe distinguirlos hacia fuera.
 */
export function verifyLeaseToken(
  token: string,
  storedHash: string | null,
  binding: LeaseBinding,
): boolean {
  if (!storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return false;
  const computed = bindingDigest(token, binding);
  // Los dos son hex de 64 chars, así que los buffers tienen el mismo tamaño y
  // timingSafeEqual no lanza.
  return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHash, 'hex'));
}
