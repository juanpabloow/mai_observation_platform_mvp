import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `meeting_segments.speaker_uncertain` — la duda sobre QUIÉN habló, aparte del
 * solapamiento de voces.
 *
 * ── Por qué una columna y no reutilizar `overlap` ──────────────────────────
 *
 * `overlap` afirma algo sobre el AUDIO: dos personas hablando a la vez en ese tramo,
 * con el criterio de que un segundo turno cubra al menos el 25 % del bloque. Es un
 * hecho medido.
 *
 * `speaker_uncertain` afirma algo sobre NUESTRA CONFIANZA: la atribución de ese bloque
 * descansa sobre poca evidencia. Son cosas distintas y se dan por separado — un bloque
 * puede tener dos voces y una atribución clarísima, o una sola voz y una atribución
 * dudosa. Meterlas en el mismo booleano haría que la pantalla dijera «aquí hablan dos»
 * cuando lo que pasa es «aquí no sabemos quién habla», que es una afirmación distinta y
 * más difícil de desmentir.
 *
 * ── Y por qué la duda se marca en vez de resolverse absorbiendo ────────────
 *
 * La alternativa era absorber los tramos cortos de otro hablante en su vecino, para que
 * el transcript no saliera picado. Eso compra legibilidad cambiando QUIÉN DIJO QUÉ, que
 * es el dato que la pantalla existe para mostrar. Ahora la atribución se conserva
 * siempre —un «Claro» de otra voz en mitad de un segmento mantiene su hablante y sus
 * tiempos— y lo que se hace con lo corto y lo dudoso es una decisión de presentación,
 * que se toma con esta columna delante y no borrando el dato.
 *
 * ── NOT NULL con DEFAULT false ────────────────────────────────────────────
 *
 * Las filas ya escritas se atribuyeron por segmento entero y por mayor solape, sin
 * palabras: no hay nada que decir sobre su duda que no sea inventarlo, así que `false`
 * —«no consta»— es lo honesto. No es lo mismo que «comprobado y firme», y por eso el
 * comentario de la columna lo dice.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE meeting_segments
      ADD COLUMN speaker_uncertain boolean NOT NULL DEFAULT false;

    COMMENT ON COLUMN meeting_segments.speaker_uncertain IS
      'La atribución de hablante de este bloque es tentativa (poca evidencia, cobertura fina del turno, o un cambio de hablante que no se pudo situar). DISTINTO de overlap, que afirma dos voces simultáneas en el audio. false en filas anteriores a la columna significa «no consta», no «verificado».';

    -- Para poder contar y filtrar lo dudoso de una versión sin recorrerla entera.
    CREATE INDEX segments_uncertain_idx
      ON meeting_segments (transcript_id)
      WHERE speaker_uncertain;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS segments_uncertain_idx;
    ALTER TABLE meeting_segments DROP COLUMN IF EXISTS speaker_uncertain;
  `);
}
