// Entorno aislado: PostgREST 12.2.3 real contra la Postgres LOCAL + router (Storage firmado falso) + mock de Resend + Edge Functions reales bajo Deno.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const T = process.env.PAGOS_TOOLS_DIR;   // <scratchpad>/tools
export const JWT_SECRET = randomBytes(32).toString('hex');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const jwt = (role) => { const h = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role, iss: 'local', exp: Math.floor(Date.now() / 1000) + 3600 }); return h + '.' + createHmac('sha256', JWT_SECRET).update(h).digest('base64url'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); for (;;) { try { if (await fn()) return; } catch {} if (Date.now() - t > ms) throw new Error('timeout esperando servicio'); await wait(150); } }

export async function levantarPostgREST(puerto, { psql }) {
  await psql(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF; END $$; GRANT anon, authenticated, service_role TO authenticator;`);
  const cfg = join(process.env.TMPDIR || '/tmp', `pgrst_${puerto}.conf`);
  writeFileSync(cfg, `db-uri = "postgres://authenticator@/t?host=/var/tmp/pgproof&port=54329"\ndb-schemas = "public"\ndb-anon-role = "anon"\njwt-secret = "${JWT_SECRET}"\nserver-host = "127.0.0.1"\nserver-port = ${puerto}\nlog-level = "error"\n`);
  const p = spawn(join(T, 'postgrest/postgrest'), [cfg], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => (err += d));
  await until(async () => (await fetch(`http://127.0.0.1:${puerto}/`, { headers: { authorization: 'Bearer ' + jwt('service_role') } })).status < 500).catch((e) => { throw new Error(e.message + ' ' + err.slice(0, 300)); });
  return { stop: () => p.kill() };
}

/** Router: /rest/v1/* -> PostgREST ; /storage/v1/object/sign/* -> URL firmada falsa (o error si fallaStorage(path)). */
export function levantarRouter(puertoPgrst, { fallaStorage = () => false } = {}) {
  const hits = [];
  const srv = http.createServer((rq, rs) => {
    let b = []; rq.on('data', (d) => b.push(d)); rq.on('end', () => {
      const body = Buffer.concat(b); hits.push(rq.method + ' ' + rq.url.split('?')[0]);
      if (rq.url.startsWith('/rest/v1/')) {
        const pr = http.request({ host: '127.0.0.1', port: puertoPgrst, path: rq.url.slice('/rest/v1'.length), method: rq.method, headers: { ...rq.headers, host: `127.0.0.1:${puertoPgrst}` } }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
        pr.on('error', () => { rs.writeHead(502); rs.end(); }); return pr.end(body);
      }
      const m = rq.url.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/);
      if (m && rq.method === 'POST') {
        if (fallaStorage(decodeURIComponent(m[2]))) { rs.writeHead(404, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' })); }
        rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ signedURL: `/object/sign/${m[1]}/${m[2]}?token=FIRMA_${randomBytes(6).toString('hex')}` }));
      }
      rs.writeHead(404); rs.end();
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ port: srv.address().port, hits, close: () => { srv.closeAllConnections?.(); srv.close(); } })));
}

export async function levantarFuncion(entry, puerto, env) {
  const p = spawn(join(T, 'node_modules/.bin/deno'), ['run', '--allow-net', '--allow-env', '--allow-read', join(import.meta.dirname, 'wrapper.ts'), entry, String(puerto)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DENO_DIR: process.env.DENO_DIR || '/var/tmp/deno_cache', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTPS_PROXY: process.env.HTTPS_PROXY || '', SSL_CERT_FILE: process.env.SSL_CERT_FILE || '', DENO_CERT: process.env.DENO_CERT || '/root/.ccr/ca-bundle.crt', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = []; let listo = false;
  p.stdout.on('data', (d) => { for (const l of String(d).split('\n')) { if (l === 'LISTO') listo = true; else if (l.trim()) logs.push(l); } });
  p.stderr.on('data', (d) => logs.push('[stderr] ' + String(d).trim()));
  await until(() => listo, 60000).catch((e) => { throw new Error(e.message + '\n' + logs.join('\n').slice(0, 800)); });
  return { url: `http://127.0.0.1:${puerto}/`, logs, stop: () => p.kill() };
}
