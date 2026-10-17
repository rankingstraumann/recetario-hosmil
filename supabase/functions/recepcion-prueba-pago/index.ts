// recepcion-prueba-pago -- PRUEBA AISLADA (NO DESPLEGADA). Despliegue futuro con verify_jwt=false, solo con autorizacion de Daniel y solo para la prueba;
// se elimina al terminar (junto con su webhook). Sin base de datos. Secretos PROPIOS de la prueba (prefijo PRUEBA_): NUNCA se usa RESEND_API_KEY, que es la
// clave de envio de produccion y que un `secrets set` del mismo nombre sobrescribiria (afectaria cotizaciones y recordatorios).
import { handlePrueba } from './logic.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'metodo_no_permitido' });
  const secret = Deno.env.get('PRUEBA_RESEND_WEBHOOK_SECRET') ?? '';
  const apiKey = Deno.env.get('PRUEBA_RESEND_API_KEY') ?? '';
  const dominio = (Deno.env.get('PRUEBA_DOMINIO') ?? 'pedidos.recetariostra.cl').trim().toLowerCase();
  if (secret.length < 16) return json(500, { ok: false, error: 'config' });
  if (Number(req.headers.get('content-length') ?? '0') > 262144) return json(413, { ok: false, error: 'cuerpo_grande' });
  const rawBody = await req.text();
  try {
    const r = await handlePrueba({
      rawBody, svixId: req.headers.get('svix-id'), svixTimestamp: req.headers.get('svix-timestamp'), svixSignature: req.headers.get('svix-signature'),
    }, {
      dominio, webhookSecret: secret,
      leer: apiKey ? async (id) => {
        const resp = await fetch(`https://api.resend.com/emails/receiving/${id}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
        return { status: resp.status, json: resp.ok ? await resp.json().catch(() => null) : null };
      } : null,
      log: (o) => console.log(JSON.stringify(o)),
    });
    return json(r.status, r.body);
  } catch { return json(500, { ok: false, error: 'error_interno' }); }
});
