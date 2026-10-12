// whatsapp.ts — Envío por WhatsApp Cloud API (solo server-side). Sin token configurado = modo simulación (no envía nada).
import type { Out } from './engine.ts';

export interface SendResult { ok: boolean; id?: string; error?: string; dry?: boolean; payload?: unknown }

export interface WaCfg { token?: string; phoneNumberId: string; version: string }

function buildPayload(to: string, o: Out): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') };
  if (o.kind === 'text') return { ...base, type: 'text', text: { body: o.body.slice(0, 4000), preview_url: false } };
  if (o.kind === 'buttons') {
    return { ...base, type: 'interactive', interactive: { type: 'button', body: { text: o.body },
      action: { buttons: (o.buttons || []).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } } };
  }
  return { ...base, type: 'interactive', interactive: { type: 'list', body: { text: o.body },
    action: { button: 'Ver opciones', sections: [{ title: 'Opciones', rows: (o.rows || []).map((r) => ({ id: r.id, title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }] } } };
}

export async function sendMessage(cfg: WaCfg, to: string, o: Out, forceFail = false): Promise<SendResult> {
  const payload = buildPayload(to, o);
  if (!cfg.token) {
    // Modo simulación: no hay token => nada sale a Meta.
    if (forceFail) return { ok: false, dry: true, error: 'simulated_send_failure', payload };
    return { ok: true, dry: true, payload };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://graph.facebook.com/${cfg.version}/${cfg.phoneNumberId}/messages`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = j?.error?.code, msg = String(j?.error?.message || '').slice(0, 200);
      return { ok: false, error: `http_${r.status}${code ? `_code_${code}` : ''}: ${msg}` };
    }
    return { ok: true, id: j?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: `fetch_${(e as Error).name}` };
  } finally {
    clearTimeout(timer);
  }
}
