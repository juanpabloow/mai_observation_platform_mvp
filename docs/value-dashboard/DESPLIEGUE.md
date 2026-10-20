# Despliegue del dashboard de valor: migraciones 1812 y 1813

No se ejecutó nada en producción. Todo lo de abajo se probó con el mismo ejecutor contra bases locales recreadas desde cero.

## Numeración

`main` ya tiene 1809 (`attribution-brief-window`), 1810 y 1811. Esta rama usa:

| Migración | Qué hace | Transacción |
|---|---|---|
| `1812000000000_value-dashboard` | Crea `value_estimate_assumptions` (solo inserción, con un trigger que rechaza `UPDATE`) e `instrumentation_reviews` (con `mappings_fingerprint`) | Sí (la del ejecutor) |
| `1813000000000_value-dashboard-appointments-index` | `CREATE INDEX CONCURRENTLY appointments_tenant_client_created_idx` | **No** (`pgm.noTransaction()`) |

**Antes de fusionar:** comprobar de nuevo que no haya en `main` una migración con un número ≥ 1812. Si la hay, renumerar estas dos para que queden después de ella, conservando el orden.

## Cómo las corre el ejecutor real

El pre-deploy, configurado en el dashboard de Railway, corre las migraciones al desplegar. Conviene confirmar en Railway que el comando sea `npm run migrate:prod`, es decir `node-pg-migrate --tsx` (v8.0.4).

**Comportamiento por defecto de esa versión:**

- **Una sola transacción:** todas las migraciones pendientes juntas (`--single-transaction` es `true`).
- **Concurrencia:** toma un lock advisory, así que dos despliegues no migran a la vez.
- **Migración sin transacción:** al llegar a una con `noTransaction()`, hace `COMMIT` de lo anterior, corre cada sentencia por separado fuera de transacción y abre `BEGIN` después.

**Lo que se observó localmente** (salida del ejecutor):

```
### MIGRATION 1812000000000_value-dashboard (UP) ###
…
### MIGRATION 1813000000000_value-dashboard-appointments-index (UP) ###
#> WARNING: Need to break single transaction! <
COMMIT;
SET lock_timeout = '10s';
DROP INDEX CONCURRENTLY IF EXISTS appointments_tenant_client_created_idx;
CREATE INDEX CONCURRENTLY appointments_tenant_client_created_idx ON appointments (tenant_id, client_id, created_at);
RESET lock_timeout;
INSERT INTO "public"."pgmigrations" …
BEGIN;
```

## Bloqueos esperados

**1812:**

- **Qué toma:** `SHARE ROW EXCLUSIVE` sobre `tenants` y `clients`, por las FK de las dos tablas nuevas, hasta el `COMMIT`.
- **Qué bloquea:** escrituras en `tenants` y `clients` durante ese instante, que es de milisegundos (dos tablas vacías).
- **Qué no toca:** `appointments` y las tablas de conversación.
- **Si va junto con otras pendientes:** como el ejecutor usa una sola transacción, esos locks duran lo que duren las migraciones anteriores del mismo despliegue.

**1813:**

- **Qué toma:** `SHARE UPDATE EXCLUSIVE` sobre `appointments`.
- **Qué no bloquea:** lecturas ni escrituras, es decir reservas, el bot ni la agenda.
- **Qué sí bloquea:** otros DDL y `VACUUM`/`ANALYZE` sobre esa tabla mientras dure.
- **Esperas antes de terminar:** debe esperar a que terminen las transacciones ya abiertas sobre `appointments`; `lock_timeout = 10s` acota esa espera.
- **Duración:** proporcional al tamaño de `appointments`, que hace dos pasadas. No medí la tabla de producción (no tengo acceso). Se puede medir en solo lectura con la consulta de abajo.

## Si algo falla

**Prueba local de un bloqueo:**

- **Escenario:** otra sesión con `LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE` durante 25 s.
- **Resultado:** 1813 falló a los ~10 s con `canceling statement due to lock timeout`.
- **Estado tras el fallo:** 1812 quedó aplicada, 1813 sin registrar y **sin índice inválido**.
- **Reintento:** al soltar el lock, volver a correr creó el índice válido y registró 1813.

**Si 1813 falla en producción:**

- **El despliegue se detiene**, como cualquier pre-deploy que falla.
- **Seguir así es seguro:** el código anterior sigue funcionando con 1812 aplicada, porque es aditiva.
- **Para reparar,** basta reintentar el despliegue. El primer paso borra cualquier índice inválido que haya dejado un intento anterior.

## Orden de despliegue recomendado

1. **Fusionar** cuando `main` no tenga números en conflicto (ver «Numeración»).
2. **Desplegar fuera de hora pico.** No es obligatorio, pero reduce la espera de 1813 por transacciones abiertas.
3. **Pre-deploy:** 1812 y luego 1813. Las dos son aditivas, y el código anterior las ignora.
4. **Arranca el código nuevo.**
   - **Lo que necesita de 1812:** sus tablas. El dashboard y las acciones de supuestos las consultan, y sin ellas fallarían con error, que el dashboard muestra como «No pudimos cargar».
   - **Lo que no necesita:** 1813. Sin ese índice el dashboard funciona, solo más lento.
5. **Verificación posterior, en solo lectura:**

```sql
SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 3;
SELECT indexrelid::regclass, indisvalid FROM pg_index
 WHERE indexrelid = 'appointments_tenant_client_created_idx'::regclass;   -- indisvalid = true
SELECT count(*) FROM value_estimate_assumptions;                           -- 0 al principio
SELECT count(*) FROM instrumentation_reviews;                              -- 0: nadie la escribe
```

**Medición previa opcional, en solo lectura:**

```sql
SELECT pg_size_pretty(pg_total_relation_size('appointments')), count(*) FROM appointments;
```

## Reversión

- **Si hiciera falta:** `down` de 1813 y luego de 1812. 1813 hace `DROP INDEX CONCURRENTLY IF EXISTS`; 1812 borra las dos tablas y la función del trigger.
- **Qué se pierde:** los supuestos y revisiones registrados. Por eso, en producción, el `down` solo con autorización expresa.
- **Probado localmente:** `down 2` deja la base sin las tablas ni el índice, y `up` las restaura.

## Lo que este despliegue no hace

- No modifica datos existentes ni hace backfills.
- No crea revisiones ni supuestos.
- No cambia permisos de producción.
