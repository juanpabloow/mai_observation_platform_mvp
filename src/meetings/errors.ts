/**
 * Códigos de error de `/api/meetings/v1`. **Estables**: el worker los compara,
 * no los lee.
 *
 * ── Qué NO dicen ────────────────────────────────────────────────────────────
 *
 * Ninguno revela si un recurso existe en otro tenant. `not_found` cubre a la vez
 * «no existe», «existe pero es de otro cliente» y «existe pero tu credencial no
 * alcanza» — indistinguibles a propósito. Un 404 que se convierte en 403 cuando
 * aciertas el uuid es un oráculo de enumeración.
 *
 * Y ninguno lleva secretos: ni el token, ni una URL firmada, ni el hash. El
 * campo `detail` es para humanos y se compone en el servidor a partir de
 * literales, nunca interpolando entrada.
 */

export type MeetingsErrorCode =
  // Autenticación e identidad (todos con el MISMO cuerpo, ver `unauthorized`).
  | 'unauthorized'
  // Ámbito
  | 'not_found'
  | 'module_disabled'
  // Entrada
  | 'invalid_request'
  | 'media_rejected'
  | 'unsupported_schema_version'
  // Flujo de trabajo
  | 'lease_invalid'
  | 'lease_expired'
  | 'attempt_stale'
  | 'invalid_transition'
  /**
   * Un `complete` o un `fail` repetido con datos DISTINTOS de los que ya se
   * registraron. No es `invalid_transition`: la transición ya ocurrió y fue
   * legítima; lo que no se acepta es reescribir su resultado.
   */
  | 'terminal_conflict'
  | 'no_work'
  // Verificación de artefactos
  | 'object_missing'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'content_type_mismatch'
  | 'artifact_malformed'
  // Infraestructura
  | 'storage_unavailable'
  | 'storage_not_configured'
  | 'rate_limited'
  | 'internal';

export interface MeetingsErrorBody {
  readonly error: { readonly code: MeetingsErrorCode; readonly message: string };
}

/** El estado HTTP que corresponde a cada código. Una sola tabla, para que dos
 *  rutas no puedan discrepar sobre el estado del mismo error. */
export const ERROR_STATUS: Record<MeetingsErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  module_disabled: 403,
  invalid_request: 400,
  media_rejected: 422,
  unsupported_schema_version: 422,
  lease_invalid: 409,
  lease_expired: 409,
  attempt_stale: 409,
  invalid_transition: 409,
  terminal_conflict: 409,
  no_work: 204,
  object_missing: 422,
  size_mismatch: 422,
  checksum_mismatch: 422,
  content_type_mismatch: 422,
  artifact_malformed: 422,
  storage_unavailable: 503,
  storage_not_configured: 503,
  rate_limited: 429,
  internal: 500,
};

export class MeetingsApiError extends Error {
  readonly code: MeetingsErrorCode;
  readonly status: number;
  /** Cabeceras extra (p. ej. `Retry-After` en un 429). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: MeetingsErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'MeetingsApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.headers = headers;
  }

  body(): MeetingsErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

/**
 * El 401 único. Token ausente, malformado, desconocido, caducado, revocado, o
 * sin la capacidad pedida: **el mismo cuerpo en los seis casos**. Distinguirlos
 * le diría a quien prueba tokens cuál de sus intentos se acercó.
 */
export function unauthorized(): MeetingsApiError {
  return new MeetingsApiError('unauthorized', 'Credencial de worker inválida.');
}

/** El 404 único, para recursos y para ámbitos ajenos. */
export function notFound(): MeetingsApiError {
  return new MeetingsApiError('not_found', 'No encontrado.');
}

export function invalidRequest(message: string): MeetingsApiError {
  return new MeetingsApiError('invalid_request', message);
}
