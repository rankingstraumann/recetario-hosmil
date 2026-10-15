// Integracion Fase E: emisor (mock Resend) -> correos entrantes SIMULADOS y firmados -> receptor -> Postgres local con B1+B2+B3+B4 reales.
// Requiere PAGOS_FASE_B_DIR y la BD en /var/tmp/pgproof (ver ../../enviar-gestion-pago/test/run-tests.sh).
process.env.TZ = 'America/Santiago';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as emitir } from '../../enviar-gestion-pago/logic.ts';
import { handle as recibir, safeLog } from '../logic.ts';
import * as H from './helpers.mjs';
const { sh, one, lit, mkCot, pagar, gestion, estadoCot, eventos, cfgSet, CS, FIN, AUTH_OK } = H;
if (!H.DIR) { console.error('Falta PAGOS_FASE_B_DIR'); process.exit(2); }

let mock, cuerpos, entrante, LOGS = [];
test.before(async () => { mock = await H.mockResend(); });
test.after(() => mock.close());
test.beforeEach(async () => { await H.reset(); mock.reqs.length = 0; cuerpos = new Map(); entrante = H.fabricaEntrantes(cuerpos); });

/** Cotizacion pagada -> correo interno enviado por el emisor (mock) -> confirmaciones activas. Devuelve la gestion con su token. */
async function preparar({ inst = 'UDP', total = 100000, confirmaciones = true, enviar = true, paciente, rut } = {}) {
  const c = await mkCot({ inst, total, paciente, rut }); await pagar(c, total);
  if (enviar) { await sh(`UPDATE pago_gestion_config SET valor='true' WHERE clave='envio_activo'`); await emitir(H.SECRET_EMISOR, H.depsEmisor(mock, {}, LOGS)); }
  if (confirmaciones) await cfgSet('confirmaciones_activo', 'true');
  return { c, g: await gestion(c) };
}
const recibirMsg = (m, over = {}) => recibir(m, H.depsReceptor(cuerpos, over, LOGS));
const msg = (g, o) => entrante({ token: g.reply_token, ...o });

// ================= flujo feliz en ambos ordenes =================
test('R1 Customer Service (SAP) y luego Finanzas => "Pedido ingresado al sistema" SOLO tras la segunda', async () => {
  const { c, g } = await preparar();
  assert.equal(g.estado_envio, 'aceptado'); assert.equal(await estadoCot(c), 'Pago informado');
  let r = await recibirMsg(msg(g, { from: CS, text: 'Hola, el pedido SAP es 1234567890.\n\nSaludos\n\nEl lun, 12 oct 2026, Recetario <no-responder@recetariostra.cl> escribió:\n> Pedido SAP 0000000000' }));
  assert.deepEqual([r.status, r.body.resultado], [200, 'registrado']);
  let x = await gestion(c); assert.equal(x.sap_numero, '1234567890'); assert.equal(x.fin_confirmado_en, null); assert.equal(await estadoCot(c), 'Pago informado', 'con solo SAP NO avanza');
  r = await recibirMsg(msg(g, { from: FIN, text: 'Pago validado.' }));
  assert.equal(r.body.resultado, 'pedido_ingresado');
  x = await gestion(c); assert.ok(x.fin_confirmado_en && x.sap_numero && x.pedido_aplicado_en); assert.equal(await estadoCot(c), 'Pedido ingresado al sistema');
  assert.match(await one(`SELECT historial->-1->>'origen' FROM cotizaciones WHERE id='${c.id}'`), /gestion_interna/);
});

test('R2 Finanzas primero ("Pago validado") y luego SAP => pasa por "Pago validado" y termina en "Pedido ingresado"', async () => {
  const { c, g } = await preparar();
  let r = await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' })); assert.equal(r.body.resultado, 'pago_validado');
  assert.equal(await estadoCot(c), 'Pago validado'); assert.equal((await gestion(c)).sap_numero, null);
  r = await recibirMsg(msg(g, { from: CS, text: 'Pedido ingresado N° 1234567890' })); assert.equal(r.body.resultado, 'pedido_ingresado');
  assert.equal(await estadoCot(c), 'Pedido ingresado al sistema');
});

test('R3 una sola confirmacion no cierra: solo SAP => sigue "Pago informado"; solo Finanzas => "Pago validado"', async () => {
  const a = await preparar(), b = await preparar();
  await recibirMsg(msg(a.g, { from: CS, text: 'Pedido SAP 1234567890' })); assert.equal(await estadoCot(a.c), 'Pago informado');
  await recibirMsg(msg(b.g, { from: FIN, text: 'Pago validado' })); assert.equal(await estadoCot(b.c), 'Pago validado');
  assert.equal(await eventos(a.c, 'respuesta_cs'), 1);
});

// ================= duplicados / idempotencia =================
test('R4 mensaje duplicado (mismo Message-ID, o reintento del webhook con el mismo svix-id) => efecto UNICO', async () => {
  const { c, g } = await preparar();
  const m = msg(g, { from: CS, text: 'Pedido SAP 1234567890', messageId: '<igual@straumann.com>' });
  assert.equal((await recibirMsg(m)).body.resultado, 'registrado');
  assert.equal((await recibirMsg(m)).body.resultado, 'duplicado', 'reintento identico del webhook');
  const m2 = msg(g, { from: CS, text: 'Pedido SAP 1234567890', messageId: '<igual@straumann.com>' });   // otro email_id/svix-id, mismo Message-ID
  assert.equal((await recibirMsg(m2)).body.resultado, 'duplicado');
  assert.equal(await eventos(c, 'respuesta_cs'), 1);
});

test('R5 el mismo SAP reenviado en otro mensaje no cambia nada; un SAP DISTINTO queda como discrepancia y NO reemplaza al original', async () => {
  const { c, g } = await preparar();
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }));
  const t0 = (await gestion(c)).sap_registrado_en;
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890 (reenvio)' }))).body.resultado, 'registrado');   // mismo valor: sin efecto
  assert.equal((await gestion(c)).sap_registrado_en, t0);
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 9999999999' }))).body.resultado, 'discrepancia_sap');
  const x = await gestion(c); assert.equal(x.sap_numero, '1234567890'); assert.equal(await eventos(c, 'discrepancia_sap'), 1);
});

// ================= ambiguas =================
test('R6 respuestas ambiguas => evento de revision y NINGUN cambio (ni SAP, ni validacion, ni estado)', async () => {
  const { c, g } = await preparar();
  const casos = [
    [CS, 'Pedido SAP 1234567890 y 1234567891'], [CS, 'Pedido SAP 1234567890 pendiente de liberar'], [CS, 'Ya ingresé el pedido, les paso el número luego'],
    [FIN, 'No se ha visto el pago'], [FIN, 'Pago validado pero falta una diferencia'], [FIN, '¿Pueden reenviar el comprobante?'], [FIN, 'Estamos revisando el pago'],
  ];
  for (const [from, text] of casos) { const r = await recibirMsg(msg(g, { from, text })); assert.equal(r.body.resultado, 'ambigua_registrada', text); }
  const x = await gestion(c);
  assert.equal(x.sap_numero, null); assert.equal(x.fin_confirmado_en, null); assert.equal(await estadoCot(c), 'Pago informado');
  assert.equal(await eventos(c, 'respuesta_ambigua'), casos.length);
  assert.equal(await eventos(c, 'respuesta_cs') + await eventos(c, 'respuesta_finanzas'), 0);
});

test('R7 mensajes sin contenido accionable ("Gracias") no generan nada', async () => {
  const { c, g } = await preparar();
  for (const [from, text] of [[CS, 'Gracias, saludos'], [FIN, 'Recibido']]) assert.equal((await recibirMsg(msg(g, { from, text }))).body.resultado, 'sin_contenido_accionable');
  assert.equal(await eventos(c), 0);
});

test('R8 el N° SAP solo existente en el texto CITADO (el correo original) NO se toma', async () => {
  const { c, g } = await preparar();
  const r = await recibirMsg(msg(g, { from: CS, text: 'Gracias, lo reviso\n\nEl lun, 12 oct 2026, Recetario <x@y.cl> escribió:\n> Pedido SAP 1234567890' }));
  assert.equal(r.body.resultado, 'sin_contenido_accionable'); assert.equal((await gestion(c)).sap_numero, null);
});

test('R9 el RUT o telefono del paciente no se confunden con el N° SAP', async () => {
  const { c, g } = await preparar({ rut: '16072120-0' });
  const tel = await one(`SELECT paciente_whatsapp FROM cotizaciones WHERE id='${c.id}'`);
  const r = await recibirMsg(msg(g, { from: CS, text: `Pedido del paciente RUT 16072120-0, tel ${tel} ingresado` }));
  assert.equal(r.body.resultado, 'ambigua_registrada'); assert.equal((await gestion(c)).sap_numero, null);
});

// ================= remitentes y autenticacion =================
test('R10 remitente NO autorizado con texto perfecto => no cambia nada; queda evento respuesta_no_autorizada', async () => {
  const { c, g } = await preparar();
  for (const from of ['externo@gmail.com', 'otro@straumann.com', 'Cobranza <externo@evil.cl>']) {
    const r = await recibirMsg(msg(g, { from, text: 'Pago validado. Pedido SAP 1234567890' })); assert.equal(r.body.resultado, 'no_autorizado', from);
  }
  const x = await gestion(c); assert.equal(x.sap_numero, null); assert.equal(x.fin_confirmado_en, null); assert.equal(await estadoCot(c), 'Pago informado');
  assert.equal(await eventos(c, 'respuesta_no_autorizada'), 3);
});

test('R11 nombre visible falso: "cobranza.cl@straumann.com" <atacante@evil.cl> => se usa la direccion real y se rechaza', async () => {
  const { c, g } = await preparar();
  const r = await recibirMsg(msg(g, { from: '"cobranza.cl@straumann.com" <atacante@evil.cl>', text: 'Pago validado' }));
  assert.equal(r.body.resultado, 'no_autorizado'); assert.equal((await gestion(c)).fin_confirmado_en, null);
});

test('R12 autenticacion fallida / ausente / forjada => no cambia nada (remitente autorizado pero no verificable)', async () => {
  const { c, g } = await preparar();
  const malos = [{ dmarc: 'fail', spf: 'pass', dkim: 'pass' }, { dmarc: 'gray', spf: 'pass', dkim: 'pass' }, { dmarc: 'unknown' }, { spf: 'pass', dkim: 'pass' }, {}, null,
    { dmarc: 'PASS ' }, { dmarc: ['pass'] }, { dmarc: true }];
  for (const authentication of malos) { const r = await recibirMsg(msg(g, { from: FIN, text: 'Pago validado', authentication })); assert.equal(r.body.resultado, 'no_autorizado', JSON.stringify(authentication)); }
  assert.equal((await gestion(c)).fin_confirmado_en, null); assert.equal(await estadoCot(c), 'Pago informado');
  assert.equal(await eventos(c, 'respuesta_no_autorizada'), malos.length);
});

test('R13 rol incorrecto: Customer Service diciendo "Pago validado" o Finanzas dando un SAP NO registran nada', async () => {
  const { c, g } = await preparar();
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pago validado' }))).body.resultado, 'sin_contenido_accionable');
  assert.equal((await recibirMsg(msg(g, { from: FIN, text: 'Pedido SAP 1234567890' }))).body.resultado, 'sin_contenido_accionable');
  const x = await gestion(c); assert.equal(x.sap_numero, null); assert.equal(x.fin_confirmado_en, null);
});

test('R14 remitentes INDIVIDUALES: solo si estan autorizados explicitamente (y con el rol que corresponde)', async () => {
  const { c, g } = await preparar();
  assert.equal((await recibirMsg(msg(g, { from: 'ana.cs@straumann.com', text: 'Pedido SAP 1234567890' }))).body.resultado, 'no_autorizado');
  await sh(`INSERT INTO pago_remitentes_autorizados(email, rol, tipo) VALUES ('ana.cs@straumann.com','customer_service','individual'), ('luis.fin@straumann.com','finanzas','individual')`);
  assert.equal((await recibirMsg(msg(g, { from: 'ANA.CS@straumann.com', text: 'Pedido SAP 1234567890', authentication: { dmarc: 'pass' } }))).body.resultado, 'registrado');
  assert.equal((await recibirMsg(msg(g, { from: 'luis.fin@straumann.com', text: 'Pago validado' }))).body.resultado, 'pedido_ingresado');
  await sh(`UPDATE pago_remitentes_autorizados SET activo=false WHERE email='ana.cs@straumann.com'`);
  const d = await preparar(); assert.equal((await recibirMsg(msg(d.g, { from: 'ana.cs@straumann.com', text: 'Pedido SAP 1234567890' }))).body.resultado, 'no_autorizado', 'desactivado');
});

// ================= hilo =================
test('R15 token desconocido, ausente, de otro dominio, o gestion NO enviada => se descarta sin tocar nada', async () => {
  const { c, g } = await preparar();
  const sinEnviar = await preparar({ enviar: false });
  const casos = [
    [entrante({ from: CS, token: 'f'.repeat(32), text: 'Pedido SAP 1234567890' }), 'token_desconocido'],
    [entrante({ from: CS, to: ['alguien@recetariostra.cl'], text: 'Pedido SAP 1234567890' }), 'sin_token'],
    [entrante({ from: CS, to: [`reply+${g.reply_token}@otro-dominio.cl`], text: 'Pedido SAP 1234567890' }), 'sin_token'],
    [entrante({ from: CS, token: sinEnviar.g.reply_token, text: 'Pedido SAP 1234567890' }), 'gestion_no_enviada'],
    [entrante({ from: CS, to: [`reply+${g.reply_token}@${H.DOMINIO}`, `reply+${sinEnviar.g.reply_token}@${H.DOMINIO}`], text: 'Pedido SAP 1234567890' }), 'sin_token'],
  ];
  for (const [m, esp] of casos) assert.equal((await recibirMsg(m)).body.resultado, esp);
  assert.equal((await gestion(c)).sap_numero, null); assert.equal((await gestion(sinEnviar.c)).sap_numero, null);
});

test('R16 firma del webhook invalida o ausente => 401 y la BD no se toca', async () => {
  const { c, g } = await preparar(); let llamadas = 0;
  const deps = { rpc: async (...a) => { llamadas++; return H.rpc(...a); } };
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890', firmaMala: true }), deps)).status, 401);
  assert.equal((await recibirMsg({ ...msg(g, { from: CS, text: 'Pedido SAP 1234567890' }), svixSignature: null }, deps)).status, 401);
  assert.equal((await recibirMsg({ ...msg(g, { from: CS, text: 'Pedido SAP 1234567890' }), rawBody: '{}' }, deps)).status, 401);
  assert.equal(llamadas, 0); assert.equal((await gestion(c)).sap_numero, null);
});

// ================= interruptor y estados =================
test('R17 confirmaciones_activo=false (valor por defecto): la BD responde "desactivado" y no registra nada', async () => {
  const { c, g } = await preparar({ confirmaciones: false });
  assert.equal(await one(`SELECT valor FROM pago_gestion_config WHERE clave='confirmaciones_activo'`), 'false');
  for (const [from, text] of [[CS, 'Pedido SAP 1234567890'], [FIN, 'Pago validado'], [FIN, 'No hay pago'], ['x@evil.cl', 'Pago validado']]) {
    const r = await recibirMsg(msg(g, { from, text })); assert.ok(['desactivado'].includes(r.body.resultado), `${from}: ${r.body.resultado}`);
  }
  assert.equal(await eventos(c), 0); assert.equal(await estadoCot(c), 'Pago informado');
});

test('R18 si Nicole/Finanzas ya movieron la cotizacion a mano (p. ej. "Despachado"), no se retrocede ni se pisa', async () => {
  const { c, g } = await preparar();
  await sh(`UPDATE cotizaciones SET estado='Despachado' WHERE id='${c.id}'`);
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }));
  assert.equal((await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }))).body.resultado, 'estado_no_aplicable');
  assert.equal(await estadoCot(c), 'Despachado'); assert.equal(await eventos(c, 'estado_no_aplicable'), 1);
});

test('R19 gestiones historicas (ya procesadas a mano) ignoran respuestas', async () => {
  const hist = JSON.parse(await one(`SELECT to_jsonb(g) FROM pago_gestiones g WHERE estado_envio='omitido_historico' LIMIT 1`));
  await cfgSet('confirmaciones_activo', 'true');
  const r = await recibirMsg(entrante({ from: CS, token: hist.reply_token, text: 'Pedido SAP 1234567890' }));
  assert.equal(r.body.resultado, 'gestion_no_enviada');
});

test('R20 N° SAP con formato fuera de lo configurado (sap_regex) => a revision, no se registra', async () => {
  const { c, g } = await preparar();
  const r = await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 123456' }));   // 6 digitos: el analizador lo propone, la BD (^[0-9]{10}$) lo manda a revision
  assert.equal(r.body.resultado, 'sap_a_revision'); assert.equal((await gestion(c)).sap_numero, null); assert.equal(await eventos(c, 'respuesta_ambigua'), 1);
});

test('R21 error transitorio (cuerpo no disponible / BD caida) => 503 para que Resend reintente; al reintentar se procesa una sola vez', async () => {
  const { c, g } = await preparar();
  const m = msg(g, { from: CS, text: 'Pedido SAP 1234567890', sinCuerpo: true });
  assert.equal((await recibirMsg(m)).status, 503);
  cuerpos.set(m._emailId, { text: 'Pedido SAP 1234567890', html: null, headers: {}, authentication: AUTH_OK });
  assert.equal((await recibirMsg(m)).body.resultado, 'registrado');
  let falla = true; const deps = { rpc: async (n, a) => (falla && n === 'pago_gestion_registrar_confirmacion' ? { data: null, error: { code: 'PG' } } : H.rpc(n, a)) };
  const m2 = msg(g, { from: FIN, text: 'Pago validado' });
  assert.equal((await recibirMsg(m2, deps)).status, 503); falla = false;
  assert.equal((await recibirMsg(m2, deps)).body.resultado, 'pedido_ingresado');
  assert.equal(await eventos(c, 'respuesta_finanzas'), 1);
});

test('R22 solo HTML (sin texto plano): se extrae el texto nuevo', async () => {
  const { c, g } = await preparar();
  const r = await recibirMsg(msg(g, { from: CS, text: '', html: '<div>Pedido SAP <b>1234567890</b></div><blockquote>Pedido SAP 0000000000</blockquote>' }));
  assert.equal(r.body.resultado, 'registrado'); assert.equal((await gestion(c)).sap_numero, '1234567890');
});

// ================= seguridad de logs y aislamiento =================
test('R23 logs del receptor sin datos personales (correos, SAP, texto, tokens, nombres)', async () => {
  LOGS = [];
  const { c, g } = await preparar({ paciente: 'Zoila Unica Ñandú', rut: '11111111-1' });
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 7777777777' })); await recibirMsg(msg(g, { from: 'externo@evil.cl', text: 'Pago validado' }));
  await recibirMsg(msg(g, { from: FIN, text: 'Pago validado pero falta algo' })); await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }));
  const blob = LOGS.join('\n'); assert.ok(blob.includes('confirmacion'));
  for (const p of [g.reply_token, '@', '7777777777', 'Zoila', '11111111', 'straumann', 'evil', 'falta algo', H.WEBHOOK_SECRET, 'em_']) assert.ok(!blob.includes(p), 'filtra: ' + p);
  assert.deepEqual(safeLog({ ev: 'x', email: 'a@b.cl', resultado: 'a@b.cl', token: 't', gid: 'abc' }), { ev: 'x', gid: 'abc' });
});

test('R24 el receptor no modifica cotizaciones salvo por la funcion de B3 (checksum de pagos y datos de paciente intactos)', async () => {
  const { c, g } = await preparar();
  const snap = () => one(`SELECT md5(string_agg(x,'|' ORDER BY x)) FROM (SELECT (to_jsonb(c)-'estado'-'historial'-'updated_at')::text x FROM cotizaciones c UNION ALL SELECT to_jsonb(p)::text FROM cotizacion_pagos p) t`);
  const antes = await snap();
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' })); await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }));
  assert.equal(await snap(), antes);
});

test('R25 funciones B4: solo service_role puede ejecutarlas (anon y authenticated no)', async () => {
  for (const f of ["pago_remitente_rol('a@b.cl')", "pago_gestion_resolver_respuesta('x')", "pago_gestion_registrar_ambigua(gen_random_uuid(),'d','a@b.cl','m','e')"]) {
    for (const rol of ['anon', 'authenticated']) {
      const r = await H.psql(`SET ROLE ${rol}; SELECT ${f};`); assert.match(r.err, /permission denied/, `${rol} ${f}`);
    }
  }
});

test('R26 emisor y receptor comparten el mismo dominio de respuesta; la direccion que genera el emisor es la que el receptor reconoce', async () => {
  const { g } = await preparar();
  const dir = mock.reqs[0].body.reply_to;
  assert.match(dir, new RegExp(`^reply\\+${g.reply_token}@${H.DOMINIO.replace(/\./g, '\\.')}$`));
});
