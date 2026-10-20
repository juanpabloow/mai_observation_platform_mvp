# Pruebas de mutación: cada entrada reintroduce un error señalado en la revisión.
# Uso: python3 mutaciones.py ORIGEN.sql DIR_SALIDA (lo lanza run-spec.mjs).
# Cada mutación debe hacer fallar al menos una prueba.
import json,sys
s=open(sys.argv[1]).read()
M = {
 "01_cita_no_n8n": [("WHERE a.tenant_id = :'tenant' AND a.client_id = :'client' AND a.origin = 'n8n'\n     AND a.created_at >= :'from' AND a.created_at < :'to'\n), population", "WHERE a.tenant_id = :'tenant' AND a.client_id = :'client'\n     AND a.created_at >= :'from' AND a.created_at < :'to'\n), population")],
 "02_resultado_antes_que_persona": [("      WHEN intervencion_humana THEN 'con_intervencion_humana'\n      WHEN cita_bot THEN 'u2_cita_bot'", "      WHEN cita_bot THEN 'u2_cita_bot'\n      WHEN intervencion_humana THEN 'con_intervencion_humana'")],
 "03_sin_mensajes_equipo": [("m.conversation_id = p.conversation_id AND m.sender = 'human_agent'", "false AND m.sender = 'human_agent'")],
 "04_lag_solo_periodo": [("WHERE m.tenant_id = :'tenant' AND m.occurred_at < :'now'", "WHERE m.tenant_id = :'tenant' AND m.occurred_at >= :'from' AND m.occurred_at < :'now'")],
 "05_cualquier_bot_posterior": [("       WHERE m.conversation_id = s.conversation_id AND m.sender <> 'user'\n         AND (m.occurred_at, m.id) > (s.start_at, s.id)\n         AND (s.next_start IS NULL OR m.occurred_at < s.next_start)", "       WHERE m.conversation_id = s.conversation_id AND m.sender = 'bot'\n         AND (m.occurred_at, m.id) > (s.start_at, s.id)")],
 "06_sin_ventana": [("WHEN first_reply_at IS NOT NULL AND first_reply_at < start_at + :'ventana'::interval", "WHEN first_reply_at IS NOT NULL")],
 "07_ignora_tracking": [("SELECT greatest(:'from'::timestamptz, s.tracking_started_at) AS start_at\n    FROM attribution_settings s", "SELECT :'from'::timestamptz AS start_at\n    FROM attribution_settings s")],
 "08_citas_de_cualquier_fecha": [("                          AND a.start_at >= win.start_at AND a.start_at < :'to'", "")],
 "09_q4b_por_creacion": [(" WHERE tenant_id = :'tenant' AND client_id = :'client' AND start_at >= :'from' AND start_at < :'to'", " WHERE tenant_id = :'tenant' AND client_id = :'client' AND created_at >= :'from' AND created_at < :'to'")],
 "10_q1_emparejamiento_multiple": [("   WHERE by_turn = 1 AND by_msg = 1\n), cand_bot", "   WHERE by_turn = 1\n), cand_bot"), ("   WHERE by_turn = 1 AND by_msg = 1\n)\nSELECT t.n8n_workflow_id", "   WHERE by_turn = 1\n)\nSELECT t.n8n_workflow_id")],
 "11_q1b_un_solo_motivo": [("CASE WHEN NOT coalesce(maps.mapeos_completos, false) THEN 'sin_mapeos_configurados' ELSE 'mapeos_sin_turnos' END AS motivo", "'sin_turnos' AS motivo")],
 "12_q1b_sin_filtro_tenant": [("    JOIN executions e ON e.tenant_id = w.tenant_id AND e.n8n_connection_id = w.n8n_connection_id AND e.n8n_workflow_id = w.n8n_workflow_id\n   WHERE w.tenant_id = :'tenant' AND w.client_id = :'client' AND e.tenant_id = :'tenant'\n     AND e.started_at >= :'from' AND e.started_at < :'to'\n   GROUP BY w.n8n_workflow_id, w.name", "    JOIN executions e ON e.n8n_connection_id = w.n8n_connection_id AND e.n8n_workflow_id = w.n8n_workflow_id\n   WHERE w.tenant_id = :'tenant' AND w.client_id = :'client'\n     AND e.started_at >= :'from' AND e.started_at < :'to'\n   GROUP BY w.n8n_workflow_id, w.name")],
 "13_q8_sin_filtro_tenant": [("  JOIN workflows w ON w.tenant_id = e.tenant_id AND w.n8n_connection_id = e.n8n_connection_id AND w.n8n_workflow_id = e.n8n_workflow_id\n WHERE e.tenant_id = :'tenant' AND w.tenant_id = :'tenant' AND w.client_id = :'client'", "  JOIN workflows w ON w.n8n_connection_id = e.n8n_connection_id AND w.n8n_workflow_id = e.n8n_workflow_id\n WHERE w.tenant_id = :'tenant' AND w.client_id = :'client'")],
 "14_q4_desconocido_como_cero": [("       sum(price_snapshot)     AS valor\n  FROM appointments\n WHERE tenant_id = :'tenant' AND client_id = :'client' AND created_at", "       coalesce(sum(price_snapshot), 0) AS valor\n  FROM appointments\n WHERE tenant_id = :'tenant' AND client_id = :'client' AND created_at")],
 "15_q5_desconocido_como_cero": [("CASE WHEN count(*) = 0 THEN 0 ELSE sum(a.price_snapshot) END AS valor", "coalesce(sum(a.price_snapshot), 0) AS valor")],
 "16_q7_desconocido_como_cero": [("CASE WHEN count(a.id) FILTER (WHERE a.status = 'completed') = 0 THEN 0\n            ELSE sum(a.price_snapshot) FILTER (WHERE a.status = 'completed') END", "coalesce(sum(a.price_snapshot) FILTER (WHERE a.status = 'completed'), 0)")],
 "17_q9_proporcion_desconocida_como_cero": [("count(pb.turn_id)::numeric / nullif(count(*) FILTER (WHERE t.ai_response IS NOT NULL), 0) AS p_respuesta_bot", "coalesce(count(pb.turn_id)::numeric / nullif(count(*) FILTER (WHERE t.ai_response IS NOT NULL), 0), 0) AS p_respuesta_bot")],
 "18_q9_ignora_otros_workflows": [("(count(*) FILTER (WHERE conversacional) OVER () > 0\n        AND coalesce(bool_and(estado = 'contraste_suficiente') FILTER (WHERE conversacional) OVER (), false)) AS habilitable", "(estado = 'contraste_suficiente') AS habilitable")],
 "19_q9_cuenta_no_conversacionales": [("(count(*) FILTER (WHERE conversacional) OVER () > 0\n        AND coalesce(bool_and(estado = 'contraste_suficiente') FILTER (WHERE conversacional) OVER (), false)) AS habilitable", "(count(*) OVER () > 0 AND bool_and(estado = 'contraste_suficiente') OVER ()) AS habilitable")],
 "20_q9_sin_exigir_ejecuciones": [("           WHEN ex.n8n_workflow_id IS NULL THEN 'sin_ejecuciones_para_contrastar'\n", "")],
}
out=sys.argv[2]
for name, reps in M.items():
    t=s
    for a,b in reps:
        assert a in t, (name, a[:60])
        t=t.replace(a,b)
    open(f"{out}/{name}.sql","w").write(t)
print(len(M))
