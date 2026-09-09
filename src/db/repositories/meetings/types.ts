import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query as poolQuery } from '../../client.js';

/**
 * Un ejecutor de consultas: el pool o un cliente dentro de una transacción.
 *
 * Todas las funciones de estos repositorios lo aceptan como último argumento
 * opcional. No es ceremonia: T-3 exige que «crear el siguiente job» ocurra en la
 * MISMA transacción que cierra la etapa anterior, y eso sólo se puede componer
 * si cada función puede correr sobre el cliente de una transacción en curso en
 * vez de pedir su propia conexión al pool.
 */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** El pool, para cuando no hay transacción. */
export const poolQueryable: Queryable = {
  query: (text, params) => poolQuery(text, params),
};

export function q(executor?: Queryable | PoolClient): Queryable {
  return (executor as Queryable | undefined) ?? poolQueryable;
}

export type MeetingMediaState = 'pending' | 'uploading' | 'ready' | 'invalid';
export type TranscriptState = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
export type DiarizationState = 'pending' | 'running' | 'ready' | 'partial' | 'failed' | 'skipped';
export type JobStage = 'normalize' | 'transcribe' | 'diarize' | 'analyze';
export type JobStatus =
  | 'queued'
  | 'leased'
  | 'uploading_result'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'abandoned';
export type ArtifactKind = 'normalized_media' | 'transcript' | 'diarization' | 'analysis' | 'raw';
export type UploadState = 'awaiting_upload' | 'uploaded' | 'verified' | 'ingested' | 'rejected';

export interface MeetingScopeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly client_id: string;
}
