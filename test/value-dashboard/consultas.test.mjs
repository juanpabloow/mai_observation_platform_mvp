// Pruebas de las consultas del dashboard de valor (consultas.sql v3.1), con escenarios
// sintéticos dentro de una transacción que se deshace (ROLLBACK): nada queda escrito.
// Copia de entrega-dashboard-valor/pruebas/consultas.test.mjs; solo cambian la cabecera
// (el paquete pg sale de este repositorio y se acepta cualquier base LOCAL cuyo nombre
// termine en _test) y que el SQL llega por SQL_FILE. Lo lanza run-spec.mjs con el texto
// de src/db/repositories/valueDashboardSql.ts, el que usa el dashboard.
//
//   DATABASE_URL=postgres://…@127.0.0.1:…/algo_test SQL_FILE=/ruta.sql node --test test/value-dashboard/consultas.test.mjs
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import pg from "pg";

const { Pool } = pg;
const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
  throw new Error("Solo contra una base local de pruebas (*_test).");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
after(() => pool.end());

// ── consultas.sql → texto de cada consulta, con :'param' → $n ───────────────────────
const SQL = readFileSync(process.env.SQL_FILE ?? new URL("../../docs/value-dashboard/consultas.sql", import.meta.url), "utf8");
function query(tag) {
  const i = SQL.indexOf(`-- ${tag}\n`);
  if (i < 0) throw new Error(`No existe ${tag}`);
  return SQL.slice(i, SQL.indexOf(";", i) + 1);
}
async function run(client, tag, params) {
  const names = [];
  const text = query(tag).replace(/:'([a-z]+)'/g, (_, name) => {
    if (!names.includes(name)) names.push(name);
    return `$${names.indexOf(name) + 1}`;
  });
  const values = names.map((n) => {
    if (!(n in params)) throw new Error(`${tag}: falta el parámetro ${n}`);
    return params[n];
  });
  return (await client.query(text, values)).rows;
}

// ── Escenario base ─────────────────────────────────────────────────────────────────
const FROM = "2026-10-01T00:00:00Z";
const TO = "2026-11-01T00:00:00Z";
const ts = (s) => new Date(s).toISOString();
const plus = (iso, sec) => new Date(new Date(iso).getTime() + sec * 1000).toISOString();
const n = (v) => (v === null ? null : Number(v));

async function withScenario(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = { tenant: randomUUID(), client: randomUUID(), other: randomUUID(), conn: randomUUID(), foreignTenant: randomUUID() };
    const q = (text, values) => client.query(text, values);
    await q(`INSERT INTO tenants (id, name) VALUES ($1, 'T sintético'), ($2, 'Otro tenant')`, [ids.tenant, ids.foreignTenant]);
    await q(`INSERT INTO clients (id, tenant_id, name) VALUES ($1, $3, 'Negocio'), ($2, $3, 'Otro negocio')`, [ids.client, ids.other, ids.tenant]);
    await q(`INSERT INTO n8n_connections (id, tenant_id, name, n8n_base_url, n8n_api_key_encrypted) VALUES ($1, $2, 'c', 'http://n8n.invalid', 'x')`, [ids.conn, ids.tenant]);
    await q(
      `INSERT INTO workflows (tenant_id, n8n_connection_id, n8n_workflow_id, name, client_id)
       VALUES ($1, $2, 'wf-1', 'Bot', $3), ($1, $2, 'wf-2', 'Sin mapeos', $3), ($1, $2, 'wf-3', 'Mapeos sin turnos', $3), ($1, $2, 'wf-4', 'Mapeo incompleto', $3)`,
      [ids.tenant, ids.conn, ids.client],
    );
    const site = await q(
      `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours) VALUES ($1, $2, $3, 'Sede', 'America/Bogota', $4) RETURNING id`,
      [ids.tenant, ids.client, `s-${ids.tenant.slice(0, 8)}`, JSON.stringify({ mon: [{ start: "09:00", end: "18:00" }], tue: [{ start: "09:00", end: "18:00" }], wed: [{ start: "09:00", end: "18:00" }], thu: [{ start: "09:00", end: "18:00" }], fri: [{ start: "09:00", end: "18:00" }] })],
    );
    ids.site = site.rows[0].id;
    ids.staff = (await q(`INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, 'Ana', '{}') RETURNING id`, [ids.tenant, ids.site])).rows[0].id;
    ids.service = (await q(`INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, 'Corte', 30, 50000) RETURNING id`, [ids.tenant, ids.client])).rows[0].id;

    const s = {
      ids,
      q,
      async conv(ref, mode = "bot", wf = "wf-1") {
        return (await q(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, mode) VALUES ($1, $4, $2, $3) RETURNING id`, [ids.tenant, ref, mode, wf])).rows[0].id;
      },
      async msg(conv, sender, at) {
        await q(
          `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, agent_user_id, text, status, occurred_at) VALUES ($1, $2, $3, NULL, 'x', $4, $5)`,
          [ids.tenant, conv, sender, sender === "user" ? "received" : "sent", at],
        );
      },
      async transition(conv, from, to, at) {
        await q(`INSERT INTO conversation_mode_transitions (tenant_id, conversation_id, from_mode, to_mode, source, created_at) VALUES ($1, $2, $3, $4, 'workflow', $5)`, [ids.tenant, conv, from, to, at]);
      },
      async contact(name, createdAt, origin = null) {
        return (await q(
          `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name, created_at, origin_kind) VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6) RETURNING id`,
          [ids.tenant, ids.client, randomUUID(), name, createdAt, origin],
        )).rows[0].id;
      },
      async appt({ origin, createdAt, startAt, status = "scheduled", price = "50000", conv = null, contact = null }) {
        const end = plus(startAt, 30 * 60);
        await q(
          `INSERT INTO appointments (tenant_id, client_id, site_id, contact_id, source_conversation_id, staff_id, service_id, start_at, service_end_at,
             blocked_from, blocked_until, service_name_snapshot, duration_min_snapshot, price_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot,
             status, origin, created_by_type, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,'Corte',30,$10,0,0,$11,$12,$13,$14)`,
          [ids.tenant, ids.client, ids.site, contact, conv, ids.staff, ids.service, startAt, end, price, status, origin,
           origin === "n8n" ? "n8n" : origin === "public" ? "public" : "agent", createdAt],
        );
      },
      async exec(wf, at, tenant = ids.tenant) {
        return (await q(
          `INSERT INTO executions (tenant_id, n8n_connection_id, n8n_execution_id, n8n_workflow_id, status, started_at) VALUES ($1, $2, $3, $4, 'success', $5) RETURNING id`,
          [tenant, ids.conn, randomUUID(), wf, at],
        )).rows[0].id;
      },
      async turn(ref, at, ai, wf = "wf-1") {
        await q(
          `INSERT INTO conversation_turns (tenant_id, n8n_workflow_id, execution_id, conversation_id, user_message, ai_response, turn_timestamp) VALUES ($1, $2, $3, $4, 'hola', $5, $6)`,
          [ids.tenant, wf, await s.exec(wf, at), ref, ai, at],
        );
      },
      async mapping(wf, role) {
        await q(`INSERT INTO field_mappings (tenant_id, n8n_workflow_id, mapping_kind, role, node_name, json_path) VALUES ($1, $2, 'conversation', $3, 'Webhook', $4)`, [ids.tenant, wf, role, `$.${role}`]);
      },
      params(extra = {}) {
        return { tenant: ids.tenant, client: ids.client, from: FROM, to: TO, now: "2026-11-10T00:00:00Z", ventana: "30 minutes", tolerancia: "2 minutes", umbral: "0.95", minimo: "3", ...extra };
      },
      run: (tag, params) => run(client, tag, params),
    };
    await fn(s);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Q4a/Q4b vienen en filas (canal, estado): las suma por canal sin inventar valores. */
function byChannel(rows, countCol) {
  const out = {};
  for (const r of rows) {
    const c = (out[r.canal] ??= { citas: 0, con_precio: 0, sin_precio: 0, valor: null, porEstado: {} });
    c.citas += n(r[countCol]);
    c.con_precio += n(r.con_precio);
    c.sin_precio += n(r.sin_precio);
    if (r.valor !== null) c.valor = (c.valor ?? 0) + n(r.valor);
    c.porEstado[r.estado] = { citas: n(r[countCol]), valor: n(r.valor), sin_precio: n(r.sin_precio) };
  }
  return out;
}

// ── 1. Resultado ≠ intervención; una sola unidad; U2 solo con citas del BOT ─────────
test("Q2: cita del bot con paso a persona NO es U2; una cita manual o pública ligada no es resultado del bot", async () => {
  await withScenario(async (s) => {
    const A = await s.conv("A");
    await s.msg(A, "user", ts("2026-10-05T15:00:00Z"));
    await s.msg(A, "bot", ts("2026-10-05T15:00:10Z"));
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-05T15:01:00Z"), startAt: ts("2026-10-12T15:00:00Z"), conv: A });
    await s.transition(A, "bot", "pending", ts("2026-10-05T15:02:00Z"));
    const B = await s.conv("B");
    await s.msg(B, "user", ts("2026-10-06T15:00:00Z"));
    await s.msg(B, "bot", ts("2026-10-06T15:00:05Z"));
    await s.appt({ origin: "internal", createdAt: ts("2026-10-06T16:00:00Z"), startAt: ts("2026-10-13T15:00:00Z"), conv: B });
    const C = await s.conv("C");
    await s.msg(C, "user", ts("2026-10-07T15:00:00Z"));
    await s.msg(C, "bot", ts("2026-10-07T15:00:05Z"));
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-07T15:01:00Z"), startAt: ts("2026-10-14T15:00:00Z"), conv: C });
    await s.appt({ origin: "public", createdAt: ts("2026-10-08T15:00:00Z"), startAt: ts("2026-10-15T15:00:00Z") });

    const [r] = await s.run("Q2", s.params());
    assert.equal(n(r.con_intervencion_humana), 1, "A pasó a persona");
    assert.equal(n(r.con_intervencion_humana_y_cita_bot), 1, "A conserva el dato del resultado, sin contarse como U2");
    assert.equal(n(r.u2_cita_bot), 1, "solo C");
    assert.equal(n(r.u1_respondida_por_bot), 1, "B: la cita manual no la convierte en U2");
    assert.equal(byChannel(await s.run("Q4a", s.params()), "reservas_creadas").public.citas, 1, "U3 sale de Q4a (origin = public)");
  });
});

// ── 2. Una respuesta humana no es "sin respuesta", aunque falte la transición ───────
test("Q2/Q3: una persona respondió sin transición → intervención humana, no abandono", async () => {
  await withScenario(async (s) => {
    const D = await s.conv("D");
    await s.msg(D, "user", ts("2026-10-09T15:00:00Z"));
    await s.msg(D, "human_agent", ts("2026-10-09T15:03:00Z"));
    const E = await s.conv("E", "human");
    await s.transition(E, "bot", "human", ts("2026-09-20T12:00:00Z"));
    await s.msg(E, "user", ts("2026-10-10T15:00:00Z"));
    const [t] = await s.run("Q3", s.params());
    assert.equal(n(t.respondidos_por_persona), 1, "D");
    assert.equal(n(t.sin_respuesta_observable), 1, "solo E está de verdad sin respuesta");
    const [r] = await s.run("Q2", s.params());
    assert.equal(n(r.con_intervencion_humana), 2);
    assert.equal(n(r.con_turnos_sin_respuesta), 0);
  });
});

// ── 3. Turnos delimitados, ventana, mensaje anterior al periodo ──────────────────────
test("Q3: cada respuesta se atribuye a SU turno, dentro de su ventana", async () => {
  await withScenario(async (s) => {
    const F = await s.conv("F");
    await s.msg(F, "user", ts("2026-09-30T23:59:00Z"));
    await s.msg(F, "user", ts("2026-10-01T00:01:00Z"));
    await s.msg(F, "bot", ts("2026-10-01T00:01:30Z"));
    const G = await s.conv("G");
    await s.msg(G, "user", ts("2026-10-11T15:00:00Z"));
    await s.msg(G, "human_agent", ts("2026-10-11T15:01:00Z"));
    await s.msg(G, "bot", ts("2026-10-11T15:02:00Z"));
    const H = await s.conv("H");
    await s.msg(H, "user", ts("2026-10-12T15:00:00Z"));
    await s.msg(H, "bot", ts("2026-10-12T15:45:00Z"));
    await s.msg(H, "user", ts("2026-10-12T15:50:00Z"));
    await s.msg(H, "bot", ts("2026-10-12T15:50:10Z"));
    const J = await s.conv("J");
    await s.msg(J, "user", ts("2026-10-13T15:00:00Z"));
    const K = await s.conv("K");
    await s.msg(K, "user", ts("2026-10-31T23:59:00Z"));
    await s.msg(K, "bot", ts("2026-11-01T00:00:20Z"));
    const [t] = await s.run("Q3", s.params());
    assert.equal(n(t.turnos), 5, "F no abre turno en el periodo");
    assert.equal(n(t.respondidos_por_persona), 1, "G");
    assert.equal(n(t.respuesta_tardia), 1, "H, primer turno");
    assert.equal(n(t.respondidos_por_bot), 2, "H segundo turno (10 s) y K (80 s)");
    assert.equal(n(t.sin_respuesta_observable), 1, "J");
    assert.equal(n(t.mediana_bot_s), 45);
  });
});

test("Q3/Q2: ventana abierta = «en curso»; sin turnos del bot la mediana es desconocida, no 0", async () => {
  await withScenario(async (s) => {
    const I = await s.conv("I");
    await s.msg(I, "user", ts("2026-10-31T23:50:00Z"));
    const p = s.params({ now: "2026-10-31T23:59:00Z" });
    const [t] = await s.run("Q3", p);
    assert.equal(n(t.en_curso), 1);
    assert.equal(n(t.sin_respuesta_observable), 0);
    assert.equal(t.mediana_bot_s, null, "desconocido, nunca 0 s");
    const [r] = await s.run("Q2", p);
    assert.equal(n(r.en_curso), 1);
  });
});

// ── 4. Cohorte desde tracking_started_at y valor del periodo ────────────────────────
test("Q7: respeta tracking_started_at, suma solo el periodo y distingue 0 de desconocido", async () => {
  await withScenario(async (s) => {
    await s.q(`INSERT INTO attribution_settings (tenant_id, client_id, tracking_started_at) VALUES ($1, $2, $3)`, [s.ids.tenant, s.ids.client, ts("2026-10-11T00:00:00Z")]);
    await s.contact("X antes del seguimiento", ts("2026-10-03T12:00:00Z"), "meta_ad");
    const Y = await s.contact("Y", ts("2026-10-12T12:00:00Z"), "meta_ad");
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-12T13:00:00Z"), startAt: ts("2026-10-20T15:00:00Z"), status: "completed", price: "50000", contact: Y });
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-12T13:05:00Z"), startAt: ts("2026-11-05T15:00:00Z"), status: "completed", price: "70000", contact: Y });
    const Z = await s.contact("Z", ts("2026-10-15T12:00:00Z"), "organic_whatsapp");
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-15T13:00:00Z"), startAt: ts("2026-10-21T15:00:00Z"), status: "cancelled", contact: Z });
    const W = await s.contact("W", ts("2026-10-16T12:00:00Z"), "booking_page");
    await s.appt({ origin: "public", createdAt: ts("2026-10-16T13:00:00Z"), startAt: ts("2026-10-22T15:00:00Z"), status: "completed", price: null, contact: W });

    const rows = Object.fromEntries((await s.run("Q7", s.params())).map((x) => [x.origen, x]));
    assert.equal(n(rows.meta_ad.clientes_nuevos), 1, "X se creó antes del seguimiento");
    assert.equal(n(rows.meta_ad.valor_servicios_completados_en_periodo), 50000, "la de noviembre no es del periodo");
    assert.equal(n(rows.organic_whatsapp.valor_servicios_completados_en_periodo), 0, "no completó ninguna: 0 medido");
    assert.equal(rows.booking_page.valor_servicios_completados_en_periodo, null, "completó una sin precio: desconocido, no 0");
    assert.equal(n(rows.booking_page.completadas_sin_precio), 1);
    const [st] = await s.run("Q7s", s.params());
    assert.equal(st.periodo_parcial, true);
    assert.deepEqual(await s.run("Q7", s.params({ client: s.ids.other })), [], "sin seguimiento → sin filas");
  });
});

// ── 5. Contraste uno a uno (sin emparejamiento múltiple) ────────────────────────────
test("Q1: un mismo mensaje no sirve de evidencia para dos turnos", async () => {
  await withScenario(async (s) => {
    const A = await s.conv("ref-A");
    await s.msg(A, "user", ts("2026-10-05T15:00:00Z"));
    await s.msg(A, "bot", ts("2026-10-05T15:00:10Z"));
    const B = await s.conv("ref-B");
    await s.msg(B, "user", ts("2026-10-06T15:00:00Z"));
    await s.turn("ref-A", ts("2026-10-05T15:00:01Z"), "hola!");
    await s.turn("ref-A", ts("2026-10-05T15:00:40Z"), "¿algo más?"); // 2.º turno de ejecución: sin mensajes propios registrados
    await s.turn("ref-B", ts("2026-10-06T15:00:01Z"), "precio…");    // falta la respuesta del bot
    await s.turn("ref-zzz", ts("2026-10-07T15:00:00Z"), "ok");        // conversación nunca reportada

    const [c] = await s.run("Q1", s.params());
    assert.equal(n(c.turnos_en_ejecuciones), 4);
    assert.equal(n(c.con_conversacion_registrada), 3);
    assert.equal(n(c.con_mensaje_cliente_registrado), 2, "A (una vez) y B — el mensaje de A no cuenta para su 2.º turno");
    assert.equal(n(c.con_respuesta_en_ejecucion), 4);
    assert.equal(n(c.con_respuesta_bot_registrada), 1, "solo el primer turno de A");
  });
});

// ── 6. Q1b distingue los dos motivos; filtro explícito de tenant ────────────────────
test("Q1b: «sin mapeos configurados» ≠ «mapeos sin turnos»; ejecuciones de otro tenant no cuentan", async () => {
  await withScenario(async (s) => {
    await s.turn("ref-A", ts("2026-10-05T15:00:01Z"), "hola!");   // wf-1 tiene turnos: no aparece
    await s.exec("wf-2", ts("2026-10-08T15:00:00Z"));             // sin mapeos
    await s.mapping("wf-3", "conversation_id");
    await s.mapping("wf-3", "user_message");
    await s.exec("wf-3", ts("2026-10-08T16:00:00Z"));             // mapeos completos, sin turnos
    await s.mapping("wf-4", "conversation_id");                   // falta user_message
    await s.exec("wf-4", ts("2026-10-08T17:00:00Z"));
    await s.exec("wf-2", ts("2026-10-09T15:00:00Z"), s.ids.foreignTenant); // misma conexión, OTRO tenant

    const rows = Object.fromEntries((await s.run("Q1b", s.params())).map((x) => [x.n8n_workflow_id, x]));
    assert.deepEqual(Object.keys(rows).sort(), ["wf-2", "wf-3", "wf-4"]);
    assert.equal(rows["wf-2"].motivo, "sin_mapeos_configurados");
    assert.equal(n(rows["wf-2"].ejecuciones), 1, "la ejecución de otro tenant no se suma");
    assert.equal(rows["wf-3"].motivo, "mapeos_sin_turnos");
    assert.equal(rows["wf-4"].motivo, "sin_mapeos_configurados", "mapeo incompleto = sin mapeos utilizables");
    assert.deepEqual(rows["wf-4"].roles_configurados, ["conversation_id"]);
    const [h] = await s.run("Q8", s.params());
    assert.equal(n(h.ejecuciones), 4, "Q8 tampoco cuenta la ejecución de otro tenant");
  });
});

// ── 7. Puerta de evidencia: sin evidencia, nada se habilita y nada es 0 % ───────────
test("Q9: sin contraste suficiente las métricas conversacionales quedan deshabilitadas", async () => {
  await withScenario(async (s) => {
    for (const wf of ["wf-1"]) {
      await s.mapping(wf, "conversation_id");
      await s.mapping(wf, "user_message");
    }
    // wf-1: 3 turnos de ejecución con todo registrado → contraste_suficiente (mínimo 3).
    for (const [ref, at] of [["r1", "2026-10-05T15:00:00Z"], ["r2", "2026-10-06T15:00:00Z"], ["r3", "2026-10-07T15:00:00Z"]]) {
      const c = await s.conv(ref);
      await s.msg(c, "user", ts(at));
      await s.msg(c, "bot", plus(ts(at), 8));
      await s.turn(ref, plus(ts(at), 1), "respuesta");
    }
    let rows = Object.fromEntries((await s.run("Q9", s.params())).map((x) => [x.n8n_workflow_id, x]));
    assert.equal(rows["wf-1"].estado, "contraste_suficiente");
    assert.equal(rows["wf-1"].habilitable, true);

    // Un workflow de MANTENIMIENTO (solo ejecuciones, sin mapeos ni mensajes) no bloquea.
    await s.exec("wf-3", ts("2026-10-08T14:00:00Z"));
    rows = Object.fromEntries((await s.run("Q9", s.params())).map((x) => [x.n8n_workflow_id, x]));
    assert.equal(rows["wf-3"].estado, "no_conversacional");
    assert.equal(rows["wf-3"].conversacional, false);
    assert.equal(rows["wf-1"].habilitable, true, "el de mantenimiento no cuenta para la decisión");

    // Un workflow CONVERSACIONAL (reporta mensajes) sin mapeos sí bloquea.
    const c2 = await s.conv("x2", "bot", "wf-2");
    await s.msg(c2, "user", ts("2026-10-08T15:00:00Z"));
    await s.exec("wf-2", ts("2026-10-08T15:00:01Z"));
    rows = Object.fromEntries((await s.run("Q9", s.params())).map((x) => [x.n8n_workflow_id, x]));
    assert.equal(rows["wf-2"].estado, "sin_mapeos_configurados");
    assert.equal(rows["wf-2"].p_respuesta_bot, null, "sin turnos: proporción desconocida, nunca 0 %");
    assert.equal(rows["wf-1"].habilitable, false);

    // Muestra pequeña y respuesta no registrada.
    rows = Object.fromEntries((await s.run("Q9", s.params({ minimo: "10" }))).map((x) => [x.n8n_workflow_id, x]));
    assert.equal(rows["wf-1"].estado, "muestra_insuficiente");
  });
});

test("Q9: un workflow cuyas respuestas no quedan registradas está por debajo del umbral", async () => {
  await withScenario(async (s) => {
    await s.mapping("wf-1", "conversation_id");
    await s.mapping("wf-1", "user_message");
    for (const [ref, at] of [["r1", "2026-10-05T15:00:00Z"], ["r2", "2026-10-06T15:00:00Z"], ["r3", "2026-10-07T15:00:00Z"]]) {
      const c = await s.conv(ref);
      await s.msg(c, "user", ts(at));
      await s.turn(ref, plus(ts(at), 1), "respuesta"); // la ejecución respondió; el mensaje del bot no se reportó
    }
    const [r] = await s.run("Q9", s.params());
    assert.equal(r.estado, "por_debajo_del_umbral");
    assert.equal(n(r.p_respuesta_bot), 0, "medido: 0 de 3 (aquí 0 sí es un dato)");
    assert.equal(r.habilitable, false);
  });
});

test("Q9: si las ejecuciones no capturan la respuesta, su proporción es desconocida (no 0 %) y no se habilita", async () => {
  await withScenario(async (s) => {
    await s.mapping("wf-1", "conversation_id");
    await s.mapping("wf-1", "user_message"); // sin mapeo ai_response
    for (const [ref, at] of [["r1", "2026-10-05T15:00:00Z"], ["r2", "2026-10-06T15:00:00Z"], ["r3", "2026-10-07T15:00:00Z"]]) {
      const c = await s.conv(ref);
      await s.msg(c, "user", ts(at));
      await s.msg(c, "bot", plus(ts(at), 8));
      await s.turn(ref, plus(ts(at), 1), null);
    }
    const [r] = await s.run("Q9", s.params());
    assert.equal(r.p_respuesta_bot, null, "no hay respuestas en las ejecuciones con qué contrastar");
    assert.equal(n(r.p_mensaje_cliente), 1);
    assert.equal(r.estado, "por_debajo_del_umbral", "evidencia incompleta: no se habilita");
    assert.equal(r.habilitable, false);
  });
});

test("Q9: un cliente sin ejecuciones ni mensajes no es habilitable (no hay filas que lo respalden)", async () => {
  await withScenario(async (s) => {
    assert.deepEqual(await s.run("Q9", s.params()), []);
  });
});

test("Q9: mensajes reportados sin ejecuciones que contrastar bloquean; solo mantenimiento no habilita", async () => {
  await withScenario(async (s) => {
    const c = await s.conv("solo-mensajes");
    await s.msg(c, "user", ts("2026-10-05T15:00:00Z"));
    await s.msg(c, "bot", ts("2026-10-05T15:00:05Z"));
    let [r] = await s.run("Q9", s.params());
    assert.equal(r.estado, "sin_ejecuciones_para_contrastar");
    assert.equal(r.habilitable, false);
  });
  await withScenario(async (s) => {
    await s.exec("wf-3", ts("2026-10-08T14:00:00Z")); // solo mantenimiento
    const [r] = await s.run("Q9", s.params());
    assert.equal(r.estado, "no_conversacional");
    assert.equal(r.habilitable, false, "sin ningún workflow conversacional no hay nada que habilitar");
  });
});

// ── 8. Reservas del periodo vs. servicios del periodo; desconocido ≠ 0 ───────────────
test("Q4a cuenta reservas CREADAS; Q4b servicios CON FECHA; sin precio = desconocido", async () => {
  await withScenario(async (s) => {
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-20T15:00:00Z"), startAt: ts("2026-11-04T15:00:00Z"), price: "40000" });
    await s.appt({ origin: "n8n", createdAt: ts("2026-09-25T15:00:00Z"), startAt: ts("2026-10-05T15:00:00Z"), status: "completed", price: "60000" });
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-21T15:00:00Z"), startAt: ts("2026-10-22T15:00:00Z"), status: "completed", price: null });
    await s.appt({ origin: "public", createdAt: ts("2026-10-21T16:00:00Z"), startAt: ts("2026-10-23T15:00:00Z"), status: "no_show", price: null });

    const a = byChannel(await s.run("Q4a", s.params()), "reservas_creadas");
    assert.equal(a.n8n.citas, 2);
    assert.equal(a.n8n.valor, 40000, "parcial: hay una sin precio");
    assert.equal(a.n8n.sin_precio, 1);
    assert.equal(a.n8n.porEstado.completed.valor, null, "completada sin precio: desconocido, no 0");
    assert.equal(a.public.valor, null, "ningún precio en el canal: desconocido");
    const b = byChannel(await s.run("Q4b", s.params()), "citas_del_periodo");
    assert.equal(b.n8n.porEstado.completed.citas, 2);
    assert.equal(b.n8n.porEstado.completed.valor, 60000, "la reservada en septiembre y atendida en octubre (parcial)");
    assert.equal(b.n8n.porEstado.completed.sin_precio, 1);
  });
});

test("Q5: sin reservas es 0 medido; con reservas sin precio es desconocido", async () => {
  await withScenario(async (s) => {
    const [none] = await s.run("Q5", s.params());
    assert.equal(n(none.reservas_bot_fuera_horario_semanal), 0);
    assert.equal(n(none.valor), 0, "ninguna reserva: 0 medido");
    // Sábado 10 oct 2026, 11:00 en Bogotá: fuera del horario semanal (lun–vie).
    await s.appt({ origin: "n8n", createdAt: ts("2026-10-10T16:00:00Z"), startAt: ts("2026-10-14T15:00:00Z"), price: null });
    const [one] = await s.run("Q5", s.params());
    assert.equal(n(one.reservas_bot_fuera_horario_semanal), 1);
    assert.equal(one.valor, null, "una reserva sin precio: desconocido, no 0");
  });
});
