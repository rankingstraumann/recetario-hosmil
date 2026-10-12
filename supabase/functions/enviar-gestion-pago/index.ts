// enviar-gestion-pago -- Fase C (NO DESPLEGADA). Envia la gestion interna (contenido de "Copiar gestion completa") a Customer Service/Cobranza
// cuando una cotizacion queda en "Pago informado" y su pago acumulado cubre el total. Lo invoca un cron/operador con el header
// x-gestion-secret (verify_jwt=false al desplegar; la autenticacion es el secreto). La BD manda: sin envio_activo='true' no se reclama nada,
// y con modo<>'real' el unico destinatario posible es el de prueba. No toca RPC publicas, comprobantes, cotizaciones ni recordatorios.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { handle, readConfig } from './logic.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'metodo_no_permitido' });
  const { cfg, error } = readConfig((k) => Deno.env.get(k));
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), resendKey = Deno.env.get('RESEND_API_KEY');
  if (!cfg || !url || !key || !resendKey) { console.log(JSON.stringify({ ev: 'config_invalida', code: error ?? 'env' })); return json(500, { ok: false, error: 'config' }); }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  try {
    const r = await handle(req.headers.get('x-gestion-secret'), {
      cfg,
      rpc: async (n, a) => { try { return await sb.rpc(n, a) as any; } catch (e) { return { data: null, error: { code: 'EXC', message: (e as Error).name } }; } },
      getCotizacion: async (id) => {
        const q = await sb.from('cotizaciones')
          .select('numero,institucion,institucion_codigo,paciente,rut,paciente_email,paciente_direccion,paciente_whatsapp,doctor,items,total,comprobante_path,profesional_sucursal,profesional_direccion_despacho')
          .eq('id', id).maybeSingle();
        return q as any;
      },
      getPagos: async (id) => (await sb.from('cotizacion_pagos').select('comprobante_path,monto,created_at').eq('cotizacion_id', id).order('created_at', { ascending: true })) as any,
      sign: async (path) => {
        const { data, error: e } = await sb.storage.from('comprobantes').createSignedUrl(path, 604800);   // 7 dias, igual que el Admin
        return e || !data?.signedUrl ? null : data.signedUrl;
      },
      resend: async (payload, idem, signal) => {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}`, 'Idempotency-Key': idem },
          body: JSON.stringify(payload),
        });
        const j = await resp.json().catch(() => null);
        return { status: resp.status, json: j };
      },
      log: (o) => console.log(JSON.stringify(o)),
    });
    return json(r.status, r.body);
  } catch (e) {
    console.log(JSON.stringify({ ev: 'error', code: (e as Error).name }));
    return json(500, { ok: false, error: 'error_interno' });
  }
});
