-- Dashboard de valor — consultas de referencia v3 (PostgreSQL, solo lectura).
-- Parámetros (psql -v):
--   :'tenant' :'client'      ids
--   :'from'   :'to'          periodo [from, to) (timestamptz)
--   :'now'                   instante de corte para ventanas abiertas (normalmente now())
--   :'ventana'               ventana de respuesta de un turno (p. ej. '30 minutes')
--   :'tolerancia'            tolerancia del contraste ejecución ↔ mensaje (p. ej. '2 minutes')
--   :'umbral'                proporción mínima del contraste para habilitar (p. ej. 0.95)
--   :'minimo'                turnos de ejecución mínimos para juzgar un workflow (p. ej. 50)
-- Convención: un dato DESCONOCIDO es NULL, nunca 0. Un 0 significa "medido y ninguno".
-- Cada consulta tiene escenarios propios en pruebas/consultas.test.mjs.

-- ── Q0. Conversaciones del cliente (base de lo conversacional) ──────────────────────
-- conversations no tiene client_id: se llega por workflows.client_id. workflows es único
-- por (n8n_connection_id, n8n_workflow_id), no por tenant: un id que apunta a más de un
-- cliente del tenant hace la conversación AMBIGUA — se excluye y se informa.
-- Q0
WITH wf AS (
  SELECT n8n_workflow_id, count(DISTINCT client_id) AS clients, bool_or(client_id = :'client') AS mine
    FROM workflows WHERE tenant_id = :'tenant' GROUP BY n8n_workflow_id
)
SELECT count(*) FILTER (WHERE wf.mine AND wf.clients = 1) AS conversaciones_del_cliente,
       count(*) FILTER (WHERE wf.mine AND wf.clients > 1) AS conversaciones_ambiguas_excluidas
  FROM conversations c JOIN wf ON wf.n8n_workflow_id = c.n8n_workflow_id
 WHERE c.tenant_id = :'tenant';

-- ── Q1. Contraste de instrumentación (evidencia, NO cobertura completa) ─────────────
-- Dos fuentes independientes: los turnos reconstruidos de las EJECUCIONES de n8n
-- (conversation_turns; su hora es executions.started_at, el reloj de n8n) y los
-- MENSAJES reportados a la plataforma (handoff_messages). Emparejamiento UNO A UNO:
-- un turno se empareja con a lo sumo un mensaje y un mensaje con a lo sumo un turno
-- (mejor pareja mutua por cercanía en el tiempo). Esto EVITA DUPLICAR EVIDENCIA (un
-- mensaje no justifica dos turnos), pero NO garantiza que cada pareja sea la correcta:
-- dos mensajes cercanos pueden pertenecer a turnos distintos y emparejarse cruzados.
-- Es un contraste temporal APROXIMADO, que puede errar en ambos sentidos.
-- Q1
WITH wfc AS (
  SELECT n8n_workflow_id FROM workflows WHERE tenant_id = :'tenant'
   GROUP BY n8n_workflow_id HAVING count(DISTINCT client_id) = 1 AND bool_or(client_id = :'client')
), t AS (
  SELECT ct.id, ct.n8n_workflow_id, ct.turn_timestamp, ct.ai_response, c.id AS conv_id
    FROM conversation_turns ct
    JOIN wfc USING (n8n_workflow_id)
    LEFT JOIN conversations c ON c.tenant_id = ct.tenant_id AND c.n8n_workflow_id = ct.n8n_workflow_id AND c.conversation_ref = ct.conversation_id
   WHERE ct.tenant_id = :'tenant' AND ct.turn_timestamp >= :'from' AND ct.turn_timestamp < :'to'
), cand_user AS (
  SELECT t.id AS turn_id, m.id AS msg_id, abs(extract(epoch FROM m.occurred_at - t.turn_timestamp)) AS d
    FROM t JOIN handoff_messages m
      ON m.tenant_id = :'tenant' AND m.conversation_id = t.conv_id AND m.sender = 'user'
     AND m.occurred_at BETWEEN t.turn_timestamp - :'tolerancia'::interval AND t.turn_timestamp + :'tolerancia'::interval
), pair_user AS (
  SELECT turn_id FROM (
    SELECT turn_id, row_number() OVER (PARTITION BY turn_id ORDER BY d, msg_id) AS by_turn,
                    row_number() OVER (PARTITION BY msg_id ORDER BY d, turn_id) AS by_msg
      FROM cand_user) x
   WHERE by_turn = 1 AND by_msg = 1
), cand_bot AS (
  SELECT t.id AS turn_id, m.id AS msg_id, abs(extract(epoch FROM m.occurred_at - t.turn_timestamp)) AS d
    FROM t JOIN handoff_messages m
      ON m.tenant_id = :'tenant' AND m.conversation_id = t.conv_id AND m.sender = 'bot'
     AND m.occurred_at BETWEEN t.turn_timestamp - :'tolerancia'::interval AND t.turn_timestamp + :'ventana'::interval
   WHERE t.ai_response IS NOT NULL
), pair_bot AS (
  SELECT turn_id FROM (
    SELECT turn_id, row_number() OVER (PARTITION BY turn_id ORDER BY d, msg_id) AS by_turn,
                    row_number() OVER (PARTITION BY msg_id ORDER BY d, turn_id) AS by_msg
      FROM cand_bot) x
   WHERE by_turn = 1 AND by_msg = 1
)
SELECT t.n8n_workflow_id,
       count(*)                                          AS turnos_en_ejecuciones,
       count(t.conv_id)                                  AS con_conversacion_registrada,
       count(pu.turn_id)                                 AS con_mensaje_cliente_registrado,
       count(*) FILTER (WHERE t.ai_response IS NOT NULL) AS con_respuesta_en_ejecucion,
       count(pb.turn_id)                                 AS con_respuesta_bot_registrada
  FROM t
  LEFT JOIN pair_user pu ON pu.turn_id = t.id
  LEFT JOIN pair_bot  pb ON pb.turn_id = t.id
 GROUP BY t.n8n_workflow_id;

-- ── Q1b. Workflows con ejecuciones que Q1 no puede contrastar ───────────────────────
-- Dos casos distintos (mapeos de conversación en field_mappings, mapping_kind =
-- 'conversation'; un turno exige los roles conversation_id Y user_message):
--   sin_mapeos_configurados   falta alguno de los dos roles: nunca habrá turnos
--   mapeos_sin_turnos         los dos roles existen pero no se reconstruyó ningún turno
--                             (extracción fallida, ejecuciones que no son mensajes, o
--                             derivación todavía no ejecutada)
-- Filtro de tenant EXPLÍCITO en ejecuciones: executions tiene FK separadas a conexión y a
-- tenant, así que el tenant no se infiere de la conexión.
-- Q1b
WITH ex AS (
  SELECT w.n8n_workflow_id, w.name, count(e.id) AS ejecuciones
    FROM workflows w
    JOIN executions e ON e.tenant_id = w.tenant_id AND e.n8n_connection_id = w.n8n_connection_id AND e.n8n_workflow_id = w.n8n_workflow_id
   WHERE w.tenant_id = :'tenant' AND w.client_id = :'client' AND e.tenant_id = :'tenant'
     AND e.started_at >= :'from' AND e.started_at < :'to'
   GROUP BY w.n8n_workflow_id, w.name
), maps AS (
  SELECT n8n_workflow_id,
         bool_or(role = 'conversation_id') AND bool_or(role = 'user_message') AS mapeos_completos,
         array_agg(DISTINCT role ORDER BY role) AS roles
    FROM field_mappings WHERE tenant_id = :'tenant' AND mapping_kind = 'conversation'
   GROUP BY n8n_workflow_id
), turns AS (
  SELECT n8n_workflow_id, count(*) AS turnos FROM conversation_turns
   WHERE tenant_id = :'tenant' AND turn_timestamp >= :'from' AND turn_timestamp < :'to'
   GROUP BY n8n_workflow_id
)
SELECT ex.n8n_workflow_id, ex.name, ex.ejecuciones, coalesce(maps.roles, '{}') AS roles_configurados,
       CASE WHEN NOT coalesce(maps.mapeos_completos, false) THEN 'sin_mapeos_configurados' ELSE 'mapeos_sin_turnos' END AS motivo
  FROM ex
  LEFT JOIN maps USING (n8n_workflow_id)
  LEFT JOIN turns USING (n8n_workflow_id)
 WHERE coalesce(turns.turnos, 0) = 0;

-- ── Q9. ¿Hay evidencia suficiente para mostrar métricas conversacionales? ───────────
-- Parte AUTOMÁTICA de la decisión. Solo juzga workflows CONVERSACIONALES del cliente:
-- los que tienen algún mapeo de conversación o reportaron mensajes en el periodo. Un
-- workflow sin ninguna de las dos señales (p. ej. de mantenimiento) aparece como
-- no_conversacional y NO bloquea. Estados de un workflow conversacional:
--   sin_ejecuciones_para_contrastar   reportó mensajes pero no hay ejecuciones ingeridas
--   sin_mapeos_configurados · mapeos_sin_turnos   no se puede contrastar
--   muestra_insuficiente              menos de :'minimo' turnos
--   por_debajo_del_umbral             alguna proporción < :'umbral' o desconocida
--   contraste_suficiente              las tres proporciones ≥ :'umbral'
-- Proporciones NULL cuando no hay turnos que contrastar (desconocido, no 0 %).
-- `habilitable` = hay al menos un workflow conversacional y TODOS están en
-- contraste_suficiente. NO basta para mostrar: además hace falta la revisión manual
-- aprobada, que también confirma la lista de workflows conversacionales (§7).
-- Q9
WITH wfc AS (
  SELECT n8n_workflow_id FROM workflows WHERE tenant_id = :'tenant'
   GROUP BY n8n_workflow_id HAVING count(DISTINCT client_id) = 1 AND bool_or(client_id = :'client')
), ex AS (
  SELECT w.n8n_workflow_id, count(e.id) AS ejecuciones
    FROM workflows w
    JOIN executions e ON e.tenant_id = w.tenant_id AND e.n8n_connection_id = w.n8n_connection_id AND e.n8n_workflow_id = w.n8n_workflow_id
   WHERE w.tenant_id = :'tenant' AND w.client_id = :'client' AND e.tenant_id = :'tenant'
     AND e.started_at >= :'from' AND e.started_at < :'to'
   GROUP BY w.n8n_workflow_id
), maps AS (
  SELECT n8n_workflow_id, bool_or(role = 'conversation_id') AND bool_or(role = 'user_message') AS mapeos_completos
    FROM field_mappings WHERE tenant_id = :'tenant' AND mapping_kind = 'conversation'
   GROUP BY n8n_workflow_id
), reported AS (
  SELECT c.n8n_workflow_id, count(m.id) AS mensajes
    FROM conversations c JOIN wfc USING (n8n_workflow_id)
    JOIN handoff_messages m ON m.tenant_id = c.tenant_id AND m.conversation_id = c.id
   WHERE c.tenant_id = :'tenant' AND m.occurred_at >= :'from' AND m.occurred_at < :'to'
   GROUP BY c.n8n_workflow_id
), base AS (
  -- Workflows del cliente (no ambiguos) con alguna señal en el periodo o configurada.
  SELECT n8n_workflow_id FROM ex
  UNION SELECT n8n_workflow_id FROM reported
  UNION SELECT maps.n8n_workflow_id FROM maps JOIN wfc USING (n8n_workflow_id)
), t AS (
  SELECT ct.id, ct.n8n_workflow_id, ct.turn_timestamp, ct.ai_response, c.id AS conv_id
    FROM conversation_turns ct
    JOIN wfc USING (n8n_workflow_id)
    LEFT JOIN conversations c ON c.tenant_id = ct.tenant_id AND c.n8n_workflow_id = ct.n8n_workflow_id AND c.conversation_ref = ct.conversation_id
   WHERE ct.tenant_id = :'tenant' AND ct.turn_timestamp >= :'from' AND ct.turn_timestamp < :'to'
), cand_user AS (
  SELECT t.id AS turn_id, m.id AS msg_id, abs(extract(epoch FROM m.occurred_at - t.turn_timestamp)) AS d
    FROM t JOIN handoff_messages m
      ON m.tenant_id = :'tenant' AND m.conversation_id = t.conv_id AND m.sender = 'user'
     AND m.occurred_at BETWEEN t.turn_timestamp - :'tolerancia'::interval AND t.turn_timestamp + :'tolerancia'::interval
), pair_user AS (
  SELECT turn_id FROM (SELECT turn_id, row_number() OVER (PARTITION BY turn_id ORDER BY d, msg_id) AS by_turn,
                                       row_number() OVER (PARTITION BY msg_id ORDER BY d, turn_id) AS by_msg FROM cand_user) x
   WHERE by_turn = 1 AND by_msg = 1
), cand_bot AS (
  SELECT t.id AS turn_id, m.id AS msg_id, abs(extract(epoch FROM m.occurred_at - t.turn_timestamp)) AS d
    FROM t JOIN handoff_messages m
      ON m.tenant_id = :'tenant' AND m.conversation_id = t.conv_id AND m.sender = 'bot'
     AND m.occurred_at BETWEEN t.turn_timestamp - :'tolerancia'::interval AND t.turn_timestamp + :'ventana'::interval
   WHERE t.ai_response IS NOT NULL
), pair_bot AS (
  SELECT turn_id FROM (SELECT turn_id, row_number() OVER (PARTITION BY turn_id ORDER BY d, msg_id) AS by_turn,
                                       row_number() OVER (PARTITION BY msg_id ORDER BY d, turn_id) AS by_msg FROM cand_bot) x
   WHERE by_turn = 1 AND by_msg = 1
), contrast AS (
  SELECT t.n8n_workflow_id,
         count(*) AS turnos,
         count(t.conv_id)::numeric / nullif(count(*), 0) AS p_conversacion,
         count(pu.turn_id)::numeric / nullif(count(*), 0) AS p_mensaje_cliente,
         count(pb.turn_id)::numeric / nullif(count(*) FILTER (WHERE t.ai_response IS NOT NULL), 0) AS p_respuesta_bot
    FROM t LEFT JOIN pair_user pu ON pu.turn_id = t.id LEFT JOIN pair_bot pb ON pb.turn_id = t.id
   GROUP BY t.n8n_workflow_id
), per_wf AS (
  SELECT base.n8n_workflow_id, coalesce(ex.ejecuciones, 0) AS ejecuciones, coalesce(reported.mensajes, 0) AS mensajes_reportados,
         coalesce(contrast.turnos, 0) AS turnos,
         contrast.p_conversacion, contrast.p_mensaje_cliente, contrast.p_respuesta_bot,
         (maps.n8n_workflow_id IS NOT NULL OR reported.n8n_workflow_id IS NOT NULL) AS conversacional,
         CASE
           WHEN maps.n8n_workflow_id IS NULL AND reported.n8n_workflow_id IS NULL THEN 'no_conversacional'
           WHEN ex.n8n_workflow_id IS NULL THEN 'sin_ejecuciones_para_contrastar'
           WHEN NOT coalesce(maps.mapeos_completos, false) THEN 'sin_mapeos_configurados'
           WHEN coalesce(contrast.turnos, 0) = 0 THEN 'mapeos_sin_turnos'
           WHEN contrast.turnos < :'minimo'::int THEN 'muestra_insuficiente'
           WHEN contrast.p_conversacion IS NULL OR contrast.p_mensaje_cliente IS NULL OR contrast.p_respuesta_bot IS NULL
             OR least(contrast.p_conversacion, contrast.p_mensaje_cliente, contrast.p_respuesta_bot) < :'umbral'::numeric
             THEN 'por_debajo_del_umbral'
           ELSE 'contraste_suficiente' END AS estado
    FROM base
    LEFT JOIN ex USING (n8n_workflow_id) LEFT JOIN maps USING (n8n_workflow_id)
    LEFT JOIN reported USING (n8n_workflow_id) LEFT JOIN contrast USING (n8n_workflow_id)
)
SELECT n8n_workflow_id, ejecuciones, mensajes_reportados, turnos, p_conversacion, p_mensaje_cliente, p_respuesta_bot, conversacional, estado,
       (count(*) FILTER (WHERE conversacional) OVER () > 0
        AND coalesce(bool_and(estado = 'contraste_suficiente') FILTER (WHERE conversacional) OVER (), false)) AS habilitable
  FROM per_wf;

-- ── Q3. Turnos del cliente y su respuesta ───────────────────────────────────────────
-- Solo se muestra si la evidencia está habilitada (Q9 + revisión manual). Un TURNO
-- empieza en un mensaje del cliente cuyo mensaje anterior (en TODA la historia) no es del
-- cliente; termina donde empieza el siguiente. Su RESPUESTA es el primer mensaje del bot o
-- del equipo dentro del turno. Estados: bot / persona (dentro de la ventana), tardia,
-- sin_respuesta_observable (ventana vencida), en_curso (ventana abierta a :'now').
-- Mediana/p90 solo de los respondidos por el bot; NULL si no hay ninguno.
-- Q3
WITH wfc AS (
  SELECT n8n_workflow_id FROM workflows WHERE tenant_id = :'tenant'
   GROUP BY n8n_workflow_id HAVING count(DISTINCT client_id) = 1 AND bool_or(client_id = :'client')
), conv AS (
  SELECT c.id FROM conversations c JOIN wfc USING (n8n_workflow_id) WHERE c.tenant_id = :'tenant'
), msgs AS (
  SELECT m.id, m.conversation_id, m.sender, m.occurred_at,
         lag(m.sender) OVER (PARTITION BY m.conversation_id ORDER BY m.occurred_at, m.id) AS prev_sender
    FROM handoff_messages m JOIN conv ON conv.id = m.conversation_id
   WHERE m.tenant_id = :'tenant' AND m.occurred_at < :'now'
), starts AS (
  SELECT id, conversation_id, occurred_at AS start_at,
         lead(occurred_at) OVER (PARTITION BY conversation_id ORDER BY occurred_at, id) AS next_start
    FROM msgs WHERE sender = 'user' AND prev_sender IS DISTINCT FROM 'user'
), turns AS (
  SELECT s.conversation_id, s.start_at, r.sender AS first_responder, r.occurred_at AS first_reply_at
    FROM starts s
    LEFT JOIN LATERAL (
      SELECT m.sender, m.occurred_at FROM msgs m
       WHERE m.conversation_id = s.conversation_id AND m.sender <> 'user'
         AND (m.occurred_at, m.id) > (s.start_at, s.id)
         AND (s.next_start IS NULL OR m.occurred_at < s.next_start)
       ORDER BY m.occurred_at, m.id LIMIT 1
    ) r ON true
   WHERE s.start_at >= :'from' AND s.start_at < :'to'
), classified AS (
  SELECT *, CASE
      WHEN first_reply_at IS NOT NULL AND first_reply_at < start_at + :'ventana'::interval
        THEN CASE WHEN first_responder = 'bot' THEN 'bot' ELSE 'persona' END
      WHEN first_reply_at IS NOT NULL THEN 'tardia'
      WHEN start_at + :'ventana'::interval <= :'now'::timestamptz THEN 'sin_respuesta_observable'
      ELSE 'en_curso' END AS estado
    FROM turns
)
SELECT count(*)                                              AS turnos,
       count(*) FILTER (WHERE estado = 'bot')                AS respondidos_por_bot,
       count(*) FILTER (WHERE estado = 'persona')            AS respondidos_por_persona,
       count(*) FILTER (WHERE estado = 'tardia')             AS respuesta_tardia,
       count(*) FILTER (WHERE estado = 'sin_respuesta_observable') AS sin_respuesta_observable,
       count(*) FILTER (WHERE estado = 'en_curso')           AS en_curso,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_reply_at - start_at)) FILTER (WHERE estado = 'bot') AS mediana_bot_s,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_reply_at - start_at)) FILTER (WHERE estado = 'bot') AS p90_bot_s
  FROM classified;

-- ── Q2. Una clase por conversación y la UNIDAD contabilizable ───────────────────────
-- Solo se muestra si la evidencia está habilitada. Población: conversaciones con algún
-- turno que empieza en el periodo, o con una cita del BOT (origin = 'n8n') creada en el
-- periodo y ligada a ella. Dos dimensiones separadas:
--   resultado            cita del bot ligada a la conversación
--   intervención humana  mensaje del equipo en el periodo, transición a pending/human en el
--                        periodo, o la conversación ya estaba fuera del bot al empezar
-- Clase excluyente (solo U2 y U1 suman tiempo): con_intervencion_humana → u2_cita_bot →
-- en_curso → u1_respondida_por_bot → con_turnos_sin_respuesta.
-- U3 (página de reservas) sale de Q4a con origin = 'public': nunca coincide con U2.
-- Q2
WITH wfc AS (
  SELECT n8n_workflow_id FROM workflows WHERE tenant_id = :'tenant'
   GROUP BY n8n_workflow_id HAVING count(DISTINCT client_id) = 1 AND bool_or(client_id = :'client')
), conv AS (
  SELECT c.id FROM conversations c JOIN wfc USING (n8n_workflow_id) WHERE c.tenant_id = :'tenant'
), msgs AS (
  SELECT m.id, m.conversation_id, m.sender, m.occurred_at,
         lag(m.sender) OVER (PARTITION BY m.conversation_id ORDER BY m.occurred_at, m.id) AS prev_sender
    FROM handoff_messages m JOIN conv ON conv.id = m.conversation_id
   WHERE m.tenant_id = :'tenant' AND m.occurred_at < :'now'
), starts AS (
  SELECT id, conversation_id, occurred_at AS start_at,
         lead(occurred_at) OVER (PARTITION BY conversation_id ORDER BY occurred_at, id) AS next_start
    FROM msgs WHERE sender = 'user' AND prev_sender IS DISTINCT FROM 'user'
), turns AS (
  SELECT s.conversation_id, s.start_at, r.sender AS first_responder, r.occurred_at AS first_reply_at
    FROM starts s
    LEFT JOIN LATERAL (
      SELECT m.sender, m.occurred_at FROM msgs m
       WHERE m.conversation_id = s.conversation_id AND m.sender <> 'user'
         AND (m.occurred_at, m.id) > (s.start_at, s.id)
         AND (s.next_start IS NULL OR m.occurred_at < s.next_start)
       ORDER BY m.occurred_at, m.id LIMIT 1
    ) r ON true
   WHERE s.start_at >= :'from' AND s.start_at < :'to'
), classified AS (
  SELECT conversation_id, CASE
      WHEN first_reply_at IS NOT NULL AND first_reply_at < start_at + :'ventana'::interval
        THEN CASE WHEN first_responder = 'bot' THEN 'bot' ELSE 'persona' END
      WHEN first_reply_at IS NOT NULL THEN 'tardia'
      WHEN start_at + :'ventana'::interval <= :'now'::timestamptz THEN 'sin_respuesta_observable'
      ELSE 'en_curso' END AS estado
    FROM turns
), bot_appt AS (
  SELECT DISTINCT a.source_conversation_id AS conversation_id
    FROM appointments a JOIN conv ON conv.id = a.source_conversation_id
   WHERE a.tenant_id = :'tenant' AND a.client_id = :'client' AND a.origin = 'n8n'
     AND a.created_at >= :'from' AND a.created_at < :'to'
), population AS (
  SELECT conversation_id FROM classified UNION SELECT conversation_id FROM bot_appt
), facts AS (
  SELECT p.conversation_id,
         EXISTS (SELECT 1 FROM bot_appt b WHERE b.conversation_id = p.conversation_id) AS cita_bot,
         ( EXISTS (SELECT 1 FROM handoff_messages m WHERE m.tenant_id = :'tenant' AND m.conversation_id = p.conversation_id AND m.sender = 'human_agent'
                    AND m.occurred_at >= :'from' AND m.occurred_at < :'to')
        OR EXISTS (SELECT 1 FROM conversation_mode_transitions t WHERE t.tenant_id = :'tenant' AND t.conversation_id = p.conversation_id AND t.to_mode IN ('pending','human')
                    AND t.created_at >= :'from' AND t.created_at < :'to')
        OR coalesce((SELECT t.to_mode FROM conversation_mode_transitions t WHERE t.tenant_id = :'tenant' AND t.conversation_id = p.conversation_id AND t.created_at < :'from'
                      ORDER BY t.created_at DESC, t.id DESC LIMIT 1), 'bot') <> 'bot'
         ) AS intervencion_humana,
         count(cl.*)                                            AS turnos,
         count(cl.*) FILTER (WHERE cl.estado = 'bot')           AS turnos_bot,
         count(cl.*) FILTER (WHERE cl.estado = 'en_curso')      AS turnos_en_curso
    FROM population p LEFT JOIN classified cl ON cl.conversation_id = p.conversation_id
   GROUP BY p.conversation_id
), labelled AS (
  SELECT *, CASE
      WHEN intervencion_humana THEN 'con_intervencion_humana'
      WHEN cita_bot THEN 'u2_cita_bot'
      WHEN turnos_en_curso > 0 THEN 'en_curso'
      WHEN turnos > 0 AND turnos_bot = turnos THEN 'u1_respondida_por_bot'
      ELSE 'con_turnos_sin_respuesta' END AS clase
    FROM facts
)
SELECT count(*) FILTER (WHERE clase = 'con_intervencion_humana')                AS con_intervencion_humana,
       count(*) FILTER (WHERE clase = 'con_intervencion_humana' AND cita_bot)   AS con_intervencion_humana_y_cita_bot,
       count(*) FILTER (WHERE clase = 'u2_cita_bot')                            AS u2_cita_bot,
       count(*) FILTER (WHERE clase = 'en_curso')                               AS en_curso,
       count(*) FILTER (WHERE clase = 'u1_respondida_por_bot')                  AS u1_respondida_por_bot,
       count(*) FILTER (WHERE clase = 'con_turnos_sin_respuesta')               AS con_turnos_sin_respuesta
  FROM labelled;

-- ── Q4a. Reservas CREADAS en el periodo, por canal y estado ACTUAL ──────────────────
-- Una fila por (canal, estado). Actividad de reserva del periodo, no servicios realizados
-- en él. `valor` es NULL cuando ninguna cita de la fila tiene precio (desconocido); si
-- solo algunas lo tienen, `valor` es PARCIAL y `sin_precio` dice cuántas faltan. Que no
-- exista la fila significa 0 citas (medido). U3 = filas con canal 'public'.
-- Q4a
SELECT origin AS canal, status AS estado,
       count(*)                AS reservas_creadas,
       count(price_snapshot)   AS con_precio,
       count(*) - count(price_snapshot) AS sin_precio,
       sum(price_snapshot)     AS valor
  FROM appointments
 WHERE tenant_id = :'tenant' AND client_id = :'client' AND created_at >= :'from' AND created_at < :'to'
 GROUP BY origin, status;

-- ── Q4b. Servicios CON FECHA en el periodo, por canal y estado ──────────────────────
-- Para "valor de servicios completados en el periodo": la cita es del periodo por su
-- fecha (start_at). Completado ≠ cobrado (no hay pagos). Mismas reglas de NULL que Q4a.
-- Q4b
SELECT origin AS canal, status AS estado,
       count(*)                AS citas_del_periodo,
       count(price_snapshot)   AS con_precio,
       count(*) - count(price_snapshot) AS sin_precio,
       sum(price_snapshot)     AS valor
  FROM appointments
 WHERE tenant_id = :'tenant' AND client_id = :'client' AND start_at >= :'from' AND start_at < :'to'
 GROUP BY origin, status;

-- ── Q5. Reservas del bot hechas FUERA DEL HORARIO SEMANAL CONFIGURADO ───────────────
-- No considera cierres puntuales (exceptions) ni festivos. `valor`: 0 si no hay ninguna
-- reserva, NULL si las hay pero ninguna tiene precio, parcial si faltan algunos.
-- Q5
SELECT count(*) AS reservas_bot_fuera_horario_semanal,
       count(a.price_snapshot) AS con_precio,
       count(*) - count(a.price_snapshot) AS sin_precio,
       CASE WHEN count(*) = 0 THEN 0 ELSE sum(a.price_snapshot) END AS valor
  FROM appointments a JOIN sites s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
 WHERE a.tenant_id = :'tenant' AND a.client_id = :'client' AND a.origin = 'n8n'
   AND a.created_at >= :'from' AND a.created_at < :'to'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(coalesce(s.opening_hours -> (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[extract(dow FROM a.created_at AT TIME ZONE s.timezone)::int + 1], '[]'::jsonb)) r
      WHERE (a.created_at AT TIME ZONE s.timezone)::time >= (r ->> 'start')::time
        AND (a.created_at AT TIME ZONE s.timezone)::time <  (r ->> 'end')::time);

-- ── Q6. Gestiones del bot sobre citas existentes (conteo, sin minutos) ──────────────
-- Q6
SELECT e.event_type, count(*) AS gestiones
  FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id AND a.tenant_id = e.tenant_id
 WHERE e.tenant_id = :'tenant' AND a.client_id = :'client' AND e.actor_type = 'n8n'
   AND e.event_type IN ('appointment_rescheduled','appointment_cancelled','appointment_confirmed')
   AND e.created_at >= :'from' AND e.created_at < :'to'
 GROUP BY e.event_type;

-- ── Q7. Cohorte de clientes nuevos y valor de sus servicios EN EL PERIODO ───────────
-- Periodo efectivo [greatest(from, tracking_started_at), to). Sin seguimiento → ninguna
-- fila (Q7s lo explica). Valor = servicios COMPLETADOS con fecha dentro del periodo
-- efectivo, de los contactos creados en ese mismo periodo: 0 si no completaron ninguno,
-- NULL si completaron pero ninguno tiene precio, parcial si faltan algunos.
-- Q7
WITH win AS (
  SELECT greatest(:'from'::timestamptz, s.tracking_started_at) AS start_at
    FROM attribution_settings s
   WHERE s.tenant_id = :'tenant' AND s.client_id = :'client'
     AND s.tracking_started_at IS NOT NULL AND s.tracking_started_at < :'to'
)
SELECT coalesce(c.origin_kind, 'sin_origen') AS origen,
       count(DISTINCT c.id) AS clientes_nuevos,
       count(a.id) FILTER (WHERE a.status = 'completed') AS completadas,
       count(a.id) FILTER (WHERE a.status = 'completed' AND a.price_snapshot IS NULL) AS completadas_sin_precio,
       CASE WHEN count(a.id) FILTER (WHERE a.status = 'completed') = 0 THEN 0
            ELSE sum(a.price_snapshot) FILTER (WHERE a.status = 'completed') END AS valor_servicios_completados_en_periodo
  FROM win
  JOIN contacts c ON c.tenant_id = :'tenant' AND c.client_id = :'client' AND c.created_at >= win.start_at AND c.created_at < :'to'
  LEFT JOIN appointments a ON a.contact_id = c.id AND a.tenant_id = c.tenant_id AND a.client_id = c.client_id
                          AND a.start_at >= win.start_at AND a.start_at < :'to'
 GROUP BY 1;

-- Q7s: ¿desde cuándo hay seguimiento? ("seguimiento desde el 11 oct" o "sin seguimiento")
-- Q7s
SELECT tracking_started_at,
       greatest(:'from'::timestamptz, tracking_started_at) AS inicio_efectivo,
       tracking_started_at > :'from'::timestamptz AS periodo_parcial
  FROM attribution_settings WHERE tenant_id = :'tenant' AND client_id = :'client';

-- ── Q8. Salud de las automatizaciones (NO es trabajo útil) ──────────────────────────
-- Q8
SELECT count(*) AS ejecuciones,
       count(*) FILTER (WHERE e.status IN ('error','crashed')) AS con_error
  FROM executions e
  JOIN workflows w ON w.tenant_id = e.tenant_id AND w.n8n_connection_id = e.n8n_connection_id AND w.n8n_workflow_id = e.n8n_workflow_id
 WHERE e.tenant_id = :'tenant' AND w.tenant_id = :'tenant' AND w.client_id = :'client'
   AND e.started_at >= :'from' AND e.started_at < :'to';
