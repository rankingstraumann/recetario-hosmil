// Pruebas de logic.ts (sin red, sin Supabase). BD simulada con las MISMAS reglas que la RPC (probadas aparte en la BD real).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, readConfig, sanitizeError, buildTemplatePayload, mapRpcError } from '../logic.ts';
import { readFileSync } from 'node:fs';

const UUID = '11111111-1111-4111-8111-111111111111';
const env = (o) => (k) => o[k];
const BASE = { OUTBOUND_WHATSAPP_ENABLED: 'true', OUTBOUND_TEMPLATE_NAME: 'bienvenida_prueba', OUTBOUND_TEMPLATE_LANGUAGE: 'es', OUTBOUND_TEMPLATE_APPROVED: 'true', WHATSAPP_ACCESS_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123' };

function mkDb(p) {
  const db = { p: { is_test: true, consent: 'yes', phone: '+56990000001', status: 'pending', ...p }, sends: [], calls: [] };
  db.rpc = async (name, a) => {
    db.calls.push(name);
    if (name === 'claim_outbound_send') {
      const x = db.p;
      const bad = x.is_test !== true ? 'PROSPECTO_REAL_NO_PERMITIDO' : x.consent !== 'yes' ? 'SIN_CONSENTIMIENTO' : !/^\+569\d{8}$/.test(x.phone || '') ? 'SIN_MOVIL_VALIDO'
        : x.status !== 'pending' ? 'ESTADO_NO_PENDIENTE' : db.sends.some((s) => s.status === 'sending') ? 'ENVIO_EN_CURSO' : null;
      if (bad) return { data: null, error: { message: bad } };
      const s = { id: 's' + (db.sends.length + 1), status: 'sending', args: a }; db.sends.push(s);
      return { data: { send_id: s.id, to: x.phone }, error: null };
    }
    if (name === 'finalize_outbound_send') {
      if (db.failFinalize) return { data: null, error: { message: 'x' } };   // en la BD real la fila queda 'sending'
      const s = db.sends.find((z) => z.id === a.p_send_id); s.status = a.p_status; s.pmid = a.p_provider_message_id; s.code = a.p_error_code; s.msg = a.p_error_message;
      if (a.p_status === 'sent') db.p.status = 'contacted'; else if (a.p_status === 'failed') db.p.status = 'failed';
      return { data: { ok: 1 }, error: null };
    }
    throw new Error('rpc inesperada ' + name);
  };
  return db;
}
function mkFetch(kind) {
  const f = async (url, init) => { f.calls.push({ url, init });
    if (kind === 'ok') return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.ABC' }] }) };
    if (kind === 'noid') return { ok: true, status: 200, json: async () => ({}) };
    if (kind === 'throw') throw Object.assign(new Error('boom'), { name: 'TypeError' });
    return { ok: false, status: 400, json: async () => ({ error: { code: 132001, message: 'Template does not exist for +56990000001 token EAAGabcdefghijk123' } }) }; };
  f.calls = []; return f;
}
const run = (envObj, db, f, body = { action: 'send', prospect_id: UUID }) => handle(body, { cfg: readConfig(env(envObj)), rpc: db.rpc, doFetch: f });

test('A1 test autorizado + pending + movil valido -> permitido; Meta acepta -> sent + contacted', async () => {
  const db = mkDb({}), f = mkFetch('ok'); const r = await run(BASE, db, f);
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.status, 'sent'); assert.equal(r.body.provider_message_id, 'wamid.ABC');
  assert.equal(db.p.status, 'contacted'); assert.equal(f.calls.length, 1); assert.equal(db.sends[0].pmid, 'wamid.ABC');
});
test('A2 payload a Meta = plantilla sin precios/variables, destino sin +, token solo en header', async () => {
  const db = mkDb({}), f = mkFetch('ok'); await run(BASE, db, f);
  const c = f.calls[0]; const b = JSON.parse(c.init.body);
  assert.match(c.url, /graph\.facebook\.com\/v21\.0\/123\/messages$/);
  assert.deepEqual(b, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '56990000001', type: 'template', template: { name: 'bienvenida_prueba', language: { code: 'es' } } });
  assert.equal(c.init.headers.authorization, 'Bearer tok'); assert.ok(!c.init.body.includes('tok'));
});
test('A3 test sin consentimiento -> rechazado, no llama a Meta', async () => {
  const db = mkDb({ consent: 'unknown' }), f = mkFetch('ok'); const r = await run(BASE, db, f);
  assert.equal(r.body.error, 'sin_consentimiento'); assert.equal(f.calls.length, 0); assert.equal(db.sends.length, 0);
});
test('A4 test sin movil (null y fijo) -> rechazado', async () => {
  for (const phone of [null, '+56221234567']) { const db = mkDb({ phone }), f = mkFetch('ok'); const r = await run(BASE, db, f); assert.equal(r.body.error, 'sin_movil_valido'); assert.equal(f.calls.length, 0); }
});
test('A5 test ya contactado -> rechazado', async () => {
  const db = mkDb({ status: 'contacted' }), f = mkFetch('ok'); const r = await run(BASE, db, f);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'estado_no_pendiente'); assert.equal(f.calls.length, 0);
});
test('A6 REAL autorizado -> rechazado server-side aunque el cliente lo intente (body con is_test=false se ignora)', async () => {
  const db = mkDb({ is_test: false }), f = mkFetch('ok');
  const r = await run(BASE, db, f, { action: 'send', prospect_id: UUID, is_test: true, force: true });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'prospecto_real_no_permitido'); assert.equal(f.calls.length, 0); assert.equal(db.sends.length, 0);
});
test('A7 doble clic concurrente -> UN solo envio a Meta', async () => {
  const db = mkDb({}), f = mkFetch('ok');
  const [a, b] = await Promise.all([run(BASE, db, f), run(BASE, db, f)]);
  assert.equal(f.calls.length, 1); assert.equal([a, b].filter((x) => x.body.ok === true).length, 1);
  assert.ok([a, b].some((x) => x.body.error === 'envio_en_curso'));
});
test('A8 reintento tras exito -> rechazado (ya contactado), sin segundo envio', async () => {
  const db = mkDb({}), f = mkFetch('ok'); await run(BASE, db, f); const r2 = await run(BASE, db, f);
  assert.equal(r2.body.error, 'estado_no_pendiente'); assert.equal(f.calls.length, 1);
});
test('A9 Meta error -> failed, detalle SANITIZADO (sin telefono ni token), un solo intento', async () => {
  const db = mkDb({}), f = mkFetch('err'); const r = await run(BASE, db, f);
  assert.equal(r.body.ok, false); assert.equal(r.body.status, 'failed'); assert.equal(r.body.error_code, 'http_400_code_132001');
  assert.equal(db.p.status, 'failed'); assert.equal(f.calls.length, 1);
  assert.ok(!/5699000|EAAG/.test(db.sends[0].msg), db.sends[0].msg);
});
test('A10 Meta responde 200 sin id -> failed (no_provider_id), NO contacted; excepcion de red -> failed', async () => {
  for (const k of ['noid', 'throw']) { const db = mkDb({}), f = mkFetch(k); const r = await run(BASE, db, f); assert.equal(r.body.status, 'failed'); assert.equal(db.p.status, 'failed'); assert.equal(f.calls.length, 1); }
});
test('B1 kill switch apagado (defecto): 403, sin RPC, sin Meta', async () => {
  for (const e of [{ ...BASE, OUTBOUND_WHATSAPP_ENABLED: undefined }, { ...BASE, OUTBOUND_WHATSAPP_ENABLED: 'false' }, { ...BASE, OUTBOUND_WHATSAPP_ENABLED: 'TRUE' }, {}]) {
    const db = mkDb({}), f = mkFetch('ok'); const r = await run(e, db, f);
    assert.equal(r.status, 403); assert.equal(r.body.error, 'envio_deshabilitado'); assert.equal(db.calls.length, 0); assert.equal(f.calls.length, 0);
  }
});
test('B2 TEST_ONLY=false no habilita modo real en esta version', async () => {
  const db = mkDb({}), f = mkFetch('ok'); const r = await run({ ...BASE, OUTBOUND_WHATSAPP_TEST_ONLY: 'false' }, db, f);
  assert.equal(r.body.error, 'modo_real_no_soportado'); assert.equal(db.calls.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(readConfig(env(BASE)).testOnly, true);
});
test('C1 plantilla no configurada / invalida -> error claro, nada se envia ni se reserva', async () => {
  for (const e of [{ ...BASE, OUTBOUND_TEMPLATE_NAME: undefined }, { ...BASE, OUTBOUND_TEMPLATE_LANGUAGE: '' }, { ...BASE, OUTBOUND_TEMPLATE_NAME: 'Mala Plantilla!' }, { ...BASE, OUTBOUND_TEMPLATE_LANGUAGE: 'spanish' }]) {
    const db = mkDb({}), f = mkFetch('ok'); const r = await run(e, db, f);
    assert.equal(r.status, 422); assert.equal(r.body.error, 'plantilla_no_configurada'); assert.equal(db.calls.length, 0); assert.equal(f.calls.length, 0);
  }
});
test('D1 sin plantilla aprobada o sin token => DRY-RUN: no llama a Meta, no cambia el prospecto, registra dry_run', async () => {
  for (const e of [{ ...BASE, OUTBOUND_TEMPLATE_APPROVED: undefined }, { ...BASE, WHATSAPP_ACCESS_TOKEN: undefined }, { ...BASE, WHATSAPP_PHONE_NUMBER_ID: undefined }]) {
    const db = mkDb({}), f = mkFetch('ok'); const r = await run(e, db, f);
    assert.equal(r.body.status, 'dry_run'); assert.equal(r.body.mode, 'dry_run'); assert.equal(f.calls.length, 0); assert.equal(db.p.status, 'pending'); assert.equal(db.sends[0].status, 'dry_run');
  }
});
test('E1 check: informa estado sin secretos y sin escribir', async () => {
  const db = mkDb({}), f = mkFetch('ok'); const r = await run(BASE, db, f, { action: 'check' });
  assert.deepEqual(r.body, { ok: true, enabled: true, test_only: true, template_configured: true, template_name: 'bienvenida_prueba', template_language: 'es', mode: 'real' });
  assert.equal(db.calls.length, 0); assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(r.body).includes('tok'));
  const r2 = await run({}, db, f, { action: 'check' }); assert.equal(r2.body.enabled, false); assert.equal(r2.body.template_configured, false); assert.equal(r2.body.mode, 'dry_run');
});
test('E2 parametros invalidos: accion desconocida, prospect_id no-UUID, vacio', async () => {
  const db = mkDb({}), f = mkFetch('ok');
  for (const b of [{ action: 'x' }, {}, null, { action: 'send' }, { action: 'send', prospect_id: "1' or '1'='1" }, { action: 'send', prospect_id: 5 }]) { const r = await run(BASE, db, f, b); assert.equal(r.status, 400); }
  assert.equal(db.calls.length, 0); assert.equal(f.calls.length, 0);
});
test('F1 si falla registrar el resultado: 500, sin reintento, sin segundo envio', async () => {
  const db = mkDb({}); db.failFinalize = true; const f = mkFetch('ok'); const r = await run(BASE, db, f);
  assert.equal(r.status, 500); assert.equal(r.body.error, 'registro_fallido'); assert.equal(f.calls.length, 1); assert.equal(db.calls.filter((c) => c === 'finalize_outbound_send').length, 1);
  const r2 = await run(BASE, db, f); assert.equal(r2.body.error, 'envio_en_curso'); assert.equal(f.calls.length, 1);
});
test('G1 sanitizeError / mapRpcError', () => {
  assert.equal(sanitizeError('fallo para +56 9 9000 0001 con Bearer EAAGxxxxxxxxxxxx'), 'fallo para [num] con Bearer [token]');
  assert.ok(sanitizeError('x'.repeat(500)).length <= 200);
  assert.equal(mapRpcError({ message: 'P0001: SIN_CONSENTIMIENTO' }).code, 'sin_consentimiento');
  assert.equal(mapRpcError({ message: 'raro' }).status, 500);
});
test('H1 estaticos: index.ts sin service_role, sin logs de datos personales; solo POST; sin envio masivo', () => {
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/service_role|SERVICE_ROLE/.test(src)); assert.ok(!/phone|telefono|full_name/i.test(src.replace(/ev: 'error'/, '')));
  const lg = readFileSync(new URL('../logic.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/service_role/i.test(lg)); assert.ok(!/for\s*\(.*prospect|\.map\(.*claim_outbound/i.test(lg));
  assert.equal((lg.match(/claim_outbound_send/g) || []).length, 1);
});
