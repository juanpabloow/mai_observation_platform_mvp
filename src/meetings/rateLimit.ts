/**
 * Limitación de tasa para `claim`, `heartbeat` y los endpoints de resultado.
 *
 * ── Qué problema resuelve, exactamente ──────────────────────────────────────
 *
 * No es abuso externo: estos endpoints exigen una credencial de worker. Es
 * **un worker mal configurado o en bucle**. Los tres casos reales:
 *
 *   · `claim` en un bucle sin backoff cuando la cola está vacía. Cada llamada es
 *     un `FOR UPDATE SKIP LOCKED` sobre un índice: barato, pero mil por segundo
 *     desde tres workers convierte «no hay trabajo» en carga de base constante.
 *   · `heartbeat` con el intervalo mal puesto (segundos en vez de decenas), que
 *     es un `UPDATE` por latido sobre una fila caliente.
 *   · `result/init` reintentado en bucle porque el worker interpreta mal una
 *     respuesta: cada uno firma una URL, que es CPU y nada más, pero enmascara
 *     el fallo real.
 *
 * ── Por qué en memoria y qué implica ────────────────────────────────────────
 *
 * Token bucket por (credencial, operación), en el proceso. Con varias instancias
 * de mai el límite efectivo es N veces el configurado, y tras un reinicio los
 * cubos empiezan llenos.
 *
 * Es suficiente y es honesto decir por qué: esto no defiende un recurso escaso
 * frente a un adversario —para eso haría falta estado compartido y sería otra
 * cosa—, frena un bucle. Un bucle lo frena igual de bien un cubo local, porque
 * el bucle viene de UN worker con UNA credencial y siempre cae en la misma
 * instancia el tiempo suficiente para agotar su cubo.
 *
 * Lo que NO se hace: limitar por IP. La identidad relevante es la credencial;
 * un pool detrás de NAT compartiría IP y se estorbaría a sí mismo.
 */

export interface RateLimitRule {
  /** Capacidad del cubo: cuántas peticiones seguidas se admiten en una ráfaga. */
  readonly burst: number;
  /** Reposición, en peticiones por segundo. */
  readonly refillPerSecond: number;
}

/**
 * Los valores por defecto salen del uso previsto, no de un número redondo:
 *
 *   claim      6 de ráfaga, 1/s — un worker con long polling llama una vez cada
 *              varios segundos; 1/s deja margen para varios procesos del mismo
 *              pool sin premiar el bucle cerrado.
 *   heartbeat  20 de ráfaga, 2/s — el intervalo previsto es ~20 s por job; 2/s
 *              admite decenas de jobs concurrentes por credencial.
 *   result     10 de ráfaga, 0.5/s — un job produce UN artefacto; llamar más de
 *              diez veces seguidas ya es un reintento en bucle.
 */
export const DEFAULT_RULES: Record<RateLimitedOperation, RateLimitRule> = {
  claim: { burst: 6, refillPerSecond: 1 },
  heartbeat: { burst: 20, refillPerSecond: 2 },
  result: { burst: 10, refillPerSecond: 0.5 },
};

export type RateLimitedOperation = 'claim' | 'heartbeat' | 'result';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Segundos hasta que haya un token disponible. 0 si se permitió. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly rules: Record<RateLimitedOperation, RateLimitRule>;
  private readonly now: () => number;
  /** Cota del mapa: sin ella, una credencial rotada cada minuto lo haría crecer
   *  sin fin. Al llegar al tope se descarta el cubo más antiguo, que es el que
   *  con más probabilidad ya está lleno y por tanto el más barato de perder. */
  private readonly maxBuckets: number;

  constructor(options?: {
    rules?: Partial<Record<RateLimitedOperation, RateLimitRule>>;
    clock?: () => number;
    maxBuckets?: number;
  }) {
    this.rules = { ...DEFAULT_RULES, ...(options?.rules ?? {}) };
    this.now = options?.clock ?? (() => Date.now());
    this.maxBuckets = options?.maxBuckets ?? 10_000;
  }

  check(credentialId: string, operation: RateLimitedOperation): RateLimitDecision {
    const rule = this.rules[operation];
    const key = `${credentialId}:${operation}`;
    const nowMs = this.now();

    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      bucket = { tokens: rule.burst, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }

    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    // Se redondea hacia arriba y con mínimo 1: un Retry-After de 0 invitaría a
    // reintentar inmediatamente, que es el bucle que esto frena.
    const wait = (1 - bucket.tokens) / rule.refillPerSecond;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait)) };
  }

  /** Para pruebas y para un `/health` que quiera decir cuántos cubos hay. */
  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Instancia compartida del proceso. Se expone como singleton porque el límite
 * tiene que ser el mismo para todas las rutas: un limitador por ruta permitiría
 * que un bucle en `claim` no contase para nada más.
 */
const globalForLimiter = globalThis as unknown as { __maiMeetingsRateLimiter?: RateLimiter };
export const meetingsRateLimiter: RateLimiter =
  globalForLimiter.__maiMeetingsRateLimiter ??
  (globalForLimiter.__maiMeetingsRateLimiter = new RateLimiter());
