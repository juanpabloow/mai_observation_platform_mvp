# Gallery — reconciliación comercial Fresha → M_AI (oct. 2026)

Estado: **propuesta, sin datos escritos**. Este documento está **separado a propósito** de las
correcciones de código (`docs/proposals/gallery-incidents-2026-10.md`) y de su despliegue
(`docs/ops/gallery-incidents-deploy-plan.md`). Nada de lo que aquí aparece se aplica al desplegar:
- No hay importación ni limpieza de datos.
- No se cancela, mueve ni reescribe ninguna cita, tampoco las TEST.
- No hay cambios de configuración comercial.

Los datos de Fresha son **evidencia de lectura** que Codex verificó en su sesión (12 oct). No
autorizan importar ni modificar nada. El único código relacionado es el dry-run (§3): una
herramienta local que no se ejecuta en el despliegue, no abre la base de datos y no llama a Fresha.

## 1. Correspondencia Gallery (confirmada por el usuario)

| Fresha | M_AI | Confianza | Pendiente |
|---|---|---|---|
| Gallery, centro 2658621, Calle 77a 13-19 | Gallery-93, sede `a3e789fa-…` del cliente `6790e355-…` | Alta (confirmado: única sede) | — |
| Falla San | Falla | Alta (confirmado) | **Validar id de staff en M_AI** antes de cualquier escritura |
| Federico Pelaez | Federico | Alta (confirmado) | Ídem |
| Valeria (Fresha: rol "Recepcionista") | — | — | **No** se crea ni se borra; el plan la ignora. Tiene servicios asignados en Fresha (Signature, manicura/pedicura) — ver §1 servicios |

Turnos semanales en Fresha (evidencia): Federico lun–sáb 10–20; Falla lun–dom 10–20. La sede
M_AI cierra el domingo; el domingo de Falla es una **propuesta** de horario, no se aplica.

### Servicios (candidatos, NO confirmados — nunca por nombre)

| Fresha | M_AI candidato | Diferencia | Decisión |
|---|---|---|---|
| Corte estándar `20444053` — 55 min / $60.000, Falla + Federico, online | Corte — 50 min / $60.000 | Duración +5 min; descripción | ¿Mismo servicio? ¿Qué duración manda? |
| CORTE SIGNATURE `20818667` — 60 min / $100.000, Federico + Gallery Operations + Valeria; **Falla no** | Corte Signature — 70 min / $100.000 | Duración −10 min; asignación | Ídem, y si Falla lo realiza |
| Corte 2x1 `25328454` — 45 min / $30.000, no online | — | Promoción | **Pendiente** (condiciones comerciales) |
| Corte + Asesoría Gratis `25328471` — 55 min / $60.000, no online | — | Promoción | **Pendiente** |
| Rayitos | Gallery Color 150 min / $380.000 **no** confirmado | — | **Sin equivalente**; no se mapea por semejanza |
| 4 servicios de manicura/pedicura (Valeria) | — | Fuera de los dos barberos | **Pendiente** (alcance) |
| Promociones / descripciones de Fresha | — | **M_AI no tiene modelo de promociones**; descripción ≤500 existe desde `bdde7d3` | Producto: ¿añadir promociones (migración) o texto en descripción? |

Ningún par se confirma por nombre o duración parecida: el plan los trata como
`service_unmapped` hasta que el mapping diga `confirmed: true`.

**Cita Fresha `1322172783`** (booking `1786039567`, ref F1624869): Federico 11:45–12:30, "Corte
2x1", 45 min, $30.000, Reservada, creada por Valeria el 7 oct. Su probable par en M_AI es la cita
del contacto `4b9dc991-…`: 12:00–12:50, "Corte", 50 min, $60.000, origen Mostrador. **El vínculo
por id externo no está verificado** (M_AI no guarda ids de Fresha). Difieren la hora, el servicio y
el precio: ¿cuál es la real? No se reescribe ninguna de las dos.

Configuración de reserva (pendiente, decisión comercial): Fresha tiene antelación inmediata,
horizonte de 5 meses y paso de 15 min. M_AI tiene 20 min, 30 días y 15 min. No se cambia nada.

Cambiar duración/precio de un servicio **no altera citas existentes**: cada cita guarda
`service_name_snapshot`, `duration_min_snapshot`, `price_snapshot` y buffers.

### 12 oct — excepciones por fecha (no reglas semanales)

| Profesional | Fresha | M_AI | Acción propuesta |
|---|---|---|---|
| Falla | Bloqueo `213946715` 10:00–20:00, sin recurrencia, sin reserva online; Fresha: 0 citas | 5 citas | Excepción fechada + **conflicto con 5 citas** → decisión por cita (real / TEST / mover). Nada se cancela |
| Federico | Pausa `214064503`: el calendario muestra 12:25–13:25 y el editor 12:25–12:55 | — | **Retenida**: el fin persistido no está certificado |
| Federico | Bloqueo `213946678` 17:00–20:00, sin recurrencia, sin reserva online | — | Excepción fechada (alta confianza si no hay citas) |
| Federico | Almuerzo, serie diaria `201466913`: el calendario muestra 14:00–15:00 y el editor 14:00–14:30 | — | **Retenida**: duración ambigua; solo como propuesta de regla semanal |
| Federico | 6 citas visibles, todas "Reservada" | — | Cruce cita a cita en el dry-run; ninguna se escribe |
| — | — | Reservas TEST 11 h 30 min | Confirmar si son pruebas o bloqueos intencionales. No se borran ni se cancelan |

Festivos: Fresha no tiene cierres programados y la regla de festivos no está confirmada. No se
propone ningún cierre.

## 2. Sincronización existente: **no hay**

No hay código que lea ni escriba Fresha. No hay cron, cola ni registro de ejecuciones, y
tampoco columnas de id externo en citas, servicios, staff o excepciones. La documentación
lo declara: `docs/scheduling-v1.md` §1, "MT_AI es la única fuente de verdad, no se
consulta Fresha". Que algunas citas coincidan **no** indica sincronización.

**Acceso.** Esta sesión no tiene acceso a Fresha (ni cookies ni credenciales trasladadas). La
evidencia de §1 la leyó Codex en su sesión. Para un plan aplicable haría falta una exportación de
citas y bloqueos hecha por el negocio (CSV → JSON del dry-run) o la API de partners, si Fresha la
concede.

## 3. Dry-run de reconciliación (sin escrituras)

`src/scheduling/reconcile/freshaPlan.ts` (puro) + `src/scripts/freshaReconcileDryRun.ts`:

```
npx tsx src/scripts/freshaReconcileDryRun.ts --target t.json --fresha f.json --mai m.json --mapping map.json
```

- No abre base de datos ni llama a Fresha; solo imprime el plan.
- Sale con 2 si fallan el aislamiento o la identidad.

Qué garantiza:
- **Mapeo explícito de ids.** El personal sin mapear se ignora, nunca se crea.
- **Aislamiento.** Se niega a planificar si el cliente, la sede o el centro no coinciden.
- **Días locales** en `America/Bogota`.
- **Puntual frente a recurrente.** Un bloqueo puntual se convierte en excepción con fecha; una regla recurrente queda solo como propuesta de horario semanal.
- **Pausas sin verificar** quedan retenidas.
- **Claves estables** `fresha:<centro>:<tipo>:<id>`, para que el plan sea idempotente.
- **Citas.** Nunca se cancelan ni se reescriben: se reportan coincidencias, diferencias, faltantes y cancelaciones como propuestas.

Para aplicar un plan haría falta, aparte y con autorización:
- **Ids externos en excepciones.** Una migración `external_ref` única por tenant, o, como mínimo, la clave en `reason`, que es frágil.
- **Citas.** Pueden usar `idempotency_key` (único por tenant), que ya existe.

## 4. Operar Fresha y M_AI en paralelo

M_AI evita dobles reservas **entre sus propias superficies**: la restricción de exclusión
GiST, el lock por profesional y el motor compartido. **No ve las citas de Fresha.** Mientras
entren reservas por los dos sistemas, el riesgo de doble reserva es real. Opciones, de más a
menos segura:
1. **Un solo sistema reservable.** Desactivar la reserva online en uno de los dos.
2. **Bloqueos espejo.** Cada cita de Fresha entra en M_AI como excepción del profesional, vía el plan, con la frecuencia acordada. Hay un hueco entre sincronizaciones.
3. **Integración bidireccional.** Requiere la API de Fresha.

## 5. Decisiones comerciales pendientes (del negocio, no de código)

1. Ids de Falla y Federico en M_AI (lectura autorizada de producción o exportación).
2. Fin **persistido** de la pausa `214064503` y del almuerzo `201466913` de Federico.
3. Pares de servicios y qué duración/precio manda; Signature para Falla; promociones (2x1, Asesoría Gratis); Rayitos; alcance de manicura.
4. Las 5 citas de Falla y las reservas TEST: real / prueba / bloqueo. Cita `1322172783` frente a la de M_AI.
5. Antelación y horizonte de reserva (Fresha: inmediata / 5 meses; M_AI: 20 min / 30 días).
6. Modo de operación en paralelo (§4).
7. Si se decide aplicar un plan: migración de ids externos para excepciones (autorización aparte).
