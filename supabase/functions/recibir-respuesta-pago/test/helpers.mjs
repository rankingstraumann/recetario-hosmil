// Ayudantes de prueba LOCALES: Postgres de prueba (/var/tmp/pgproof), mock de Resend y fabrica de correos entrantes firmados (Svix).
// Nada toca produccion ni servicios reales.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DIR = process.env.PAGOS_FASE_B_DIR;
export const FUNC = join(HERE, '..', '..');                     // supabase/functions

export function psql(sql) {
  return new Promise((res) => {
    const p = spawn('su', ['postgres', '-c', '/var/tmp/pgproof/q.sh t']); let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', () => res({ out: out.trim(), err: err.trim() }));
    p.stdin.end(sql);
  });
}
export const sh = async (sql) => { const r = await psql(sql); if (/ERROR/.test(r.err)) throw new Error('SQL: ' + r.err.slice(0, 300)); return r.out; };
export const one = async (sql) => (await sh(sql)).split('\n').pop();
export const lit = (v) => v === null || v === undefined ? 'NULL' : Array.isArray(v) ? (v.length ? `ARRAY[${v.map(lit).join(',')}]::text[]` : `'{}'::text[]`) : (typeof v === 'boolean' || typeof v === 'number') ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const SET_RETURNING = new Set(['pago_gestion_reclamar', 'pago_gestion_destinatarios_de', 'pago_gestion_revisar_elegibilidad', 'pago_gestion_resolver_respuesta']);
export async function rpc(name, args = {}) {
  const a = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const q = SET_RETURNING.has(name) ? `SET ROLE service_role; SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM public.${name}(${a}) x;` : `SET ROLE service_role; SELECT to_jsonb(public.${name}(${a}));`;
  const r = await psql(q);
  if (/ERROR/.test(r.err)) return { data: null, error: { code: 'PG', message: r.err } };
  return { data: JSON.parse(r.out.split('\n').pop() || 'null'), error: null };
}
export async function selectJson(q) { const r = await psql(`SET ROLE service_role; ${q}`); if (/ERROR/.test(r.err)) return { data: null, error: { code: 'PG' } }; return { data: JSON.parse(r.out.split('\n').pop() || 'null'), error: null }; }

export async function reset() {
  execFileSync('bash', [join(DIR, 'reset_local.sh')], { stdio: 'pipe' });
  await sh(readFileSync(join(FUNC, 'enviar-gestion-pago/test/fixture_columnas_reales.sql'), 'utf8'));
  await sh(readFileSync(join(DIR, 'B4_recepcion.sql'), 'utf8'));
}

let seq = 100;
export async function mkCot({ inst = 'UDP', nombreInst, total = 100000, paciente = 'Scarlett Salas López', rut = '16072120-0', estado = 'Enviada al paciente' } = {}) {
  const n = ++seq; const id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const nombres = { UDP: 'UDP Santiago', UNAB: 'UNAB Santiago', UMAYOR: 'Universidad Mayor Santiago', UMAYORT: 'Universidad Mayor Temuco', HOSMIL: 'HOSMIL', ARMADA: 'Central Odontológica de la Armada', PDI: 'Policía de Investigaciones', UC: 'Pontificia UC' };
  await sh(`INSERT INTO cotizaciones(id,numero,institucion,institucion_codigo,estado,total,token,paciente,rut,paciente_email,paciente_direccion,paciente_whatsapp,doctor,items)
    VALUES ('${id}','C-${n}',${lit(nombreInst ?? nombres[inst])},'${inst}',${lit(estado)},${total},'tok${n}',${lit(paciente)},${lit(rut)},'pac${n}@correo.cl','Calle ${n}','9${String(n).padStart(8, '0')}','Dr. Pérez',
    '[{"codigo":"104.060","descripcion":"Implante Helix","cantidad":2,"descuento":0.15,"subtotal":${total}}]'::jsonb);`);
  return { id, n, token: `tok${n}` };
}
export const pagar = async (c, monto, tag = 'a') => one(`SET ROLE anon; SELECT registrar_pago_publico('${c.token}','pagos/${c.n}-${tag}.pdf',${monto},'h${c.n}${tag}');`);
export const gestion = async (c) => JSON.parse(await one(`SELECT coalesce((SELECT to_jsonb(g) FROM pago_gestiones g WHERE cotizacion_id='${c.id}'),'null'::jsonb);`));
export const estadoCot = (c) => one(`SELECT estado FROM cotizaciones WHERE id='${c.id}'`);
export const eventos = async (c, tipo) => Number(await one(`SELECT count(*) FROM pago_gestion_eventos WHERE cotizacion_id='${c.id}'${tipo ? ` AND tipo='${tipo}'` : ''}`));
export const cfgSet = (k, v) => sh(`UPDATE pago_gestion_config SET valor=${lit(v)} WHERE clave=${lit(k)};`);

// ---- mock de Resend (127.0.0.1) ----
export function mockResend() {
  const reqs = [], store = new Map(); let comportamiento = () => ({ status: 200, body: { id: 're_' + randomUUID().replace(/-/g, '').slice(0, 14) } });
  const server = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', async () => {
      const idem = rq.headers['idempotency-key']; const hash = createHash('sha256').update(b).digest('hex');
      reqs.push({ idem, body: JSON.parse(b) });
      const send = (r) => { rs.writeHead(r.status, { 'content-type': 'application/json' }); rs.end(r.raw ?? JSON.stringify(r.body)); };
      if (idem && store.has(idem)) { const s = store.get(idem); return send(s.hash === hash ? s.resp : { status: 409, body: { name: 'invalid_idempotent_request' } }); }
      const r = await comportamiento(reqs[reqs.length - 1], reqs.length);
      if (r.delay) await new Promise((z) => setTimeout(z, r.delay));
      if (idem && r.status < 500) store.set(idem, { hash, resp: r });
      try { send(r); } catch { /* cliente se fue */ }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({
    reqs, port: server.address().port, set: (f) => (comportamiento = f), close: () => { server.closeAllConnections?.(); server.close(); },
  })));
}

// ---- dependencias del EMISOR (Fase C) ----
export const SECRET_EMISOR = 'S3cr3t-gestion-' + 'x'.repeat(24);
export function depsEmisor(mock, over = {}, logs = []) {
  let n = 0;
  return {
    cfg: { secret: SECRET_EMISOR, from: 'Recetario Straumann <no-responder@recetariostra.cl>', replyDomain: 'pagos.recetariostra.cl', maxLote: 5, resendTimeoutMs: 2000 },
    rpc,
    getCotizacion: (id) => selectJson(`SELECT to_jsonb(c) FROM public.cotizaciones c WHERE c.id='${id}'`),
    getPagos: (id) => selectJson(`SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at),'[]'::jsonb) FROM public.cotizacion_pagos p WHERE p.cotizacion_id='${id}'`),
    sign: async (path) => `https://mock.storage.local/sign/${path}?token=SIGSECRET_${++n}`,
    resend: async (payload, idem, signal) => {
      const r = await fetch(`http://127.0.0.1:${mock.port}/emails`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'idempotency-key': idem }, body: JSON.stringify(payload) });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    log: (o) => logs.push(JSON.stringify(o)),
    ...over,
  };
}

// ---- correos ENTRANTES simulados (formato del webhook de Resend: solo metadatos; cuerpo/cabeceras por API) ----
export const WEBHOOK_SECRET = 'whsec_' + Buffer.from('secreto-webhook-de-prueba-0123456789').toString('base64');
export const DOMINIO = 'pagos.recetariostra.cl';
export const AUTH_OK = { 'Authentication-Results': 'mx.resend.com; dmarc=pass (p=NONE) header.from=straumann.com; spf=pass; dkim=pass header.d=straumann.com' };
export const CS = 'm.cl.customerservicechile@straumann.com', FIN = 'cobranza.cl@straumann.com';

/** Crea un correo entrante firmado. `cuerpos` es el "almacen" que simula la API de lectura de Resend. */
export function fabricaEntrantes(cuerpos) {
  let k = 0;
  return function entrante({ from, token, to, cc = [], text = '', html = null, headers = AUTH_OK, messageId, svixId, sinCuerpo = false, firmaMala = false, tipo = 'email.received' }) {
    k++;
    const emailId = 'em_' + String(k).padStart(8, '0') + randomUUID().slice(0, 4).replace(/-/g, '');
    const mid = messageId ?? `<msg-${k}-${randomUUID()}@straumann.com>`;
    const body = JSON.stringify({ type: tipo, created_at: new Date().toISOString(), data: { email_id: emailId, from, to: to ?? [`reply+${token}@${DOMINIO}`], cc, bcc: [], received_for: [], message_id: mid, subject: 'Re: algo' } });
    if (!sinCuerpo) cuerpos.set(emailId, { text, html, headers });
    const id = svixId ?? `msg_${randomUUID().replace(/-/g, '')}`, ts = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(WEBHOOK_SECRET.replace('whsec_', ''), 'base64');
    const sig = 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
    return { rawBody: body, svixId: id, svixTimestamp: ts, svixSignature: firmaMala ? 'v1,' + 'A'.repeat(sig.length - 3) : sig, _emailId: emailId, _messageId: mid };
  };
}
export function depsReceptor(cuerpos, over = {}, logs = []) {
  return {
    cfg: { webhookSecret: WEBHOOK_SECRET, replyDomain: DOMINIO },
    rpc,
    obtenerCuerpo: async (id) => cuerpos.get(id) ?? null,
    getContexto: async (id) => (await selectJson(`SELECT jsonb_build_object('rut',rut,'paciente_whatsapp',paciente_whatsapp) FROM cotizaciones WHERE id='${id}'`)).data,
    log: (o) => logs.push(JSON.stringify(o)),
    ...over,
  };
}
