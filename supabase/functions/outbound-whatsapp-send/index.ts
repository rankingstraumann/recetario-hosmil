// outbound-whatsapp-send -- OUTBOUND 7: envio INICIAL por plantilla WhatsApp, SOLO MODO PRUEBA, un prospecto por accion.
// Seguridad: JWT del usuario + is_lead_admin(); sin service_role; kill switch OUTBOUND_WHATSAPP_ENABLED (apagado por defecto);
// OUTBOUND_WHATSAPP_TEST_ONLY (true por defecto); la base rechaza prospectos reales (segunda barrera). Logs sin datos personales.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handle, readConfig } from './logic.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'metodo_no_permitido', message: 'Usa POST.' });
  const auth = req.headers.get('Authorization') ?? '';
  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!auth.startsWith('Bearer ') || !url || !anon) return json(401, { ok: false, error: 'no_autenticado', message: 'Sesión requerida.' });
  const sb = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const adm = await sb.rpc('is_lead_admin');
  if (adm.error || adm.data !== true) return json(403, { ok: false, error: 'no_autorizado', message: 'No tienes permiso para enviar.' });
  if (Number(req.headers.get('content-length') ?? '0') > 2048) return json(413, { ok: false, error: 'cuerpo_grande', message: 'Solicitud demasiado grande.' });
  let body: unknown;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: 'json_invalido', message: 'Cuerpo inválido.' }); }
  try {
    const r = await handle(body, {
      cfg: readConfig((k) => Deno.env.get(k)),
      rpc: (n, a) => sb.rpc(n, a) as unknown as Promise<{ data: any; error: any }>,
      doFetch: fetch,
      log: (o) => console.log(JSON.stringify(o)),
    });
    return json(r.status, r.body);
  } catch (e) {
    console.log(JSON.stringify({ ev: 'error', name: (e as Error).name }));
    return json(500, { ok: false, error: 'error_interno', message: 'Error interno.' });
  }
});
