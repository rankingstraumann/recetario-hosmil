// DEMOSTRACION local (BD desechable, Resend y Storage simulados): "Pago informado" -> "Pedido ingresado al sistema", en ambos ordenes.
// El modo 'real' solo existe en la BD local descartable; el "Resend" es un mock: no sale ningun correo.
process.env.TZ = 'America/Santiago';
import http from 'node:http'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto';
import * as G from './harness.mjs'; import * as H from '../recibir-respuesta-pago/test/helpers.mjs';
const { sh, one, mkCot, pagar, gestion, estadoCot, cfgSet, CS, FIN } = H;
await H.reset(); const pg = await G.levantarPostgREST(3410, { psql: H.psql }); const rt = await G.levantarRouter(3410);
const cuerpos = new Map(), enviados = [];
const ms = http.createServer((rq, rs) => { let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => { const m = rq.url.match(/^\/emails\/receiving\/([\w-]+)$/);
  if (rq.method === 'POST') { enviados.push(JSON.parse(b)); rs.writeHead(200); return rs.end(JSON.stringify({ id: 're_' + randomUUID() })); }
  rs.writeHead(200); rs.end(JSON.stringify(cuerpos.get(m?.[1]) ?? {})); }); }); await new Promise((o) => ms.listen(0, '127.0.0.1', o));
const comun = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: G.jwt('service_role'), RESEND_API_KEY: 're_demo', ROUTER_BASE: `http://127.0.0.1:${rt.port}`, RESEND_BASE: `http://127.0.0.1:${ms.address().port}`, GESTION_PAGOS_REPLY_DOMAIN: H.DOMINIO };
const em = await G.levantarFuncion(join(import.meta.dirname, '../enviar-gestion-pago/index.ts'), 3411, { ...comun, GESTION_PAGOS_SECRET: H.SECRET_EMISOR, GESTION_PAGOS_FROM: 'Recetario Straumann <no-responder@recetariostra.cl>' });
const rc = await G.levantarFuncion(join(import.meta.dirname, '../recibir-respuesta-pago/index.ts'), 3412, { ...comun, RESEND_WEBHOOK_SECRET: H.WEBHOOK_SECRET });
await sh(`UPDATE pago_gestion_config SET valor='true' WHERE clave IN ('envio_activo','confirmaciones_activo'); UPDATE pago_gestion_config SET valor='real' WHERE clave='modo';`);
const entrante = H.fabricaEntrantes(cuerpos);
const emitir = () => fetch(em.url, { method: 'POST', headers: { 'x-gestion-secret': H.SECRET_EMISOR } });
const hook = async (g, o) => { const m = entrante({ token: g.reply_token, ...o }); const r = await fetch(rc.url, { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': m.svixId, 'svix-timestamp': m.svixTimestamp, 'svix-signature': m.svixSignature }, body: m.rawBody }); return (await r.json()).resultado; };
const linea = async (c, paso, extra = '') => { const g = await gestion(c); console.log(`  ${paso.padEnd(46)} cotización="${await estadoCot(c)}" | envío=${g?.estado_envio ?? '-'} | SAP=${g?.sap_numero ?? '-'} | Finanzas=${g?.fin_confirmado_en ? 'sí' : 'no'} ${extra}`); };
async function caso(titulo, inst, orden) {
  console.log(`\n=== ${titulo} ===`); const c = await mkCot({ inst }); await linea(c, 'cotización "Enviada al paciente"');
  await pagar(c, 100000); await linea(c, 'paciente informa pago (RPC público existente)');
  enviados.length = 0; await emitir(); const e = enviados[0]; await linea(c, 'emisor (Deno) envía correo interno', `\n    Asunto: ${e.subject}\n    Para: ${e.to.join(', ')}\n    CC: ${(e.cc || []).join(', ')}\n    Reply-To: reply+<token oculto>@${H.DOMINIO}`);
  const g = await gestion(c);
  const pasos = { cs: ['Customer Service responde con N° SAP', { from: CS, text: 'Hola, ingresé el pedido. N° SAP 4500123456.\n\nEl lun escribió:\n> Pedido SAP 0000000000' }], fin: ['Finanzas responde "Pago validado"', { from: FIN, text: 'Pago validado.' }] };
  for (const k of orden) { const [t, o] = pasos[k]; const r = await hook(g, o); await linea(c, `${t} -> ${r}`); }
  return c;
}
await caso('Caso 1: UDP — Customer Service primero, luego Finanzas', 'UDP', ['cs', 'fin']);
await caso('Caso 2: HOSMIL — Finanzas primero, luego Customer Service', 'HOSMIL', ['fin', 'cs']);
const c3 = await mkCot({ inst: 'UNAB' }); await pagar(c3, 100000); await emitir(); const g3 = await gestion(c3);
console.log('\n=== Caso 3: respuestas NO válidas no cambian nada ===');
console.log('  remitente no autorizado ->', await hook(g3, { from: 'intruso@gmail.com', text: 'Pago validado, SAP 1111111111' }));
console.log('  CS sin autenticación    ->', await hook(g3, { from: CS, text: 'SAP 1111111111', headers: {} }));
console.log('  Finanzas ambigua        ->', await hook(g3, { from: FIN, text: 'No estoy segura si el pago está validado' }));
await linea(c3, 'estado final (sin cambios)');
em.stop(); rc.stop(); pg.stop(); rt.close(); ms.close();
