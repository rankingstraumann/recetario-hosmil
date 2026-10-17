// Pruebas de la funcion de prueba aislada: sin red, sin BD. node --experimental-strip-types --no-warnings --test prueba.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handlePrueba } from '../logic.ts';

const SECRET = 'whsec_' + Buffer.from('secreto-de-prueba-0123456789-abcdef').toString('base64');
const DOM = 'pedidos.recetariostra.cl', TOK = 'a'.repeat(32);
function firmar(ev, { ts = Math.floor(Date.now() / 1000), malo = false } = {}) {
  const body = JSON.stringify(ev), id = 'msg_test1', t = String(ts);
  const sig = 'v1,' + createHmac('sha256', Buffer.from(SECRET.replace('whsec_', ''), 'base64')).update(`${id}.${t}.${body}`).digest('base64');
  return { rawBody: body, svixId: id, svixTimestamp: t, svixSignature: malo ? 'v1,' + 'A'.repeat(sig.length - 3) : sig };
}
const evento = (data = {}, type = 'email.received') => ({ type, created_at: new Date().toISOString(), data: { email_id: 'em_0123456789', from: 'Daniel Jordan <daniel.jordan@straumann.com>', to: [`prueba-uno@${DOM}`], cc: [], bcc: [], received_for: [], message_id: '<m1@x>', subject: 'Prueba ficticia', attachments: [], ...data } });
const mk = (over = {}, logs = [], lecturas = []) => ({
  dominio: DOM, webhookSecret: SECRET, log: (o) => logs.push(JSON.stringify(o)),
  leer: async (id) => { lecturas.push(id); return { status: 200, json: { text: 'CUERPO-SECRETO-123', html: '<p>x</p>', headers: { 'Message-ID': 'x', 'Authentication-Results': 'a', 'X-Raro@': 'z' }, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } } }; },
  ...over,
});

test('P1 flujo valido: firma ok, en alcance, lectura ok, resumen con authentication y SIN cuerpo/direcciones', async () => {
  const logs = [], lect = [];
  const r = await handlePrueba(firmar(evento()), mk({}, logs, lect));
  assert.equal(r.status, 200); const s = r.body.resumen;
  assert.equal(s.firma_valida, true); assert.equal(s.lectura, 'ok'); assert.equal(s.auth_dmarc, 'pass'); assert.equal(s.veredicto_regla_actual, 'verificado');
  assert.equal(s.from_dominio, 'straumann.com'); assert.equal(s.tiene_authentication_results, true); assert.equal(s.cuerpo_texto, true);
  assert.deepEqual(lect, ['em_0123456789']);
  const todo = JSON.stringify(r.body) + logs.join('');
  for (const prohibido of ['CUERPO-SECRETO-123', 'daniel.jordan', 'Daniel Jordan', 'Prueba ficticia', SECRET, 'prueba-uno']) assert.ok(!todo.includes(prohibido), 'no debe aparecer: ' + prohibido);
  assert.ok(!s.cabeceras_nombres.includes('@'), 'nombres de cabecera filtrados');
});
test('P2 firma invalida => 401 con diagnostico (desfase, prefijo), sin leer nada', async () => {
  const lect = [];
  const r = await handlePrueba(firmar(evento(), { malo: true }), mk({}, [], lect));
  assert.equal(r.status, 401); assert.equal(r.body.secreto_con_prefijo_whsec, true); assert.equal(typeof r.body.skew_s, 'number'); assert.equal(lect.length, 0);
});
test('P3 timestamp viejo (>300 s) => 401 y el desfase queda informado (para medir la tolerancia real)', async () => {
  const r = await handlePrueba(firmar(evento(), { ts: Math.floor(Date.now() / 1000) - 900 }), mk());
  assert.equal(r.status, 401); assert.ok(r.body.skew_s >= 899);
});
test('P4 fuera de alcance (otra direccion / otro dominio): 200 sin leer ni registrar metadatos', async () => {
  for (const to of [['reply@recetariostra.cl'], [`gestion@${DOM}`], ['prueba-uno@evil.cl'], [`prueba-uno@${DOM}.evil.cl`]]) {
    const logs = [], lect = [];
    const r = await handlePrueba(firmar(evento({ to })), mk({}, logs, lect));
    assert.equal(r.status, 200); assert.equal(r.body.resultado, 'fuera_de_alcance'); assert.equal(lect.length, 0); assert.ok(!logs.join('').includes('recepcion_prueba'));
  }
});
test('P5 direccion reply+<token> tambien esta en alcance y se detecta el token en el destino', async () => {
  const r = await handlePrueba(firmar(evento({ to: [`reply+${TOK}@${DOM}`] })), mk());
  assert.equal(r.body.resultado, 'recibido'); assert.equal(r.body.resumen.hilo_token_en_destino, true);
  const r2 = await handlePrueba(firmar(evento({ to: ['otro@x.cl'], received_for: [`reply+${TOK}@${DOM}`] })), mk());
  assert.equal(r2.body.resumen.hilo_token_en_destino, true);
});
test('P6 la lectura puede fallar (403 sin permiso, 404, excepcion, sin API key): se informa y no se rompe', async () => {
  const caso = async (leer) => (await handlePrueba(firmar(evento()), mk({ leer }))).body.resumen;
  assert.equal((await caso(async () => ({ status: 403, json: null }))).lectura, 'sin_permiso_api_key');
  assert.equal((await caso(async () => ({ status: 401, json: null }))).lectura, 'sin_permiso_api_key');
  assert.equal((await caso(async () => ({ status: 404, json: null }))).lectura, 'no_encontrado');
  assert.equal((await caso(async () => ({ status: 500, json: null }))).lectura, 'error_http');
  assert.equal((await caso(async () => { throw new Error('x'); })).lectura, 'excepcion');
  assert.equal((await caso(null)).lectura, 'omitida_sin_api_key');
});
test('P7 valores de authentication reportados tal cual (enum) y veredicto de la regla actual', async () => {
  const caso = async (authentication) => (await handlePrueba(firmar(evento()), mk({ leer: async () => ({ status: 200, json: { authentication, headers: {} } }) }))).body.resumen;
  let s = await caso({ spf: 'pass', dkim: 'pass', dmarc: 'gray' }); assert.equal(s.auth_dmarc, 'gray'); assert.equal(s.veredicto_regla_actual, 'no_verificado');
  s = await caso({ spf: 'fail', dkim: 'unknown', dmarc: 'fail' }); assert.equal(s.auth_spf, 'fail'); assert.equal(s.auth_dkim, 'unknown'); assert.equal(s.veredicto_regla_actual, 'no_verificado');
  s = await caso(null); assert.equal(s.auth_objeto_presente, false); assert.equal(s.auth_dmarc, 'ausente'); assert.equal(s.veredicto_regla_actual, 'no_verificado');
  s = await caso({ dmarc: 'texto-libre-con@arroba' }); assert.equal(s.auth_dmarc, 'otro');
  s = await caso({ dmarc: 'processing_failed' }); assert.equal(s.veredicto_regla_actual, 'reintentar');
});
test('P8 otros eventos y JSON invalido: 200 ignorado (nunca error para Resend)', async () => {
  const r = await handlePrueba(firmar(evento({}, 'email.sent')), mk()); assert.equal(r.status, 200); assert.equal(r.body.resultado, 'evento_ignorado');
  const raw = 'no-json', id = 'm', t = String(Math.floor(Date.now() / 1000));
  const sig = 'v1,' + createHmac('sha256', Buffer.from(SECRET.replace('whsec_', ''), 'base64')).update(`${id}.${t}.${raw}`).digest('base64');
  const r2 = await handlePrueba({ rawBody: raw, svixId: id, svixTimestamp: t, svixSignature: sig }, mk()); assert.equal(r2.status, 200); assert.equal(r2.body.resultado, 'json_invalido');
});
test('P9 email_id raro no se usa en la URL de lectura', async () => {
  const lect = []; const r = await handlePrueba(firmar(evento({ email_id: '../../x?y=1' })), mk({}, [], lect));
  assert.equal(r.body.resumen.lectura, 'email_id_invalido'); assert.equal(lect.length, 0);
});

test('P10 index.ts usa SOLO secretos PRUEBA_* (jamas RESEND_API_KEY / RESEND_WEBHOOK_SECRET / GESTION_PAGOS_*): no puede pisar ni leer los de produccion', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  const nombres = [...src.matchAll(/Deno\.env\.get\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(nombres, ['PRUEBA_DOMINIO', 'PRUEBA_RESEND_API_KEY', 'PRUEBA_RESEND_WEBHOOK_SECRET']);
  assert.ok(!/SUPABASE_|SERVICE_ROLE/.test(src));
});
