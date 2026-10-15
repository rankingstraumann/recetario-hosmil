// Fase E (local): identificacion del hilo por Reply-To + token unico, orden/duplicados/no autorizados, y aislamiento (nada ajeno cambia).
// Mismo montaje que recepcion.integracion.test.mjs: Postgres LOCAL desechable + mock de Resend + correos entrantes simulados. Nada toca produccion.
process.env.TZ = 'America/Santiago';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { handle as emitir } from '../../enviar-gestion-pago/logic.ts';
import { handle as recibir } from '../logic.ts';
import * as H from './helpers.mjs';
const { sh, one, mkCot, pagar, gestion, estadoCot, eventos, cfgSet, CS, FIN } = H;
if (!H.DIR) { console.error('Falta PAGOS_FASE_B_DIR'); process.exit(2); }

let mock, cuerpos, entrante, LOGS = [];
test.before(async () => { mock = await H.mockResend(); });
test.after(() => mock.close());
test.beforeEach(async () => { await H.reset(); mock.reqs.length = 0; cuerpos = new Map(); entrante = H.fabricaEntrantes(cuerpos); });

async function preparar({ inst = 'UDP', total = 100000, enviar = true, confirmaciones = true } = {}) {
  const c = await mkCot({ inst, total }); await pagar(c, total);
  if (enviar) { await sh(`UPDATE pago_gestion_config SET valor='true' WHERE clave='envio_activo'`); await emitir(H.SECRET_EMISOR, H.depsEmisor(mock, {}, LOGS)); }
  if (confirmaciones) await cfgSet('confirmaciones_activo', 'true');
  return { c, g: await gestion(c) };
}
const recibirMsg = (m, over = {}) => recibir(m, H.depsReceptor(cuerpos, over, LOGS));
const msg = (g, o) => entrante({ token: g.reply_token, ...o });
const historialN = (c) => one(`SELECT jsonb_array_length(historial) FROM cotizaciones WHERE id='${c.id}'`);
const idsSql = (cs) => cs.map((c) => `'${c.id}'`).join(',');
/** Huella de cotizaciones + gestiones + eventos de un conjunto de cotizaciones (para probar que NO cambian). */
const huella = (cs) => one(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY k),'')) FROM (
  SELECT 'c'||id::text k, to_jsonb(c)::text x FROM cotizaciones c WHERE id IN (${idsSql(cs)})
  UNION ALL SELECT 'g'||id::text, to_jsonb(g)::text FROM pago_gestiones g WHERE cotizacion_id IN (${idsSql(cs)})
  UNION ALL SELECT 'e'||id::text, to_jsonb(e)::text FROM pago_gestion_eventos e WHERE cotizacion_id IN (${idsSql(cs)})) s`);

// ================= identificacion del hilo (Reply-To + token) =================
test('H1 el token se reconoce en to, cc o received_for (Responder / Responder a todos / copia oculta)', async () => {
  for (const variante of [{ to: undefined }, { to: ['otro@straumann.com'], cc: [`reply+TOKEN@${H.DOMINIO}`] }, { to: ['otro@straumann.com'], receivedFor: [`reply+TOKEN@${H.DOMINIO}`] }]) {
    await H.reset(); cuerpos = new Map(); entrante = H.fabricaEntrantes(cuerpos);
    const { c, g } = await preparar();
    const f = (a) => (Array.isArray(a) ? a.map((x) => x.replace('TOKEN', g.reply_token)) : a);
    const r = await recibirMsg(entrante({ from: CS, token: g.reply_token, text: 'Pedido SAP 1234567890', to: f(variante.to), cc: f(variante.cc) ?? [], receivedFor: f(variante.receivedFor) ?? [] }));
    assert.equal(r.body.resultado, 'registrado', JSON.stringify(variante)); assert.equal((await gestion(c)).sap_numero, '1234567890');
  }
});

test('H2 dos gestiones abiertas a la vez, respuestas ENTRELAZADAS: cada token afecta solo a su cotizacion', async () => {
  const A = await preparar(), B = await preparar();
  assert.notEqual(A.g.reply_token, B.g.reply_token);
  await recibirMsg(msg(A.g, { from: CS, text: 'Pedido SAP 1111111111' }));
  await recibirMsg(msg(B.g, { from: FIN, text: 'Pago validado' }));
  await recibirMsg(msg(B.g, { from: CS, text: 'Pedido SAP 2222222222' }));
  assert.equal(await estadoCot(B.c), 'Pedido ingresado al sistema'); assert.equal(await estadoCot(A.c), 'Pago informado');
  assert.equal((await gestion(A.c)).fin_confirmado_en, null, 'A no recibio Finanzas');
  await recibirMsg(msg(A.g, { from: FIN, text: 'Pago validado' }));
  assert.equal(await estadoCot(A.c), 'Pedido ingresado al sistema');
  assert.equal((await gestion(A.c)).sap_numero, '1111111111'); assert.equal((await gestion(B.c)).sap_numero, '2222222222');
});

test('H3 asunto/cuerpo/cita con OTRO numero de cotizacion o el token de otra gestion NO se usan: manda solo la direccion de destino', async () => {
  const A = await preparar(), B = await preparar();
  const m = entrante({ from: CS, token: A.g.reply_token, text: `Cotizacion C-${B.c.n}: Pedido SAP 3333333333\n\nCita: reply+${B.g.reply_token}@${H.DOMINIO}` });
  const r = await recibirMsg(m);
  assert.equal(r.body.resultado, 'registrado');
  assert.equal((await gestion(A.c)).sap_numero, '3333333333'); assert.equal((await gestion(B.c)).sap_numero, null);
});

test('H4 tokens casi validos (31/33 hex, no hex, sufijo +extra, otro prefijo) => sin_token y NADA cambia; mayusculas SI se aceptan', async () => {
  const { c, g } = await preparar(); const antes = await huella([c]);
  const T = g.reply_token;
  for (const dir of [`reply+${T.slice(1)}@${H.DOMINIO}`, `reply+${T}0@${H.DOMINIO}`, `reply+${'z'.repeat(32)}@${H.DOMINIO}`, `reply+${T}+x@${H.DOMINIO}`, `respuesta+${T}@${H.DOMINIO}`, `reply+${T}@${H.DOMINIO}.evil.cl`, `reply+${T}@recetariostra.cl`]) {
    const r = await recibirMsg(entrante({ from: CS, token: T, to: [dir], text: 'Pedido SAP 1234567890' }));
    assert.equal(r.body.resultado, 'sin_token', dir);
  }
  assert.equal(await huella([c]), antes, 'ninguna variante inexacta toca la BD');
  assert.equal((await recibirMsg(entrante({ from: CS, token: T, to: [`REPLY+${T.toUpperCase()}@${H.DOMINIO.toUpperCase()}`], text: 'Pedido SAP 1234567890' }))).body.resultado, 'registrado');
});

test('H5 mensaje con DOS tokens distintos (Responder a todos entre dos hilos) => ambiguo: sin_token y nada cambia', async () => {
  const A = await preparar(), B = await preparar(); const antes = await huella([A.c, B.c]);
  const r = await recibirMsg(entrante({ from: CS, token: A.g.reply_token, to: [`reply+${A.g.reply_token}@${H.DOMINIO}`, `reply+${B.g.reply_token}@${H.DOMINIO}`], text: 'Pedido SAP 1234567890' }));
  assert.equal(r.body.resultado, 'sin_token'); assert.equal(await huella([A.c, B.c]), antes);
});

test('H6 el token es opaco: 32 hex, unico, sin relacion con id/numero de la cotizacion ni con sus hashes', async () => {
  const gs = []; for (let i = 0; i < 6; i++) gs.push(await preparar());
  const toks = gs.map((x) => x.g.reply_token);
  assert.equal(new Set(toks).size, 6);
  for (const { c, g } of gs) {
    assert.match(g.reply_token, /^[a-f0-9]{32}$/);
    const t = g.reply_token;
    for (const base of [c.id, c.id.replace(/-/g, ''), `C-${c.n}`, String(c.n), c.token]) {
      assert.ok(!t.includes(base.replace(/-/g, '')) || base.length < 4, 'no contiene ' + base);
      for (const alg of ['md5', 'sha1', 'sha256']) assert.ok(!createHash(alg).update(base).digest('hex').startsWith(t.slice(0, 12)), `no es ${alg}(${base})`);
    }
  }
  // gen_random_uuid(): version 4 => 122 bits aleatorios (los 6 bits fijos son el nibble de version y 2 bits de variante)
  for (const t of toks) assert.equal(t[12], '4');
});

// ================= orden, concurrencia, duplicados y no autorizados =================
test('O1 CS y Finanzas llegan EN PARALELO => "Pedido ingresado" una sola vez (un solo cambio de estado en el historial)', async () => {
  const { c, g } = await preparar(); const n0 = Number(await historialN(c));
  const [a, b] = await Promise.all([recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' })), recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(await estadoCot(c), 'Pedido ingresado al sistema');
  const x = await gestion(c); assert.ok(x.sap_numero && x.fin_confirmado_en && x.pedido_aplicado_en);
  assert.equal(await one(`SELECT count(*) FROM cotizaciones, jsonb_array_elements(historial) h WHERE id='${c.id}' AND h->>'estado'='Pedido ingresado al sistema'`), '1');
  assert.ok(Number(await historialN(c)) - n0 <= 2, 'a lo sumo Pago validado + Pedido ingresado');
});

test('O2 duplicados: mismo Message-ID con otro svix-id; Finanzas repetida con otro Message-ID; reenvio tras cerrar => sin efecto adicional', async () => {
  const { c, g } = await preparar();
  const m = msg(g, { from: FIN, text: 'Pago validado', messageId: '<fin-1@straumann.com>' });
  assert.equal((await recibirMsg(m)).body.resultado, 'pago_validado');
  const f1 = (await gestion(c)).fin_confirmado_en;
  const dup = entrante({ from: FIN, token: g.reply_token, text: 'Pago validado', messageId: '<fin-1@straumann.com>' });
  assert.equal((await recibirMsg(dup)).body.resultado, 'duplicado');
  await recibirMsg(msg(g, { from: FIN, text: 'Pago validado otra vez', messageId: '<fin-2@straumann.com>' }));
  assert.equal((await gestion(c)).fin_confirmado_en, f1, 'la primera confirmacion no se pisa');
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }));
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }));
  await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }));
  assert.equal(await estadoCot(c), 'Pedido ingresado al sistema');
  const x = await gestion(c); assert.equal(x.sap_numero, '1234567890'); assert.equal(x.fin_confirmado_en, f1);
  assert.equal(await one(`SELECT count(*) FROM cotizaciones, jsonb_array_elements(historial) h WHERE id='${c.id}' AND h->>'estado'='Pedido ingresado al sistema'`), '1');
});

test('O3 no autorizados ANTES, ENTRE y DESPUES de los legitimos no bloquean ni alteran el flujo legitimo', async () => {
  const { c, g } = await preparar();
  const intrusos = [{ from: 'intruso@gmail.com', text: 'Pedido SAP 9999999999' }, { from: '"m.cl.customerservicechile@straumann.com" <atacante@evil.cl>', text: 'Pedido SAP 8888888888' }, { from: 'cobranza.cl@straumann.com.evil.cl', text: 'Pago validado' }];
  for (const i of intrusos) assert.equal((await recibirMsg(msg(g, i))).body.resultado, 'no_autorizado');
  assert.equal((await gestion(c)).sap_numero, null); assert.equal(await estadoCot(c), 'Pago informado');
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'registrado');
  assert.equal((await recibirMsg(msg(g, { from: intrusos[0].from, text: 'Pedido SAP 7777777777' }))).body.resultado, 'no_autorizado');
  assert.equal((await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }))).body.resultado, 'pedido_ingresado');
  const x = await gestion(c); assert.equal(x.sap_numero, '1234567890'); assert.equal(await eventos(c, 'respuesta_no_autorizada'), 4);
});

test('O4 un remitente individual desactivado a mitad del flujo deja de valer; lo ya registrado se conserva', async () => {
  const { c, g } = await preparar();
  await sh(`INSERT INTO pago_remitentes_autorizados(email, rol, tipo) VALUES ('ana.cs@straumann.com','customer_service','individual')`);
  assert.equal((await recibirMsg(msg(g, { from: 'ana.cs@straumann.com', text: 'Pedido SAP 1234567890' }))).body.resultado, 'registrado');
  await sh(`UPDATE pago_remitentes_autorizados SET activo=false WHERE email='ana.cs@straumann.com'`);
  assert.equal((await recibirMsg(msg(g, { from: 'ana.cs@straumann.com', text: 'Pedido SAP 5555555555' }))).body.resultado, 'no_autorizado');
  assert.equal((await gestion(c)).sap_numero, '1234567890');
  assert.equal((await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }))).body.resultado, 'pedido_ingresado');
});

// ================= aislamiento: nada ajeno cambia =================
test('I1 CANARIOS: una cotizacion sin gestion, una con gestion pendiente (no enviada) y otra enviada pero sin respuesta NO cambian mientras se procesa otra completa', async () => {
  const objetivo = await preparar();                                           // enviada: es la unica que recibira respuestas
  const otraEnviada = await preparar();                                         // enviada, nadie le responde
  await sh(`UPDATE pago_gestion_config SET valor='false' WHERE clave='envio_activo'`);   // desde aqui el emisor NO envia mas
  const pendiente = await preparar({ enviar: false });                          // pago + gestion pendiente (no enviada)
  assert.equal(pendiente.g.estado_envio, 'pendiente');
  const sinPago = await mkCot({});                                              // sin pago => sin gestion
  const objetivoEnviada = { c: objetivo.c, g: await gestion(objetivo.c) };
  const canarios = [sinPago, pendiente.c, otraEnviada.c];
  const antes = await huella(canarios);
  const { c, g } = objetivoEnviada;
  await recibirMsg(msg(g, { from: 'intruso@gmail.com', text: 'Pedido SAP 9999999999' }));
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }));
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }));
  await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }));
  await recibirMsg(entrante({ from: CS, token: 'f'.repeat(32), text: 'Pedido SAP 1234567890' }));      // token inexistente
  await recibirMsg(msg(pendiente.g, { from: CS, text: 'Pedido SAP 4444444444' }));                      // token de gestion NO enviada
  assert.equal(await estadoCot(c), 'Pedido ingresado al sistema');
  assert.equal(await huella(canarios), antes, 'los canarios quedaron byte a byte iguales');
});

test('I2 la funcion de prueba aislada NO tiene acceso a BD ni a cotizaciones (analisis estatico del codigo)', () => {
  const dir = join(H.FUNC, 'recepcion-prueba-pago');
  const src = ['index.ts', 'logic.ts'].map((f) => readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '')).join('\n');   // sin comentarios
  for (const prohibido of ['createClient', 'supabase-js', 'SERVICE_ROLE', 'SUPABASE_URL', '.rpc(', "from('", 'cotizaciones', 'pago_gestion', 'INSERT', 'UPDATE ']) assert.ok(!src.includes(prohibido), 'no debe contener: ' + prohibido);
  const imports = [...src.matchAll(/import[^;]*from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./logic.ts', './reglas_copia.ts'], 'autocontenida: solo archivos de su propia carpeta, sin npm: ni URLs');
  assert.ok(!/\bimport\b/.test(readFileSync(join(dir, 'reglas_copia.ts'), 'utf8').replace(/\/\/.*$/gm, '')), 'reglas_copia.ts no importa nada');
  assert.ok(!/method\s*:\s*'(POST|PUT|PATCH|DELETE)'/.test(src), 'solo lecturas (GET) hacia Resend');
});

test('I3 auditoria_aislamiento.sql (solo lectura): tras un ensayo lista EXACTAMENTE las cotizaciones tocadas y ninguna otra', async () => {
  const objetivo = await preparar(), ajena = await preparar();
  await recibirMsg(msg(objetivo.g, { from: CS, text: 'Pedido SAP 1234567890' }));
  await recibirMsg(msg(objetivo.g, { from: FIN, text: 'Pago validado' }));
  await recibirMsg(msg(ajena.g, { from: 'intruso@gmail.com', text: 'Pedido SAP 9999999999' }));
  const sql = readFileSync(join(H.DIR, 'auditoria_aislamiento.sql'), 'utf8');
  assert.ok(/READ ONLY/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i.test(sql.replace(/--.*$/gm, '')), 'el script es de solo lectura');
  const out = await sh(sql);
  assert.ok(out.includes(`C-${objetivo.c.n}`), 'lista la cotizacion tocada');
  const modificadas = out.split('\n').filter((l) => l.startsWith('MODIFICADA|'));
  assert.deepEqual(modificadas.map((l) => l.split('|')[1]), [`C-${objetivo.c.n}`]);
  assert.ok(modificadas.every((l) => l.endsWith('|true')), 'la tocada esta en la lista de prueba');
  assert.equal(out.split('\n').filter((l) => l.startsWith('ALERTA|')).length, 0, 'sin alertas');
  assert.ok(out.split('\n').some((l) => l.startsWith('LISTA_PRUEBA|')), 'lista la lista de prueba vigente');
});
