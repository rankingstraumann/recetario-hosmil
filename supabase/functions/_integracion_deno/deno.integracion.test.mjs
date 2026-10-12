// Integracion con Deno REAL: se ejecutan los index.ts de ambas Edge Functions (sin modificarlos) contra PostgREST 12.2.3 real
// y la Postgres local (B1+B2+B3+B4). Storage firmado y Resend son falsos (locales). Nada toca produccion ni Resend real.
process.env.TZ = 'America/Santiago';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as G from './harness.mjs';
import * as H from '../recibir-respuesta-pago/test/helpers.mjs';
const { sh, one, mkCot, pagar, gestion, estadoCot, eventos, cfgSet, CS, FIN, AUTH_OK } = H;
if (!H.DIR || !process.env.PAGOS_TOOLS_DIR) { console.error('Faltan PAGOS_FASE_B_DIR / PAGOS_TOOLS_DIR'); process.exit(2); }

const cuerpos = new Map(), enviados = [], lecturas = [];
let pgrst, router, mockSrv, emisor, receptor, falla = () => false, entrante;
const SECRETO = H.SECRET_EMISOR, SERVICE = G.jwt('service_role');
const post = (url, headers = {}, body = '') => fetch(url, { method: 'POST', headers, body });

test.before(async () => {
  await H.reset();
  pgrst = await G.levantarPostgREST(3410, { psql: H.psql });
  router = await G.levantarRouter(3410, { fallaStorage: (p) => falla(p) });
  // Mock de Resend: POST /emails (envio) y GET /emails/receiving/:id (lectura del correo recibido)
  mockSrv = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => {
      if (rq.method === 'POST' && rq.url === '/emails') { enviados.push({ idem: rq.headers['idempotency-key'], auth: rq.headers.authorization, p: JSON.parse(b) }); rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ id: 're_' + randomUUID() })); }
      const m = rq.url.match(/^\/emails\/receiving\/([\w-]+)$/);
      if (rq.method === 'GET' && m) { lecturas.push(m[1]); const c = cuerpos.get(m[1]); if (!c) { rs.writeHead(404); return rs.end('{}'); } rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(c)); }
      rs.writeHead(404); rs.end();
    });
  });
  await new Promise((ok) => mockSrv.listen(0, '127.0.0.1', ok));
  const comun = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: SERVICE, RESEND_API_KEY: 're_clave_de_prueba', ROUTER_BASE: `http://127.0.0.1:${router.port}`, RESEND_BASE: `http://127.0.0.1:${mockSrv.address().port}`, GESTION_PAGOS_REPLY_DOMAIN: H.DOMINIO };
  emisor = await G.levantarFuncion(join(import.meta.dirname, '../enviar-gestion-pago/index.ts'), 3411, { ...comun, GESTION_PAGOS_SECRET: SECRETO, GESTION_PAGOS_FROM: 'Recetario Straumann <no-responder@recetariostra.cl>' });
  receptor = await G.levantarFuncion(join(import.meta.dirname, '../recibir-respuesta-pago/index.ts'), 3412, { ...comun, RESEND_WEBHOOK_SECRET: H.WEBHOOK_SECRET });
  entrante = H.fabricaEntrantes(cuerpos);
});
test.after(() => { emisor?.stop(); receptor?.stop(); pgrst?.stop(); router?.close(); mockSrv?.close(); });
test.beforeEach(() => { enviados.length = 0; falla = () => false; });

const emitir = (secreto = SECRETO) => post(emisor.url, secreto === null ? {} : { 'x-gestion-secret': secreto });
const webhook = (m) => post(receptor.url, { 'content-type': 'application/json', 'svix-id': m.svixId, 'svix-timestamp': m.svixTimestamp, 'svix-signature': m.svixSignature }, m.rawBody);
const resp = (g, o) => webhook(entrante({ token: g.reply_token, ...o }));

test('D1 emisor (Deno real): sin secreto/secreto malo => 401; metodo GET => 405', async () => {
  assert.equal((await emitir(null)).status, 401); assert.equal((await emitir('x'.repeat(30))).status, 401);
  assert.equal((await fetch(emisor.url)).status, 405); assert.equal(enviados.length, 0);
});

test('D2 envio_activo=false (defecto): el emisor corre pero NO envia ni reclama nada', async () => {
  const c = await mkCot(); await pagar(c, 100000);
  const r = await emitir(); assert.equal(r.status, 200); assert.equal(enviados.length, 0);
  assert.equal((await gestion(c)).estado_envio, 'pendiente');
});

test('D3 envio en modo prueba: 1 correo al destinatario de prueba, [PRUEBA], Reply-To con token, enlaces https firmados, columnas reales OK', async () => {
  await sh(`UPDATE pago_gestion_config SET valor='true' WHERE clave='envio_activo'`);
  const c = await mkCot({ inst: 'UDP', total: 100000 }); await pagar(c, 100000);
  const r = await emitir(); assert.equal(r.status, 200, await r.clone().text());
  const g = await gestion(c); const suyos = () => enviados.filter((e) => e.p.reply_to === `reply+${g.reply_token}@${H.DOMINIO}`);
  assert.equal(suyos().length, 1); const { p, idem, auth } = suyos()[0];
  assert.deepEqual(p.to, ['daniel.jordan@straumann.com']); assert.match(p.subject, /^\[PRUEBA\] /); assert.match(p.subject, /16072120-0 - Instituci/);
  assert.equal(p.reply_to, `reply+${g.reply_token}@${H.DOMINIO}`); assert.match(idem, /^gestion-pago:/); assert.match(auth, /^Bearer re_/);
  assert.match(p.html, /https:\/\/supabase\.test\/storage\/v1\/object\/sign\/comprobantes\/pagos\/\d+-a\.pdf\?token=FIRMA_/);
  assert.equal(g.estado_envio, 'aceptado');
  // 2da invocacion: idempotente, no reenvia
  await emitir(); assert.equal(suyos().length, 1);
});

test('D4 enlace firmado imposible => correo BLOQUEADO (no se envia gestion incompleta), queda registrado', async () => {
  const c = await mkCot(); await pagar(c, 100000); falla = () => true;
  const r = await emitir(); assert.equal(r.status, 200); assert.equal(enviados.length, 0);
  const g = await gestion(c); assert.notEqual(g.estado_envio, 'aceptado'); assert.ok(g.ultimo_error || g.estado_envio === 'error', JSON.stringify(g).slice(0, 200));
});

test('D5 confirmaciones_activo=false (defecto): una respuesta valida NO registra nada ("desactivado")', async () => {
  const c = await mkCot(); await pagar(c, 100000); await emitir(); const g = await gestion(c); assert.equal(g.estado_envio, 'aceptado');
  const r = await resp(g, { from: CS, text: 'Pedido SAP 1234567890', messageId: '<d5@x>' }); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.resultado, 'desactivado'); assert.equal((await gestion(c)).sap_numero, null); assert.equal(await estadoCot(c), 'Pago informado');
});

test('D6 flujo completo por HTTP: Pago informado -> correo -> CS(SAP) -> Finanzas => Pedido ingresado (y solo al final)', async () => {
  await cfgSet('confirmaciones_activo', 'true');
  const c = await mkCot({ inst: 'HOSMIL' }); await pagar(c, 100000); await emitir(); const g = await gestion(c);
  assert.equal(await estadoCot(c), 'Pago informado');
  let r = await (await resp(g, { from: CS, text: 'Buen día, pedido SAP 4500123456.\n\nEl lun escribió:\n> SAP 0000000000' })).json(); assert.equal(r.resultado, 'registrado');
  assert.equal(await estadoCot(c), 'Pago informado', 'solo SAP: no avanza');
  r = await (await resp(g, { from: FIN, text: 'Pago validado.' })).json(); assert.equal(r.resultado, 'pedido_ingresado');
  assert.equal(await estadoCot(c), 'Pedido ingresado al sistema'); assert.equal((await gestion(c)).sap_numero, '4500123456');
  assert.ok(lecturas.length >= 2, 'el receptor leyo los cuerpos por la API (mock)');
});

test('D7 orden inverso (Finanzas primero) y duplicado del mismo webhook: idempotente', async () => {
  const c = await mkCot({ inst: 'UNAB' }); await pagar(c, 100000); await emitir(); const g = await gestion(c);
  const m = entrante({ token: g.reply_token, from: FIN, text: 'Pago validado.' });
  assert.equal((await (await webhook(m)).json()).resultado, 'pago_validado'); const eventosAntes = await eventos(c);
  const dup = (await (await webhook(m)).json()).resultado; assert.ok(/duplic/.test(dup), dup); assert.equal(await eventos(c), eventosAntes, 'duplicado no crea eventos');
  assert.equal(await estadoCot(c), 'Pago validado');
  assert.equal((await (await resp(g, { from: CS, text: 'SAP: 4500999999' })).json()).resultado, 'pedido_ingresado'); assert.equal(await estadoCot(c), 'Pedido ingresado al sistema');
});

test('D8 firma invalida => 401; remitente no autorizado / sin autenticacion / ambigua => NO cambian estado', async () => {
  const c = await mkCot(); await pagar(c, 100000); await emitir(); const g = await gestion(c);
  assert.equal((await webhook(entrante({ token: g.reply_token, from: CS, text: 'SAP 1111111111', firmaMala: true }))).status, 401);
  await resp(g, { from: 'intruso@gmail.com', text: 'Pago validado y SAP 1111111111' });
  await resp(g, { from: CS, text: 'SAP 1111111111', headers: {} });
  await resp(g, { from: FIN, text: 'No sé si el pago está validado aún' });
  const x = await gestion(c); assert.equal(x.sap_numero, null); assert.equal(x.fin_confirmado_en, null); assert.equal(await estadoCot(c), 'Pago informado');
  assert.ok(await eventos(c, 'respuesta_ambigua') >= 1);
});

test('D9 logs de ambas funciones: sin tokens, secretos, enlaces firmados ni correos de pacientes', async () => {
  const todo = [...emisor.logs, ...receptor.logs].join('\n');
  assert.ok(todo.length > 0);
  for (const prohibido of [/reply\+[0-9a-f]{32}/, /FIRMA_/, /whsec_/, /re_clave_de_prueba/, /pac\d+@correo\.cl/, /16072120/, /sign\/comprobantes/, new RegExp(SECRETO)]) assert.doesNotMatch(todo, prohibido, String(prohibido));
});
