# Revisión manual de instrumentación (§5.2 y §7 de la especificación)

Las métricas conversacionales (atención automatizada, tiempos de respuesta y las unidades U1/U2 del tiempo liberado) solo se muestran si se cumplen **las dos** condiciones:

1. **Contraste automático:** Q9 da `habilitable` para el cliente y el periodo consultado. Se recalcula en **cada** carga.
2. **Revisión manual vigente:** la fila más reciente de `instrumentation_reviews` del cliente cumple las cuatro condiciones:
   - es `approved`;
   - usa la metodología actual (`v3.1`);
   - incluye en `conversational_workflow_ids` **todos** los workflows que Q9 ve hoy como conversacionales;
   - su `mappings_fingerprint` coincide con la huella **actual** de los mapeos de esos workflows.

**Si falta cualquiera de las dos:** la pantalla dice «Sin evidencia suficiente» con el motivo y no muestra ningún número, ni siquiera un 0.

**Nada en la aplicación crea, aprueba ni edita revisiones.** No hay botón ni acción para eso, a propósito.

## Quién está autorizado

| Rol | Puede |
|---|---|
| **Quien revisa** | Hacer la revisión. Debe ser de la **agencia** (owner/admin del tenant) y **no** quien configuró los mapeos de ese workflow (cuatro ojos). |
| **Quien registra** | Insertar la fila. Necesita escritura en la base de producción y una autorización expresa para esa revisión. Puede ser la misma persona, si tiene ese acceso. |
| **Dueño del negocio, setters y staff** | Nada: ni revisar ni registrar. |
| **Datos sintéticos o de prueba** | Nunca cuentan como revisión. Una revisión solo vale si se hizo sobre ejecuciones reales del cliente. |

## Procedimiento

1. **Contraste automático:**
   - correr Q0, Q1, Q1b y Q9 para **un** cliente y **un** periodo de 14 días, en solo lectura;
   - parámetros de partida: ventana 30 min, tolerancia 2 min, umbral 0,95, mínimo 50 turnos;
   - si Q9 no da `habilitable`, se corrige el workflow y se detiene aquí.
2. **Confirmar la lista de workflows:**
   - los que Q9 marca como conversacionales deben serlo;
   - los `no_conversacional` deben serlo de verdad (por ejemplo, un recordatorio).
3. **Muestra:** 20 ejecuciones al azar de **cada** workflow de atención. En cada una se verifica:
   - que el mensaje del cliente y la respuesta del bot están en la conversación correcta de la plataforma;
   - que la diferencia de hora cabe en la tolerancia;
   - que la clave de conversación es la misma en ambos lados.
4. **Criterio**, fijado antes de mirar los datos: hace falta **≥ 19 de 20** correctas por workflow. Si no se cumple, se registra como `rejected` (con su motivo) y no se habilita nada.
5. **Registro:** se inserta la fila con la plantilla de abajo. La huella se calcula **en el momento del registro**, con la misma expresión que usa el dashboard (`MAPPINGS_FINGERPRINT_SQL` en `src/db/repositories/valueDashboard.ts`).

```sql
-- PLANTILLA. No ejecutar sin autorización expresa. Reemplazar los valores entre <…>.
INSERT INTO instrumentation_reviews
  (tenant_id, client_id, status, method_version, conversational_workflow_ids,
   mappings_fingerprint, sample_size, correct_count, reviewed_by, reviewed_at, notes)
SELECT '<tenant_id>', '<client_id>', '<approved|rejected>', 'v3.1', ARRAY['<wf_id>', '<wf_id>'],
       (SELECT md5(coalesce(string_agg(n8n_workflow_id || '|' || role || '|' || coalesce(node_name, '') || '|' || json_path,
                                       E'\n' ORDER BY n8n_workflow_id, role), ''))
          FROM field_mappings
         WHERE tenant_id = '<tenant_id>' AND mapping_kind = 'conversation'
           AND n8n_workflow_id = ANY(ARRAY['<wf_id>', '<wf_id>'])),
       <muestra total>, <correctas>, '<user id de quien revisó>', now(),
       '<periodo contrastado, enlace a la hoja de la muestra, observaciones>';
```

**Reglas del registro:**

- **Inmutable:** la tabla es de solo inserción. Una corrección es una fila nueva; las anteriores quedan como historial.
- **Una fila por cliente:** cubre la lista completa de sus workflows conversacionales.

## Cuándo deja de valer (invalidación)

| Cambio | Qué pasa | ¿Automático? |
|---|---|---|
| Aparece un workflow conversacional nuevo, o un mapeo nuevo convierte en conversacional uno que no lo era | No está en `conversational_workflow_ids` → «revisión desactualizada» | Sí |
| Se edita, agrega o borra un mapeo de conversación de un workflow revisado | La huella ya no coincide → «revisión desactualizada» | Sí |
| Cambia la metodología (`EVIDENCE_PARAMS.methodVersion`) | Las revisiones con otra versión quedan desactualizadas | Sí |
| El workflow deja de reportar mensajes o respuestas en un periodo | Q9 cae por debajo del umbral en ese periodo → oculto en ese periodo | Sí, por periodo |
| Un workflow se reasigna a otro cliente | Sale de la lista de este cliente; si entra uno nuevo, aplica la fila 1 | Sí |
| Alguien detecta un problema que la máquina no ve (por ejemplo, se cambió el flujo en n8n sin tocar los mapeos) | Hay que registrar una fila `rejected` con el motivo, y vuelve a ocultarse | **No: es manual** |

**Límite que queda:** los cambios **internos** de un workflow en n8n, que no tocan los mapeos ni dejan de reportar mensajes, no se detectan solos. Lo mitiga el contraste automático, que se recalcula en cada periodo. Se recomienda repetir la revisión después de cualquier cambio de un workflow de atención, y al menos cada 90 días. Esa periodicidad no está forzada en el código.

## Qué no se hace

- **Aprobar evidencia real** sin la muestra descrita arriba.
- **Insertar revisiones de prueba** en producción.
- **Habilitar métricas conversacionales** con datos sintéticos.
- **Usar el entorno local:** las revisiones sintéticas de la base local son de demostración y no representan evidencia.
