// recibir-respuesta-pago -- Fase E (NO DESPLEGADA). Webhook de correo entrante de Resend. verify_jwt=false al desplegar: la autenticacion es la
// firma Svix del webhook (RESEND_WEBHOOK_SECRET). Con confirmaciones_activo<>'true' la BD no registra nada ('desactivado').
// Lectura del correo: GET /emails/receiving/{id} (documentado por Resend; el webhook solo trae metadatos). La autenticacion se toma del objeto
// `authentication` {spf,dkim,dmarc}. PENDIENTE de comprobar con la prueba aislada real: permisos de la API key y valores para remitentes Straumann.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handle } from './logic.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'metodo_no_permitido' });
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), resendKey = Deno.env.get('RESEND_API_KEY');
  const webhookSecret = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? '';
  const replyDomain = (Deno.env.get('GESTION_PAGOS_REPLY_DOMAIN') ?? 'pedidos.recetariostra.cl').trim().toLowerCase();
  if (!url || !key || !resendKey || webhookSecret.length < 16) { console.log(JSON.stringify({ ev: 'config_invalida' })); return json(500, { ok: false, error: 'config' }); }
  if (Number(req.headers.get('content-length') ?? '0') > 262144) return json(413, { ok: false, error: 'cuerpo_grande' });
  const rawBody = await req.text();
  const sb = createClient(url, key, { auth: { persistSession: false } });
  try {
    const r = await handle({
      rawBody, svixId: req.headers.get('svix-id'), svixTimestamp: req.headers.get('svix-timestamp'), svixSignature: req.headers.get('svix-signature'),
    }, {
      cfg: { webhookSecret, replyDomain },
      rpc: async (n, a) => { try { return await sb.rpc(n, a) as any; } catch (e) { return { data: null, error: { code: 'EXC' } }; } },
      obtenerCuerpo: async (emailId) => {
        if (!/^[A-Za-z0-9_-]{6,80}$/.test(emailId)) return null;
        try {
          const resp = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, { headers: { Authorization: `Bearer ${resendKey}` }, signal: AbortSignal.timeout(10000) });   
          if (!resp.ok) return null;
          const j = await resp.json();
          return { text: j.text ?? null, html: j.html ?? null, headers: j.headers ?? null, authentication: j.authentication && typeof j.authentication === 'object' ? j.authentication : null };
        } catch { return null; }
      },
      getContexto: async (id) => {
        const q = await sb.from('cotizaciones').select('rut,paciente_whatsapp').eq('id', id).maybeSingle();
        return q.error ? null : (q.data as any);
      },
      log: (o) => console.log(JSON.stringify(o)),
    });
    return json(r.status, r.body);
  } catch (e) {
    console.log(JSON.stringify({ ev: 'error', code: (e as Error).name }));
    return json(500, { ok: false, error: 'error_interno' });
  }
});
