// PROTECCION DEL MODO PRUEBA (local): mientras config.modo<>'real', ninguna cotizacion REAL (fuera de la lista explicita de prueba)
// recibe confirmaciones SAP/financieras, aunque el remitente sea valido, el token sea el correcto y DMARC sea pass. Pruebas negativas + modo real.
process.env.TZ = 'America/Santiago';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handle as emitir } from '../../enviar-gestion-pago/logic.ts';
import { handle as recibir } from '../logic.ts';
import * as H from './helpers.mjs';
const { sh, one, psql, mkCot, pagar, gestion, estadoCot, eventos, cfgSet, CS, FIN } = H;
if (!H.DIR) { console.error('Falta PAGOS_FASE_B_DIR'); process.exit(2); }

let mock, cuerpos, entrante, LOGS = [];
test.before(async () => { mock = await H.mockResend(); });
test.after(() => mock.close());
test.beforeEach(async () => { await H.reset(); mock.reqs.length = 0; cuerpos = new Map(); entrante = H.fabricaEntrantes(cuerpos); LOGS = []; });

/** Cotizacion pagada y con correo interno enviado (modo prueba: solo a Daniel). real=true => NO esta en la lista de prueba. Confirmaciones activas. */
async function preparar({ real = false } = {}) {
  const c = await mkCot({ prueba: !real }); await pagar(c, 100000);
  await sh(`UPDATE pago_gestion_config SET valor='true' WHERE clave='envio_activo'`); await emitir(H.SECRET_EMISOR, H.depsEmisor(mock, {}, LOGS));
  await cfgSet('confirmaciones_activo', 'true');
  return { c, g: await gestion(c) };
}
const recibirMsg = (m, over = {}) => recibir(m, H.depsReceptor(cuerpos, over, LOGS));
const msg = (g, o) => entrante({ token: g.reply_token, ...o });
const idsSql = (cs) => cs.map((c) => `'${c.id}'`).join(',');
const huella = (cs) => one(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY k),'')) FROM (
  SELECT 'c'||id::text k, to_jsonb(c)::text x FROM cotizaciones c WHERE id IN (${idsSql(cs)})
  UNION ALL SELECT 'g'||id::text, to_jsonb(g)::text FROM pago_gestiones g WHERE cotizacion_id IN (${idsSql(cs)})
  UNION ALL SELECT 'e'||id::text, to_jsonb(e)::text FROM pago_gestion_eventos e WHERE cotizacion_id IN (${idsSql(cs)})) s`);
const sqlRpc = (fn, ...a) => one(`SET ROLE service_role; SELECT public.${fn}(${a.map(H.lit).join(',')})`);
const errSql = async (q) => (await psql(`SET ROLE service_role; ${q}`)).err;
const MODOS_NO_REALES = ['prueba', '', 'Real', 'REAL', ' real', 'real ', 'true', 'produccion', 'reall'];

test('M1 modo prueba + cotizacion REAL + remitente valido + token correcto + DMARC pass: CS y Finanzas NO cambian nada (cero escrituras)', async () => {
  const { c, g } = await preparar({ real: true });
  assert.equal(await one(`SELECT valor FROM pago_gestion_config WHERE clave='modo'`), 'prueba');
  const antes = await huella([c]);
  for (const [from, text] of [[CS, 'Pedido SAP 1234567890'], [FIN, 'Pago validado'], [CS, 'No se si es 1234567890 o 999'], ['intruso@gmail.com', 'Pedido SAP 1234567890']]) {
    const r = await recibirMsg(msg(g, { from, text }));
    assert.deepEqual([r.status, r.body.resultado], [200, 'bloqueado_modo_prueba'], from);
  }
  assert.equal(await huella([c]), antes, 'ni cotizacion, ni gestion, ni eventos (tampoco "no autorizado" ni "ambigua") cambiaron');
  assert.equal(await estadoCot(c), 'Pago informado'); const x = await gestion(c); assert.equal(x.sap_numero, null); assert.equal(x.fin_confirmado_en, null);
});

test('M2 el receptor ni siquiera lee el cuerpo ni llama a la BD de confirmacion para una gestion real en modo prueba', async () => {
  const { g } = await preparar({ real: true }); const rpcs = []; let cuerpoLeido = 0;
  const m = msg(g, { from: CS, text: 'Pedido SAP 1234567890' });
  const r = await recibirMsg(m, { rpc: async (n, a) => { rpcs.push(n); return H.rpc(n, a); }, obtenerCuerpo: async () => { cuerpoLeido++; return null; } });
  assert.equal(r.body.resultado, 'bloqueado_modo_prueba'); assert.deepEqual(rpcs, ['pago_gestion_resolver_respuesta']); assert.equal(cuerpoLeido, 0);
});

test('M3 las FUNCIONES SQL por si solas (sin pasar por el receptor) tambien bloquean: confirmacion SAP, financiera y ambigua', async () => {
  const { c, g } = await preparar({ real: true }); const antes = await huella([c]);
  assert.equal(await sqlRpc('pago_gestion_registrar_confirmacion', g.gestion_id ?? g.id, 'sap', 'x1', '1234567890', CS, true), 'bloqueado_modo_prueba');
  assert.equal(await sqlRpc('pago_gestion_registrar_confirmacion', g.id, 'finanzas', 'x2', '', FIN, true), 'bloqueado_modo_prueba');
  assert.equal(await sqlRpc('pago_gestion_registrar_confirmacion', g.id, 'sap', 'x3', '1234567890', 'intruso@gmail.com', false), 'bloqueado_modo_prueba');
  assert.equal(await sqlRpc('pago_gestion_registrar_ambigua', g.id, 'x4', CS, 'm', 'texto'), 'bloqueado_modo_prueba');
  assert.equal(await huella([c]), antes);
});

test('M4 el TRIGGER impide escribir SAP / validacion / pedido aplicado sobre una gestion real aunque se haga UPDATE directo (service_role)', async () => {
  const { c, g } = await preparar({ real: true }); const antes = await huella([c]);
  for (const set of [`sap_numero='1234567890'`, `sap_registrado_en=now()`, `sap_evento_dedupe='z'`, `fin_confirmado_en=now()`, `fin_evento_dedupe='z'`, `pedido_aplicado_en=now()`]) {
    assert.match(await errSql(`UPDATE public.pago_gestiones SET ${set} WHERE id='${g.id}'`), /modo_prueba/, set);
  }
  assert.equal(await huella([c]), antes, 'ningun UPDATE directo prospero');
  // columnas operativas (entrega, updated_at, error) NO estan protegidas: el emisor sigue funcionando
  assert.equal(await errSql(`UPDATE public.pago_gestiones SET updated_at=now(), entrega_estado='entregado' WHERE id='${g.id}'`), '');
  // INSERT de una gestion real con SAP ya cargado tambien se bloquea
  const c2 = await mkCot({ prueba: false });
  assert.match(await errSql(`INSERT INTO public.pago_gestiones(cotizacion_id, sap_numero) VALUES ('${c2.id}','1234567890')`), /modo_prueba/);
  // cotizacion de PRUEBA: permitido
  const cp = await mkCot({ prueba: true });
  assert.equal(await errSql(`INSERT INTO public.pago_gestiones(cotizacion_id, sap_numero) VALUES ('${cp.id}','1234567890')`), '');
});

test('M5 segunda barrera: pago_gestion_exigir_modificable lanza excepcion para real y deja pasar a prueba y a modo real', async () => {
  const real = await mkCot({ prueba: false }), prueba = await mkCot({ prueba: true });
  assert.match(await errSql(`SELECT public.pago_gestion_exigir_modificable('${real.id}')`), /modo_prueba/);
  assert.equal(await errSql(`SELECT public.pago_gestion_exigir_modificable('${prueba.id}')`), '');
  await cfgSet('modo', 'real');
  assert.equal(await errSql(`SELECT public.pago_gestion_exigir_modificable('${real.id}')`), '');
});

test('M6 modo prueba MEZCLADO: la cotizacion de prueba completa su flujo; la real queda byte a byte igual', async () => {
  const T = await preparar(), R = await preparar({ real: true }); const antesR = await huella([R.c]);
  assert.equal((await recibirMsg(msg(T.g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'registrado');
  assert.equal((await recibirMsg(msg(T.g, { from: FIN, text: 'Pago validado' }))).body.resultado, 'pedido_ingresado');
  assert.equal(await estadoCot(T.c), 'Pedido ingresado al sistema');
  await recibirMsg(msg(R.g, { from: CS, text: 'Pedido SAP 1234567890' })); await recibirMsg(msg(R.g, { from: FIN, text: 'Pago validado' }));
  assert.equal(await huella([R.c]), antesR); assert.equal(await estadoCot(R.c), 'Pago informado');
});

test('M7 fail-closed: cualquier valor de modo distinto de "real" exacto (o fila ausente) bloquea la cotizacion real', async () => {
  const { c, g } = await preparar({ real: true });
  for (const v of MODOS_NO_REALES) {
    await sh(`UPDATE pago_gestion_config SET valor=${H.lit(v)} WHERE clave='modo'`);
    assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'bloqueado_modo_prueba', JSON.stringify(v));
  }
  await sh(`DELETE FROM pago_gestion_config WHERE clave='modo'`);
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'bloqueado_modo_prueba', 'fila ausente');
  assert.equal((await gestion(c)).sap_numero, null);
});

test('M8 comportamiento productivo previsto (solo local): con modo EXACTAMENTE "real" la misma cotizacion real procesa SAP + Finanzas como antes', async () => {
  const { c, g } = await preparar({ real: true });
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'bloqueado_modo_prueba');
  await cfgSet('modo', 'real');
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'registrado');
  assert.equal((await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }))).body.resultado, 'pedido_ingresado');
  assert.equal(await estadoCot(c), 'Pedido ingresado al sistema'); assert.equal((await gestion(c)).sap_numero, '1234567890');
  await cfgSet('modo', 'prueba');   // volver a modo prueba no revierte lo hecho pero vuelve a proteger
  const d = await preparar({ real: true });
  assert.equal((await recibirMsg(msg(d.g, { from: CS, text: 'Pedido SAP 2222222222' }))).body.resultado, 'bloqueado_modo_prueba');
});

test('M9 la lista de prueba es opt-in y reversible: quitar la cotizacion de la lista la vuelve a proteger; la lista no se llena sola', async () => {
  assert.equal(await one(`SELECT count(*) FROM pago_gestion_cotizaciones_prueba`), '0', 'tras instalar, la lista esta VACIA');
  const { c, g } = await preparar();   // marcada explicitamente por el ensayo
  assert.equal(await one(`SELECT count(*) FROM pago_gestion_cotizaciones_prueba`), '1');
  assert.equal((await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890' }))).body.resultado, 'registrado');
  await H.desmarcarPrueba(c);
  const antes = await huella([c]);
  assert.equal((await recibirMsg(msg(g, { from: FIN, text: 'Pago validado' }))).body.resultado, 'bloqueado_modo_prueba');
  assert.equal(await huella([c]), antes);
  // pagos de pacientes (RPC publica) NO agregan cotizaciones a la lista de prueba
  const n = await mkCot({ prueba: false }); await pagar(n, 100000);
  assert.equal(await one(`SELECT count(*) FROM pago_gestion_cotizaciones_prueba`), '0');
});

test('M10 la lista de prueba y las funciones nuevas son privadas: anon y authenticated no pueden leer, insertar ni ejecutar', async () => {
  const c = await mkCot({ prueba: false });
  for (const rol of ['anon', 'authenticated']) {
    for (const q of [`SELECT * FROM public.pago_gestion_cotizaciones_prueba`, `INSERT INTO public.pago_gestion_cotizaciones_prueba(cotizacion_id) VALUES ('${c.id}')`,
      `SELECT public.pago_gestion_puede_modificar('${c.id}')`, `SELECT public.pago_gestion_modo_real()`, `SELECT public.pago_gestion_exigir_modificable('${c.id}')`]) {
      const r = await psql(`SET ROLE ${rol}; ${q}`); assert.match(r.err, /permission denied/, `${rol}: ${q}`);
    }
  }
  assert.equal(await one(`SELECT count(*) FROM pago_gestion_cotizaciones_prueba`), '0');
});

test('M11 el flujo del paciente y las RPC publicas no cambian: registrar_pago_publico sigue funcionando para cotizaciones reales en modo prueba', async () => {
  const c = await mkCot({ prueba: false });
  const r = JSON.parse(await pagar(c, 100000)); assert.equal(r.estado, 'Pago informado');
  assert.equal(await estadoCot(c), 'Pago informado');
});

test('M12 historicas y gestiones no enviadas siguen igual; los logs del bloqueo no filtran datos', async () => {
  const { g } = await preparar({ real: true });
  await recibirMsg(msg(g, { from: CS, text: 'Pedido SAP 1234567890 de Scarlett Salas, RUT 16072120-0' }));
  const log = LOGS.join('\n');
  assert.match(log, /bloqueado_modo_prueba/);
  for (const d of ['1234567890', 'Scarlett', '16072120', CS, g.reply_token, 'straumann.com']) assert.ok(!log.includes(d), 'no debe aparecer ' + d);
});
