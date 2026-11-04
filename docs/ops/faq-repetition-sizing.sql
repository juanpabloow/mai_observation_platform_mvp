-- ============================================================================
-- Medición de repetición de preguntas del bot de WhatsApp (caché semántica)
--
-- Pregunta: ¿qué parte de los turnos entrantes son preguntas tipo FAQ
-- (ubicación, horario, precios, servicios, medios de pago), cuántas se repiten
-- literalmente entre conversaciones y cuánto tarda hoy el bot en responder?
-- Contexto y lectura: docs/cache-semantica-bot-whatsapp.md.
--
-- SOLO LECTURA. Todo corre dentro de BEGIN READ ONLY … ROLLBACK y aborta si la
-- sesión no está en solo lectura. No crea tablas (ni temporales).
--
-- Unidad de medida = TURNO: los mensajes seguidos del cliente sin respuesta en
-- medio. El workflow espera 7 s y combina la ráfaga en una sola llamada al
-- agente, así que el turno es lo que una caché tendría que responder.
--
-- Salida: solo agregados. La sección top_texto muestra frases normalizadas
-- únicamente si aparecen en >= 5 conversaciones distintas, sin dígitos y con
-- <= 60 caracteres (p. ej. «hola», «donde quedan»). Aun así, el archivo de
-- salida va FUERA del repositorio (el repositorio es público).
--
-- Clasificación: expresiones regulares en español sobre texto en minúsculas y
-- sin tildes. Es una aproximación: sirve para dimensionar, no para responder.
-- Las conversaciones de prueba del equipo no tienen marca y quedan incluidas.
--
-- Ejecución (mismo patrón que run-gallery-identity-diagnostic.sh):
--   read -rs DIAG_DATABASE_URL; export DIAG_DATABASE_URL
--   docker run --rm -i --pull never -e DIAG_DATABASE_URL \
--     -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s' \
--     postgres:16 sh -c 'exec psql "$DIAG_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
--       -v since="2026-08-01 00:00:00-05" -v client_id="6790e355-9048-47d0-99c2-7822419aa526" -f -' \
--     < docs/ops/faq-repetition-sizing.sql > ~/faq-sizing-$(date +%F).tsv
-- Variables: since (inicio de la ventana) y client_id (por defecto Gallery).
-- ============================================================================
\set ON_ERROR_STOP 1
\pset format unaligned
\pset fieldsep '\t'
\pset footer off
\if :{?since}
\else
  \set since '2026-08-01 00:00:00-05'
\endif
\if :{?client_id}
\else
  \set client_id '6790e355-9048-47d0-99c2-7822419aa526'
\endif

BEGIN READ ONLY;
DO $$ BEGIN
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'la sesión no está en solo lectura; abortando';
  END IF;
END $$;

WITH params AS (
  SELECT :'since'::timestamptz AS since, :'client_id'::uuid AS client_id
),
conv AS (
  SELECT c.id
    FROM conversations c, params p
   WHERE EXISTS (SELECT 1 FROM workflows w
                  WHERE w.tenant_id = c.tenant_id
                    AND w.n8n_workflow_id = c.n8n_workflow_id
                    AND w.client_id = p.client_id)
),
msg AS (
  -- created_at = hora de registro en la plataforma (occurred_at lo fija el caller)
  SELECT m.id, m.conversation_id AS cid, m.sender, m.content_type, m.text, m.created_at,
         sum(CASE WHEN m.sender <> 'user' THEN 1 ELSE 0 END)
           OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS grp
    FROM handoff_messages m
    JOIN conv ON conv.id = m.conversation_id, params p
   WHERE m.created_at >= p.since
     AND (m.sender <> 'human_agent' OR m.status = 'sent')
),
turn AS (
  SELECT cid, grp,
         min(created_at) AS first_at, max(created_at) AS last_at, count(*) AS n_msgs,
         bool_or(content_type <> 'text') AS has_media,
         btrim(regexp_replace(regexp_replace(
           translate(lower(string_agg(coalesce(text, ''), ' ' ORDER BY created_at, id)),
                     'áéíóúüñ¿¡', 'aeiouun  '),
           '[^a-z0-9$ ]', ' ', 'g'), '\s+', ' ', 'g')) AS norm
    FROM msg WHERE sender = 'user'
   GROUP BY cid, grp
),
reply AS (
  -- la primera respuesta (bot o humano) después de cada turno
  SELECT cid, grp, sender, created_at FROM msg WHERE sender <> 'user'
),
flag AS (
  SELECT t.*,
    row_number() OVER (PARTITION BY t.cid ORDER BY t.first_at) AS turn_no,
    t.norm ~ '^(hola|ola|holi|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|hello|que tal|como estas|como estan)( (hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|como estas|como estan))*$' AS saludo,
    t.norm ~ '^(gracias|muchas gracias|mil gracias|ok|okay|oki|listo|dale|perfecto|vale|bueno|si|no|super|genial|de una|claro|entendido|excelente)( (gracias|muchas gracias|listo|perfecto|dale|ok|si))*$' AS cortesia,
    t.norm ~ '\m(direccion|ubicacion|ubicados|ubicadas|ubicado|ubican|parqueadero|parqueo|parquear|maps|waze|sede|sedes|barrio)\M|\mdonde (queda|quedan|estan|es|esta|los encuentro|las encuentro)\M|\mcomo (llego|llegar)\M' AS ubicacion,
    t.norm ~ '\m(horario|horarios|abren|abierto|abiertos|cierran|cierra|domingo|domingos|festivo|festivos|feriado)\M|\ma que hora (abren|cierran|atienden)\M|\matienden\M' AS horario,
    t.norm ~ '\m(precio|precios|cuanto|valor|vale|cuesta|cuestan|costo|tarifa|tarifas|cobran)\M|\$' AS precio,
    t.norm ~ '\m(servicio|servicios|incluye|incluyen|menu|catalogo|ofrecen|manejan)\M|\mque (hacen|tienen)\M' AS servicios,
    t.norm ~ '\m(datafono|tarjeta|tarjetas|nequi|daviplata|efectivo|transferencia|pse|breb|pago|pagos|pagar)\M|\mbre b\M' AS pagos,
    t.norm ~ '\m(producto|productos|cera|pomada|aceite|balsamo|shampoo)\M' AS productos,
    t.norm ~ '\m(cita|citas|agendar|agenda|agendo|agendame|reservar|reserva|reservo|turno|espacio|espacios|cupo|cupos|disponible|disponibles|disponibilidad|libre|hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|am|pm)\M|\ma las [0-9]|\mpuedo ir\M' AS reserva,
    t.norm ~ '\m(cancelar|cancela|cancelo|cancelame|reprogramar|reprogramo|mover|moverla|cambiar|correr|retraso|tarde)\M' AS gestion,
    t.norm ~ '\m(asesor|asesora|humano|persona|alguien)\M|\mhablar con\M' AS humano
    FROM turn t
),
cls AS (
  SELECT f.*,
    (f.ubicacion OR f.horario OR f.precio OR f.servicios OR f.pagos OR f.productos) AS faq,
    CASE
      WHEN f.norm = '' THEN 'sin_texto'
      WHEN f.humano THEN 'pide_humano'
      WHEN (f.ubicacion OR f.horario OR f.precio OR f.servicios OR f.pagos OR f.productos)
           AND NOT (f.reserva OR f.gestion) THEN 'faq_estatica'
      WHEN (f.ubicacion OR f.horario OR f.precio OR f.servicios OR f.pagos OR f.productos) THEN 'faq_con_reserva'
      WHEN f.gestion THEN 'gestion_cita'
      WHEN f.reserva THEN 'reserva_disponibilidad'
      WHEN f.saludo OR f.cortesia THEN 'saludo_cortesia'
      ELSE 'otro'
    END AS clase,
    (SELECT r.sender FROM reply r WHERE r.cid = f.cid AND r.grp = f.grp + 1 LIMIT 1) AS reply_sender,
    (SELECT extract(epoch FROM r.created_at - f.last_at) FROM reply r
      WHERE r.cid = f.cid AND r.grp = f.grp + 1 LIMIT 1) AS reply_s
    FROM flag f
),
tot AS (
  SELECT count(*)::numeric AS turns, count(DISTINCT cid)::numeric AS convs FROM cls
),
norm_convs AS (
  SELECT norm, count(DISTINCT cid) AS convs, count(*) AS turns, min(clase) AS clase
    FROM cls WHERE norm <> '' GROUP BY norm
),
reel AS (
  -- Clave del reel (api.py): "chat:" + texto.strip(" ¿?").lower(), POR MENSAJE, sin
  -- negocio, conversación ni historial. Se calcula aquí solo para medir su tasa de acierto.
  SELECT m.cid, lower(btrim(m.text, ' ¿?')) AS k,
         lower(btrim(m.text, ' ¿?')) ~ '^(hola|ola|holi|buenas|buen dia|buen día|buenos dias|buenos días|buenas tardes|buenas noches|hey|gracias|muchas gracias|ok|okay|oki|listo|dale|perfecto|vale|bueno|si|sí|no|super|súper|genial|de una|claro|entendido|excelente)[!. ]*$' AS trivial
         , t.clase
    FROM msg m
    JOIN cls t ON t.cid = m.cid AND t.grp = m.grp
   WHERE m.sender = 'user' AND m.content_type = 'text' AND coalesce(btrim(m.text, ' ¿?'), '') <> ''
),
reel_keys AS (
  SELECT k, bool_and(trivial) AS trivial, bool_and(clase = 'faq_estatica') AS faq,
         count(DISTINCT cid) AS convs, count(*) AS msgs FROM reel GROUP BY k
),
conv_profile AS (
  SELECT cid,
         bool_and(clase IN ('faq_estatica', 'saludo_cortesia', 'sin_texto')) AS solo_faq,
         bool_or(faq) AS toca_faq,
         bool_or(reserva OR gestion) AS toca_reserva
    FROM cls GROUP BY cid
),
out AS (
  -- 0. contexto
  SELECT 0 AS ord, 'contexto' AS seccion, 'base' AS clave, current_database() AS n, NULL::numeric AS pct
  UNION ALL SELECT 0, 'contexto', 'desde', (SELECT since::text FROM params), NULL
  UNION ALL SELECT 0, 'contexto', 'solo_lectura', current_setting('transaction_read_only'), NULL
  -- 1. volumen
  UNION ALL SELECT 1, 'volumen', 'conversaciones', convs::text, NULL FROM tot
  UNION ALL SELECT 1, 'volumen', 'turnos_cliente', turns::text, NULL FROM tot
  UNION ALL SELECT 1, 'volumen', 'mensajes_cliente', (SELECT count(*)::text FROM msg WHERE sender = 'user'), NULL
  UNION ALL SELECT 1, 'volumen', 'mensajes_bot', (SELECT count(*)::text FROM msg WHERE sender = 'bot'), NULL
  UNION ALL SELECT 1, 'volumen', 'mensajes_humano_enviados', (SELECT count(*)::text FROM msg WHERE sender = 'human_agent'), NULL
  UNION ALL SELECT 1, 'volumen', 'turnos_con_adjunto', count(*)::text, round(100 * count(*) / nullif((SELECT turns FROM tot), 0), 1) FROM cls WHERE has_media
  UNION ALL SELECT 1, 'volumen', 'turnos_por_semana',
         round((SELECT turns FROM tot) / greatest(extract(epoch FROM now() - (SELECT since FROM params)) / 604800, 1), 1)::text, NULL
  UNION ALL SELECT 1, 'volumen', 'turnos_respondidos_por_bot', count(*)::text, round(100 * count(*) / nullif((SELECT turns FROM tot), 0), 1) FROM cls WHERE reply_sender = 'bot'
  -- 2. temas (multi-etiqueta: un turno puede tocar varios)
  UNION ALL SELECT 2, 'tema_turnos', k, n::text, round(100 * n / nullif((SELECT turns FROM tot), 0), 1)
    FROM (SELECT 'ubicacion' k, count(*) FILTER (WHERE ubicacion) n FROM cls
          UNION ALL SELECT 'horario', count(*) FILTER (WHERE horario) FROM cls
          UNION ALL SELECT 'precio', count(*) FILTER (WHERE precio) FROM cls
          UNION ALL SELECT 'servicios', count(*) FILTER (WHERE servicios) FROM cls
          UNION ALL SELECT 'pagos', count(*) FILTER (WHERE pagos) FROM cls
          UNION ALL SELECT 'productos', count(*) FILTER (WHERE productos) FROM cls
          UNION ALL SELECT 'reserva', count(*) FILTER (WHERE reserva) FROM cls
          UNION ALL SELECT 'gestion', count(*) FILTER (WHERE gestion) FROM cls
          UNION ALL SELECT 'humano', count(*) FILTER (WHERE humano) FROM cls
          UNION ALL SELECT 'saludo_solo', count(*) FILTER (WHERE saludo) FROM cls
          UNION ALL SELECT 'cortesia_sola', count(*) FILTER (WHERE cortesia) FROM cls) x
  UNION ALL SELECT 3, 'tema_conversaciones', k, n::text, round(100 * n / nullif((SELECT convs FROM tot), 0), 1)
    FROM (SELECT 'ubicacion' k, count(DISTINCT cid) FILTER (WHERE ubicacion) n FROM cls
          UNION ALL SELECT 'horario', count(DISTINCT cid) FILTER (WHERE horario) FROM cls
          UNION ALL SELECT 'precio', count(DISTINCT cid) FILTER (WHERE precio) FROM cls
          UNION ALL SELECT 'servicios', count(DISTINCT cid) FILTER (WHERE servicios) FROM cls
          UNION ALL SELECT 'pagos', count(DISTINCT cid) FILTER (WHERE pagos) FROM cls
          UNION ALL SELECT 'reserva', count(DISTINCT cid) FILTER (WHERE reserva) FROM cls) x
  -- 3. clase exclusiva del turno
  UNION ALL SELECT 4, 'clase_turno', clase, count(*)::text, round(100 * count(*) / nullif((SELECT turns FROM tot), 0), 1)
    FROM cls GROUP BY clase
  UNION ALL SELECT 5, 'clase_primer_turno', clase, count(*)::text, round(100 * count(*) / nullif((SELECT convs FROM tot), 0), 1)
    FROM cls WHERE turn_no = 1 GROUP BY clase
  -- 4. perfil de conversación
  UNION ALL SELECT 6, 'conversaciones', 'solo_faq_o_saludo', count(*) FILTER (WHERE solo_faq)::text,
         round(100 * count(*) FILTER (WHERE solo_faq) / nullif(count(*), 0), 1) FROM conv_profile
  UNION ALL SELECT 6, 'conversaciones', 'toca_faq', count(*) FILTER (WHERE toca_faq)::text,
         round(100 * count(*) FILTER (WHERE toca_faq) / nullif(count(*), 0), 1) FROM conv_profile
  UNION ALL SELECT 6, 'conversaciones', 'toca_faq_y_reserva', count(*) FILTER (WHERE toca_faq AND toca_reserva)::text,
         round(100 * count(*) FILTER (WHERE toca_faq AND toca_reserva) / nullif(count(*), 0), 1) FROM conv_profile
  -- 5. techo de una caché EXACTA: turnos cuyo texto normalizado aparece en otras conversaciones
  UNION ALL SELECT 7, 'repeticion_exacta', 'textos_distintos', count(*)::text, NULL FROM norm_convs
  UNION ALL SELECT 7, 'repeticion_exacta', 'turnos_texto_en_2+_conversaciones', coalesce(sum(turns), 0)::text,
         round(100 * coalesce(sum(turns), 0) / nullif((SELECT turns FROM tot), 0), 1) FROM norm_convs WHERE convs >= 2
  UNION ALL SELECT 7, 'repeticion_exacta', 'turnos_faq_estatica_texto_en_2+_conversaciones', coalesce(sum(turns), 0)::text,
         round(100 * coalesce(sum(turns), 0) / nullif((SELECT turns FROM tot), 0), 1) FROM norm_convs WHERE convs >= 2 AND clase = 'faq_estatica'
  -- 5b. la caché del reel, global y sin TTL: cada repetición de una clave ya vista
  --     (en cualquier conversación) sería un acierto => aciertos = mensajes - claves.
  --     Aciertos en «hola», «sí», «ok» no ahorran nada útil y son peligrosos: «sí»
  --     confirma cosas distintas en cada conversación.
  UNION ALL SELECT 7, 'cache_reel_exacta', 'mensajes_texto', (SELECT count(*)::text FROM reel), NULL
  UNION ALL SELECT 7, 'cache_reel_exacta', 'claves_distintas', count(*)::text, NULL FROM reel_keys
  UNION ALL SELECT 7, 'cache_reel_exacta', 'aciertos_totales', coalesce(sum(msgs - 1), 0)::text,
         round(100 * coalesce(sum(msgs - 1), 0) / nullif((SELECT count(*) FROM reel), 0), 1) FROM reel_keys
  UNION ALL SELECT 7, 'cache_reel_exacta', 'aciertos_saludo_o_cortesia', coalesce(sum(msgs - 1), 0)::text,
         round(100 * coalesce(sum(msgs - 1), 0) / nullif((SELECT count(*) FROM reel), 0), 1) FROM reel_keys WHERE trivial
  UNION ALL SELECT 7, 'cache_reel_exacta', 'aciertos_no_triviales', coalesce(sum(msgs - 1), 0)::text,
         round(100 * coalesce(sum(msgs - 1), 0) / nullif((SELECT count(*) FROM reel), 0), 1) FROM reel_keys WHERE NOT trivial
  -- solo las que serían seguras de reutilizar: su turno es faq_estatica (sin cupo, fecha ni cita)
  UNION ALL SELECT 7, 'cache_reel_exacta', 'aciertos_faq_estatica', coalesce(sum(msgs - 1), 0)::text,
         round(100 * coalesce(sum(msgs - 1), 0) / nullif((SELECT count(*) FROM reel), 0), 1) FROM reel_keys WHERE NOT trivial AND faq
  -- 6. latencia actual (registro del último mensaje del turno → registro de la respuesta del bot)
  UNION ALL SELECT 8, 'latencia_bot_s', coalesce(k, 'todas'), round(p50::numeric, 1)::text, round(p90::numeric, 1)
    FROM (SELECT k,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY reply_s) AS p50,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY reply_s) AS p90
            FROM (SELECT CASE WHEN clase = 'faq_estatica' THEN 'faq_estatica' ELSE 'resto' END AS k, reply_s
                    FROM cls WHERE reply_sender = 'bot' AND reply_s BETWEEN 0 AND 600) y
           GROUP BY ROLLUP (k)) x
  -- 7. frases genéricas más repetidas (k-anonimato: >= 5 conversaciones, sin dígitos)
  UNION ALL SELECT 9, 'top_texto', norm || '  [' || clase || ']', convs::text, turns
    FROM (SELECT * FROM norm_convs
           WHERE convs >= 5 AND char_length(norm) <= 60 AND norm !~ '[0-9]'
           ORDER BY convs DESC, norm LIMIT 25) x
)
SELECT seccion, clave, n AS valor, pct AS "pct_o_p90_o_turnos" FROM out ORDER BY ord, seccion, pct DESC NULLS LAST, clave;

ROLLBACK;
