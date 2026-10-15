// Pruebas de INTEGRACION del emisor (logic.ts) contra la Postgres LOCAL con B1+B2+B3 reales y un MOCK de Resend (127.0.0.1).
// Nada toca produccion ni Resend real. Requiere: PAGOS_FASE_B_DIR=<carpeta con 00_stub_local.sql, seed.sql, B1/B2/B3, reset_local.sh>
// y la Postgres local levantada en /var/tmp/pgproof (ver run-integracion.sh).
process.env.TZ = 'America/Santiago';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, safeLog, clasificarResend } from '../logic.ts';

const DIR = process.env.PAGOS_FASE_B_DIR;
if (!DIR) { console.error('Falta PAGOS_FASE_B_DIR'); process.exit(2); }
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- acceso a la BD local ----------
function psql(sql) {
  return new Promise((res) => {
    const p = spawn('su', ['postgres', '-c', '/var/tmp/pgproof/q.sh t']); let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', () => res({ out: out.trim(), err: err.trim() }));
    p.stdin.end(sql);
  });
}
const sh = async (sql) => { const r = await psql(sql); if (/ERROR/.test(r.err)) throw new Error('SQL: ' + r.err.slice(0, 300)); return r.out; };
const one = async (sql) => (await sh(sql)).split('\n').pop();
const lit = (v) => v === null || v === undefined ? 'NULL' : Array.isArray(v) ? (v.length ? `ARRAY[${v.map(lit).join(',')}]::text[]` : `'{}'::text[]`) : (typeof v === 'boolean' || typeof v === 'number') ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const SET_RETURNING = new Set(['pago_gestion_reclamar', 'pago_gestion_destinatarios_de', 'pago_gestion_revisar_elegibilidad']);
async function rpc(name, args = {}) {   // como service_role (prueba tambien los GRANT)
  const a = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const q = SET_RETURNING.has(name)
    ? `SET ROLE service_role; SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM public.${name}(${a}) x;`
    : `SET ROLE service_role; SELECT to_jsonb(public.${name}(${a}));`;
  const r = await psql(q);
  if (/ERROR/.test(r.err)) return { data: null, error: { code: 'PG', message: r.err } };
  return { data: JSON.parse(r.out.split('\n').pop() || 'null'), error: null };
}
async function selectJson(q) { const r = await psql(`SET ROLE service_role; ${q}`); if (/ERROR/.test(r.err)) return { data: null, error: { code: 'PG' } }; return { data: JSON.parse(r.out.split('\n').pop() || 'null'), error: null }; }

async function reset() {
  execFileSync('bash', [join(DIR, 'reset_local.sh')], { stdio: 'pipe' });
  await sh(readFileSync(join(HERE, 'fixture_columnas_reales.sql'), 'utf8'));
}

// ---------- mock de Resend ----------
function mockResend() {
  const reqs = [], store = new Map(); let comportamiento = () => ({ status: 200, body: { id: 're_' + randomUUID().replace(/-/g, '').slice(0, 14) } });
  const server = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', async () => {
      const idem = rq.headers['idempotency-key']; const hash = createHash('sha256').update(b).digest('hex');
      reqs.push({ idem, body: JSON.parse(b), auth: rq.headers.authorization });
      const send = (r) => { rs.writeHead(r.status, { 'content-type': 'application/json' }); rs.end(r.raw ?? JSON.stringify(r.body)); };
      if (idem && store.has(idem)) { const s = store.get(idem); return send(s.hash === hash ? s.resp : { status: 409, body: { name: 'invalid_idempotent_request' } }); }
      const r = await comportamiento(reqs[reqs.length - 1], reqs.length);
      if (r.delay) await new Promise((z) => setTimeout(z, r.delay));
      if (idem && r.status < 500) store.set(idem, { hash, resp: r });
      try { send(r); } catch { /* cliente se fue (timeout) */ }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
    reqs, port: server.address().port, set: (f) => (comportamiento = f), close: () => { server.closeAllConnections?.(); server.close(); },
  })));
}

// ---------- fabrica de dependencias ----------
const SECRET = 'S3cr3t-gestion-' + 'x'.repeat(24);
const TOKEN_FIRMA = 'SIGSECRET';
let LOGS = [];   // todo lo que el emisor loguea en TODA la corrida
function mkDeps(mock, over = {}) {
  let n = 0;
  return {
    cfg: { secret: SECRET, from: 'Recetario Straumann <no-responder@recetariostra.cl>', replyDomain: 'pedidos.recetariostra.cl', maxLote: 5, resendTimeoutMs: 2000 },
    rpc,
    getCotizacion: (id) => selectJson(`SELECT to_jsonb(c) FROM public.cotizaciones c WHERE c.id='${id}'`),
    getPagos: (id) => selectJson(`SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at),'[]'::jsonb) FROM public.cotizacion_pagos p WHERE p.cotizacion_id='${id}'`),
    sign: async (path) => `https://mock.storage.local/sign/${path}?token=${TOKEN_FIRMA}_${++n}`,
    resend: async (payload, idem, signal) => {
      const r = await fetch(`http://127.0.0.1:${mock.port}/emails`, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer re_MOCK_KEY', 'idempotency-key': idem }, body: JSON.stringify(payload) });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    log: (o) => LOGS.push(JSON.stringify(o)),
    ...over,
  };
}

// ---------- datos ----------
let seq = 100;
async function mkCot({ inst = 'UDP', nombreInst, total = 100000, paciente = 'Scarlett Salas López', rut = '16072120-0', estado = 'Enviada al paciente' } = {}) {
  const n = ++seq; const id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const nombres = { UDP: 'UDP Santiago', UNAB: 'UNAB Santiago', UMAYOR: 'Universidad Mayor Santiago', UMAYORT: 'Universidad Mayor Temuco', HOSMIL: 'HOSMIL', ARMADA: 'Central Odontológica de la Armada', PDI: 'Policía de Investigaciones', UC: 'Pontificia UC' };
  await sh(`INSERT INTO cotizaciones(id,numero,institucion,institucion_codigo,estado,total,token,paciente,rut,paciente_email,paciente_direccion,paciente_whatsapp,doctor,items)
    VALUES ('${id}','C-${n}',${lit(nombreInst ?? nombres[inst])},'${inst}',${lit(estado)},${total},'tok${n}',${lit(paciente)},${lit(rut)},'pac${n}@correo.cl','Calle ${n}','9${String(n).padStart(8, '0')}','Dr. Pérez',
    '[{"codigo":"104.060","descripcion":"Implante Helix","cantidad":2,"descuento":0.15,"subtotal":${total}}]'::jsonb);`);
  return { id, n, token: `tok${n}` };
}
const pagar = async (c, monto, tag = 'a') => one(`SET ROLE anon; SELECT registrar_pago_publico('${c.token}','pagos/${c.n}-${tag}.pdf',${monto},'h${c.n}${tag}');`);
const gestion = async (c) => JSON.parse(await one(`SELECT coalesce((SELECT to_jsonb(g) FROM pago_gestiones g WHERE cotizacion_id='${c.id}'),'null'::jsonb);`));
const cfgSet = (k, v) => sh(`UPDATE pago_gestion_config SET valor=${lit(v)} WHERE clave=${lit(k)};`);
const activar = () => cfgSet('envio_activo', 'true');
const correr = (mock, over) => handle(SECRET, mkDeps(mock, over));
const todosLosCorreos = (mock) => mock.reqs.flatMap((r) => [...(r.body.to || []), ...(r.body.cc || [])]);

let mock;
test.before(async () => { mock = await mockResend(); });
test.after(() => mock.close());
test.beforeEach(async () => { await reset(); mock.reqs.length = 0; mock.set(() => ({ status: 200, body: { id: 're_' + randomUUID().replace(/-/g, '').slice(0, 14) } })); });

// ================= 1. Interruptores =================
test('I1 envio_activo=false (valor por defecto): no se reclama ni se envia nada', async () => {
  const c = await mkCot(); await pagar(c, 100000);
  const r = await correr(mock);
  assert.equal(r.status, 200); assert.equal(r.body.reclamadas, 0); assert.equal(mock.reqs.length, 0);
  assert.equal((await gestion(c)).estado_envio, 'pendiente');
  assert.equal(await one(`SELECT valor FROM pago_gestion_config WHERE clave='modo'`), 'prueba');
  assert.equal(await one(`SELECT valor FROM pago_gestion_config WHERE clave='confirmaciones_activo'`), 'false');
});

test('I2 secreto ausente o incorrecto: 401 y la BD no se toca', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  let llamadas = 0; const over = { rpc: async (...a) => { llamadas++; return rpc(...a); } };
  assert.equal((await handle(null, mkDeps(mock, over))).status, 401);
  assert.equal((await handle('x', mkDeps(mock, over))).status, 401);
  assert.equal((await handle(SECRET + 'x', mkDeps(mock, over))).status, 401);
  assert.equal(llamadas, 0); assert.equal(mock.reqs.length, 0);
});

// ================= 2. Flujo normal en modo prueba =================
test('I3 modo prueba: UN correo, solo a daniel.jordan, asunto [PRUEBA]+exacto, reply-to con token, sin CC/BCC', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  const r = await correr(mock);
  assert.deepEqual([r.body.reclamadas, r.body.enviadas], [1, 1]);
  assert.equal(mock.reqs.length, 1);
  const q = mock.reqs[0].body; const g = await gestion(c);
  assert.deepEqual(q.to, ['daniel.jordan@straumann.com']); assert.equal(q.cc, undefined); assert.equal(q.bcc, undefined);
  assert.equal(q.subject, '[PRUEBA] Scarlett Salas López - RUT paciente: 16072120-0 - Institución: UDP Santiago');
  assert.equal(q.reply_to, `reply+${g.reply_token}@pedidos.recetariostra.cl`);
  assert.match(q.text, /MODO PRUEBA/); assert.match(q.text, /N° Cotización: C-/); assert.match(q.text, /Código \| Descripción \| Cant\. \| Dscto\. \| Subtotal/);
  assert.match(q.html, /<table/);
  assert.equal(g.estado_envio, 'aceptado'); assert.match(g.resend_id, /^re_/); assert.equal(g.intentos, 1); assert.ok(g.enviado_en);
  assert.deepEqual(g.destinatarios_to, ['daniel.jordan@straumann.com']);
  assert.equal(g.entrega_estado, null, 'aceptado por Resend NO es entregado');
});

test('I4 enlaces firmados generados al momento del envio (uno por pago), ninguno publico', async () => {
  const c = await mkCot({ total: 100000 }); await pagar(c, 60000, 'a'); await pagar(c, 40000, 'b'); await activar();
  await correr(mock);
  const q = mock.reqs[0].body;
  const links = q.text.match(/https:\/\/mock\.storage\.local\/sign\/[^\s]+/g) || [];
  assert.equal(links.length, 2); assert.ok(links.every((l) => l.includes('?token=' + TOKEN_FIRMA)));
  assert.match(q.text, /Comprobante 1 — \$60\.000 \(\d\d-\d\d-\d{4}\)/); assert.match(q.text, /Comprobante 2 — \$40\.000/);
  assert.equal(await one(`SELECT count(*) FROM pago_gestiones WHERE (to_jsonb(pago_gestiones))::text LIKE '%${TOKEN_FIRMA}%'`), '0', 'la BD no guarda enlaces firmados');
});

test('I5 si falla el firmado de ALGUN comprobante: el correo se BLOQUEA (no sale incompleto), queda error registrado y se reintenta despues', async () => {
  const c = await mkCot({ total: 100000 }); await pagar(c, 60000, 'a'); await pagar(c, 40000, 'b'); await activar();
  let n = 0;
  const r = await correr(mock, { sign: async (path) => (++n === 2 ? null : `https://mock.storage.local/sign/${path}?token=${TOKEN_FIRMA}`) });   // falla el 2o comprobante
  assert.equal(mock.reqs.length, 0); assert.equal(r.body.errores, 1);
  let g = await gestion(c); assert.equal(g.estado_envio, 'error'); assert.equal(g.ultimo_error, 'enlace_firmado_fallo'); assert.equal(g.resend_id, null);
  await sh(`UPDATE pago_gestiones SET updated_at = now() - interval '16 minutes'`);
  await correr(mock);   // reintento con firmado correcto
  assert.equal(mock.reqs.length, 1); assert.ok(!/No se pudo generar link/.test(mock.reqs[0].body.text));
  assert.equal((await gestion(c)).estado_envio, 'aceptado');
});

test('I5b sign() que lanza excepcion o devuelve URL no https: tambien bloquea', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  await correr(mock, { sign: async () => { throw new Error('boom'); } });
  await sh(`UPDATE pago_gestiones SET updated_at = now() - interval '16 minutes'`);
  await correr(mock, { sign: async () => 'http://inseguro/x' });
  assert.equal(mock.reqs.length, 0); assert.equal((await gestion(c)).intentos, 2);
});

// ================= 3. Destinatarios por institucion =================
const REAL = {
  to: ['cobranza.cl@straumann.com', 'm.cl.customerservicechile@straumann.com'],
  cc: { UDP: 'isleinny.rojas@straumann.com', UNAB: 'isleinny.rojas@straumann.com', UMAYOR: 'isleinny.rojas@straumann.com', HOSMIL: 'gloria.trejos@straumann.com', PDI: 'gerardo.salgado@neodent.com', ARMADA: 'hebeline.salas@straumann.com', UMAYORT: 'bethania.henriquez@straumann.com' },
};
test('I6 modo prueba: las 7 instituciones con regla envian SOLO a Daniel (nunca a CS, Cobranza ni ejecutivos)', async () => {
  for (const inst of Object.keys(REAL.cc)) { const c = await mkCot({ inst }); await pagar(c, 100000); }
  await activar(); await correr(mock); await correr(mock);
  assert.equal(mock.reqs.length, 7);
  assert.deepEqual([...new Set(todosLosCorreos(mock))], ['daniel.jordan@straumann.com']);
});

test('I7 UC: bloqueada (sin ejecutivo) => no se envia, queda pendiente con registro tecnico', async () => {
  const c = await mkCot({ inst: 'UC' }); await pagar(c, 100000); await activar();
  await correr(mock);
  assert.equal(mock.reqs.length, 0); const g = await gestion(c);
  assert.equal(g.estado_envio, 'bloqueado_sin_regla');
  assert.equal(await one(`SELECT count(*) FROM pago_gestion_eventos WHERE cotizacion_id='${c.id}' AND tipo='sin_regla'`), '1');
  await cfgSet('modo', 'real'); await correr(mock);
  assert.equal(mock.reqs.length, 0, 'ni siquiera en modo real');
});

test('I8 modo REAL (solo en la BD local y contra el mock): TO fijos + CC Daniel + CC de cada institucion; sin BCC', async () => {
  await cfgSet('modo', 'real');
  const cots = {}; for (const inst of Object.keys(REAL.cc)) { cots[inst] = await mkCot({ inst }); await pagar(cots[inst], 100000); }
  const uc = await mkCot({ inst: 'UC' }); await pagar(uc, 100000);
  await activar(); await correr(mock); await correr(mock);
  assert.equal(mock.reqs.length, 7);
  for (const inst of Object.keys(REAL.cc)) {
    const g = await gestion(cots[inst]); const q = mock.reqs.find((r) => r.idem.startsWith('gestion-pago:' + g.id)).body;
    assert.deepEqual([...q.to].sort(), REAL.to, inst);
    assert.deepEqual([...q.cc].sort(), ['daniel.jordan@straumann.com', REAL.cc[inst]].sort(), inst);
    assert.equal(q.bcc, undefined); assert.ok(!q.subject.startsWith('[PRUEBA]'), 'en modo real el asunto es exacto');
    assert.doesNotMatch(q.text, /MODO PRUEBA/);
  }
  assert.equal((await gestion(uc)).estado_envio, 'bloqueado_sin_regla');
});

test('I9 fail-closed: cualquier valor de modo distinto de "real" exacto => solo Daniel', async () => {
  for (const v of ['Real', 'REAL', 'real ', '', 'produccion', 'true']) {
    await cfgSet('modo', v); const c = await mkCot(); await pagar(c, 100000); await activar(); mock.reqs.length = 0;
    await correr(mock); assert.equal(mock.reqs.length, 1, `modo=${JSON.stringify(v)}`);
    assert.deepEqual(todosLosCorreos(mock), ['daniel.jordan@straumann.com'], `modo=${JSON.stringify(v)}`);
  }
});

test('I10 guardia previa a Resend: si el codigo "se desvia" de la regla de la BD, NO se llama a Resend', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  const rpcDrift = async (n, a) => { const r = await rpc(n, a); if (n === 'pago_gestion_destinatarios_de') r.data[0].to_emails = [...r.data[0].to_emails, 'm.cl.customerservicechile@straumann.com']; return r; };
  // la BD recibe lo "desviado" en validar_envio => no coincide con su propia regla
  const over = { rpc: async (n, a) => { if (n === 'pago_gestion_destinatarios_de') return rpcDrift(n, a); return rpc(n, a); } };
  const r = await correr(mock, over);
  assert.equal(mock.reqs.length, 0); assert.equal(r.body.errores, 1);
  const g = await gestion(c); assert.equal(g.estado_envio, 'error'); assert.equal(g.ultimo_error, 'guardia_rechazo'); assert.equal(g.resend_id, null);
});

// ================= 4. Cobertura de pago e idempotencia =================
test('I11 pagos parciales no disparan; al cubrir el total sale UN correo; comprobantes posteriores NO generan otro', async () => {
  const c = await mkCot({ total: 100000 }); await activar();
  await pagar(c, 30000, 'a'); await correr(mock); assert.equal(mock.reqs.length, 0); assert.equal(await gestion(c), null);
  await pagar(c, 70000, 'b'); await correr(mock); assert.equal(mock.reqs.length, 1);
  await pagar(c, 5000, 'c'); await correr(mock); await correr(mock);
  assert.equal(mock.reqs.length, 1, 'sin segundo correo');
  assert.equal(await one(`SELECT count(*) FROM pago_gestion_eventos WHERE cotizacion_id='${c.id}' AND tipo='actividad_posterior'`), '1', 'queda registrado para revision');
  assert.equal(await one(`SELECT count(*) FROM pago_gestiones WHERE cotizacion_id='${c.id}'`), '1');
});

test('I12 "avisar pago" (RPC publica) con pago que NO cubre el total: no se envia', async () => {
  const c = await mkCot({ total: 100000 }); await pagar(c, 40000); await activar();
  await one(`SET ROLE anon; SELECT marcar_pago_informado_publico('${c.token}');`);   // el paciente avisa sin completar
  await correr(mock);
  assert.equal(mock.reqs.length, 0);
  assert.equal((await gestion(c)).estado_envio, 'no_elegible');
});

test('I13 dos invocaciones SIMULTANEAS: cada gestion se envia exactamente una vez', async () => {
  for (let i = 0; i < 4; i++) { const c = await mkCot(); await pagar(c, 100000); }
  await activar();
  mock.set(async () => ({ status: 200, body: { id: 're_' + randomUUID().replace(/-/g, '').slice(0, 14) }, delay: 60 }));
  await Promise.all([correr(mock), correr(mock), correr(mock)]);
  await correr(mock);
  assert.equal(mock.reqs.length, 4);
  assert.equal(new Set(mock.reqs.map((r) => r.idem)).size, 4);
  assert.equal(await one(`SELECT count(*) FROM pago_gestiones WHERE estado_envio='aceptado' AND resend_id IS NOT NULL`), '4');
});

// ================= 5. Elegibilidad =================
test('I14 no se reclama: anulada, eliminada logicamente, movida a mano, o pago eliminado que ya no cubre el total', async () => {
  const a = await mkCot(), b = await mkCot(), m = await mkCot(), p = await mkCot({ total: 100000 });
  for (const x of [a, b, m]) await pagar(x, 100000);
  await pagar(p, 60000, 'a'); await pagar(p, 40000, 'b');
  await sh(`UPDATE cotizaciones SET estado='Anulado' WHERE id='${a.id}'; UPDATE cotizaciones SET deleted_at=now() WHERE id='${b.id}'; UPDATE cotizaciones SET estado='Pedido ingresado al sistema' WHERE id='${m.id}'; DELETE FROM cotizacion_pagos WHERE cotizacion_id='${p.id}' AND monto=40000;`);
  await activar(); await correr(mock);
  assert.equal(mock.reqs.length, 0);
});

test('I15 carrera: la cotizacion se anula DURANTE el armado => la 2a verificacion la suelta y NO se envia', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  const over = { sign: async (p) => { await sh(`UPDATE cotizaciones SET estado='Anulado' WHERE id='${c.id}'`); return 'https://mock.storage.local/x?token=' + TOKEN_FIRMA; } };
  const r = await correr(mock, over);
  assert.equal(mock.reqs.length, 0); assert.equal(r.body.soltadas, 1);
  const g = await gestion(c); assert.equal(g.estado_envio, 'no_elegible'); assert.equal(g.resend_id, null);
});

// ================= 6. Reintentos y casos dudosos =================
test('I16 rechazo definitivo (422): queda en error, se reintenta SOLO tras 15 min y con otra Idempotency-Key; maximo 3 intentos', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  mock.set(() => ({ status: 422, body: { name: 'validation_error', message: 'x@y.cl invalido' } }));
  await correr(mock);
  let g = await gestion(c); assert.equal(g.estado_envio, 'error'); assert.equal(g.intentos, 1); assert.equal(g.ultimo_error, 'resend_422:validation_error');
  await correr(mock); assert.equal(mock.reqs.length, 1, 'no se reintenta de inmediato');
  mock.set(() => ({ status: 200, body: { id: 're_reintento0001' } }));
  await sh(`UPDATE pago_gestiones SET updated_at = now() - interval '16 minutes' WHERE cotizacion_id='${c.id}'`);
  await correr(mock);
  g = await gestion(c); assert.equal(g.estado_envio, 'aceptado'); assert.equal(g.intentos, 2); assert.equal(g.resend_id, 're_reintento0001');
  assert.deepEqual(mock.reqs.map((r) => r.idem), [`gestion-pago:${g.id}:1`, `gestion-pago:${g.id}:2`]);
  await correr(mock); assert.equal(mock.reqs.length, 2, 'una vez aceptado no se reenvia');
});

test('I17 tope de 3 intentos: tras el tercero error, ya no se reclama', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  mock.set(() => ({ status: 403, body: { name: 'restricted_api_key' } }));
  for (let i = 0; i < 5; i++) { await correr(mock); await sh(`UPDATE pago_gestiones SET updated_at = now() - interval '16 minutes'`); }
  assert.equal(mock.reqs.length, 3); assert.equal((await gestion(c)).intentos, 3);
});

for (const [nombre, resp] of [
  ['500', { status: 500, body: { name: 'internal_server_error' } }],
  ['respuesta 200 sin id legible', { status: 200, raw: 'no-json' }],
  ['409 idempotencia en curso', { status: 409, body: { name: 'concurrent_idempotent_requests' } }],
  ['timeout del cliente', { status: 200, body: { id: 're_lento000001' }, delay: 900 }],
]) {
  test(`I18 respuesta DUDOSA (${nombre}): no se marca error ni se reenvia nunca; pasa a "incierto" para revision`, async () => {
    const c = await mkCot(); await pagar(c, 100000); await activar(); mock.set(() => resp);
    const r = await correr(mock, { cfg: { ...mkDeps(mock).cfg, resendTimeoutMs: 300 } });
    assert.equal(r.body.dudosas, 1, JSON.stringify(r.body));
    let g = await gestion(c); assert.equal(g.estado_envio, 'enviando'); assert.equal(g.resend_id, null);
    await correr(mock); assert.equal(mock.reqs.length, 1, 'no se reclama mientras esta enviando');
    await sh(`UPDATE pago_gestiones SET reclamado_hasta = now() - interval '1 minute'`);
    await correr(mock); g = await gestion(c);
    assert.equal(g.estado_envio, 'incierto'); assert.equal(mock.reqs.length, 1, 'NUNCA se reenvia solo');
    await sh(`UPDATE pago_gestiones SET updated_at = now() - interval '2 days'`); await correr(mock);
    assert.equal(mock.reqs.length, 1); assert.equal((await gestion(c)).estado_envio, 'incierto');
    assert.equal(await one(`SELECT count(*) FROM pago_gestion_eventos WHERE cotizacion_id='${c.id}' AND tipo='error_tecnico'`), '1', 'queda en la bandeja de revision');
  });
}

test('I19 Resend ACEPTA pero falla el registro en la BD: se reintenta el registro; si persiste => incierto, sin reenviar', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  let intentosFin = 0;
  const over = { rpc: async (n, a) => { if (n === 'pago_gestion_finalizar_envio' && a.p_ok === true) { intentosFin++; return { data: null, error: { code: 'PG', message: 'caida' } }; } return rpc(n, a); } };
  const r = await correr(mock, over);
  assert.equal(intentosFin, 3); assert.equal(r.body.dudosas, 1); assert.equal(mock.reqs.length, 1);
  assert.equal((await gestion(c)).estado_envio, 'enviando');
  await sh(`UPDATE pago_gestiones SET reclamado_hasta = now() - interval '1 minute'`); await correr(mock);
  assert.equal((await gestion(c)).estado_envio, 'incierto'); assert.equal(mock.reqs.length, 1);
});

test('I20 excepcion DESPUES de llamar a Resend: no se marca error (seria reenviable)', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  const over = { rpc: async (n, a) => { if (n === 'pago_gestion_finalizar_envio') throw new Error('red'); return rpc(n, a); } };
  const r = await correr(mock, over);
  assert.equal(r.body.dudosas, 1); assert.equal((await gestion(c)).estado_envio, 'enviando'); assert.equal(mock.reqs.length, 1);
});

test('I21 excepcion ANTES de Resend (p. ej. falla la lectura): error reintentable, sin correo', async () => {
  const c = await mkCot(); await pagar(c, 100000); await activar();
  const r = await correr(mock, { getCotizacion: async () => { throw new Error('lectura'); } });
  assert.equal(mock.reqs.length, 0); assert.equal(r.body.errores, 1); assert.equal((await gestion(c)).estado_envio, 'error');
});

// ================= 7. Seguridad de logs =================
test('I22 los logs de TODA la corrida no contienen tokens, enlaces firmados, correos, nombres, RUT ni claves', async () => {
  LOGS = [];
  const c = await mkCot({ paciente: 'Zoila Unica Ñandú', rut: '11111111-1' }); await pagar(c, 100000); await activar();
  await correr(mock);
  mock.set(() => ({ status: 422, body: { name: 'validation_error', message: 'zoila@correo.cl' } }));
  const d = await mkCot({ paciente: 'Otro Paciente', rut: '22222222-2' }); await pagar(d, 100000); await correr(mock);
  const g = await gestion(c);
  const blob = LOGS.join('\n'); assert.ok(blob.length > 0);
  for (const prohibido of [g.reply_token, TOKEN_FIRMA, 'SIGSECRET', '@', 'Zoila', 'Ñandú', '11111111', '22222222', 'Otro Paciente', 'mock.storage', 'Bearer', 're_MOCK_KEY', SECRET, c.token, 'pagos/']) assert.ok(!blob.includes(prohibido), 'filtra: ' + prohibido);
  assert.ok(!blob.includes(g.resend_id), 'ni el id de Resend');
});

test('I23 safeLog descarta cualquier campo fuera de la lista blanca y valores con correos', () => {
  const o = safeLog({ ev: 'x', gid: 'abc12345', token: 'secreto', email: 'a@b.cl', motivo: 'a@b.cl', n: 3, inst: 'UDP', detalle: { a: 1 }, code: 'a b c' });
  assert.deepEqual(o, { ev: 'x', gid: 'abc12345', n: 3, inst: 'UDP' });
});

// ================= 8. Aislamiento =================
test('I24 logic.ts y gestion.ts no hacen llamadas de red propias (solo index.ts conoce api.resend.com)', () => {
  for (const f of ['logic.ts', 'gestion.ts']) { const s = readFileSync(join(HERE, '..', f), 'utf8'); assert.ok(!/api\.resend\.com|\bfetch\s*\(/.test(s), f); }
  assert.match(readFileSync(join(HERE, '..', 'index.ts'), 'utf8'), /api\.resend\.com/);
});

test('I25 el emisor no escribe en cotizaciones, pagos ni recordatorios (checksum de tablas productivas intacto)', async () => {
  const snap = () => one(`SELECT md5(string_agg(x,'|' ORDER BY x)) FROM (SELECT (to_jsonb(c)-'updated_at')::text x FROM cotizaciones c UNION ALL SELECT to_jsonb(p)::text FROM cotizacion_pagos p) t`);
  const c = await mkCot(); await pagar(c, 100000); await activar();
  const antes = await snap(); await correr(mock); await correr(mock); const despues = await snap();
  assert.equal(antes, despues);
});

test('I26 clasificarResend: tabla de decisiones', () => {
  const k = (s, j) => clasificarResend({ status: s, json: j }).tipo;
  assert.equal(k(200, { id: 're_abcdef123' }), 'ok'); assert.equal(k(200, {}), 'dudoso'); assert.equal(k(200, null), 'dudoso');
  for (const s of [400, 401, 403, 404, 422, 429]) assert.equal(k(s, { name: 'x' }), 'rechazado', String(s));
  for (const s of [408, 409, 500, 502, 503, 504, 302]) assert.equal(k(s, {}), 'dudoso', String(s));
});
