import { createHmac } from 'node:crypto';
let handler;
globalThis.Deno = { env: { get: (k) => process.env[k] }, serve: (h) => { handler = h; } };
process.env.WHATSAPP_APP_SECRET = 'sec'; process.env.WHATSAPP_VERIFY_TOKEN = 'vt'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'PN';
process.env.LEADS_BOT_ENABLED = 'true'; process.env.WHATSAPP_LEADS_IS_TEST = 'true'; process.env.ANTHROPIC_API_KEY = 'k';
// LLM simulado (reglas) vía fetch a api.anthropic.com
let llmDown = false;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('anthropic')) throw new Error('unexpected fetch');
  if (llmDown) return new Response('x', { status: 529 });
  const t = JSON.parse(JSON.parse(init.body).messages[0].content).mensaje.toLowerCase();
  const i = {};
  if (/medit i700/.test(t)) { i.current_scanner = 'Medit i700'; i.uses_intraoral_scanner = true; }
  if (/cambiar|renovar/.test(t)) i.need = 'renew';
  if (/par de meses/.test(t)) i.purchase_timeline = '1_3_months';
  if (/cotizar/.test(t)) i.wants_quote = true; if (/demo/.test(t)) i.wants_demo = true;
  if (/sirios/.test(t)) i.need = 'know_sirios';
  if (/quiero cotizar/.test(t)) { i.high_intent = true; i.high_intent_reason = 'quiere cotizar'; }
  const m = t.match(/soy (.+?), de (.+?), (.+)$/); if (m) { i.contact_name = m[1]; i.clinic_name = m[2]; i.commune = m[3]; }
  if (/^dra? ?(\w+)$/.test(t)) i.contact_name = t;
  return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'registrar_datos', input: i }] }), { status: 200 });
};
await import('./index.ts');
const db = await import('./db.ts'); const T = db.T;
let n = 0;
export async function send(phone, payload, { text, id, type = 'text', interactive, headers = {}, pn = 'PN', raw, sigOverride } = {}) {
  const msg = { from: phone.replace('+', ''), id: id || 'wamid.' + (++n), type };
  if (type === 'text') msg.text = { body: text }; if (interactive) msg.interactive = interactive;
  const body = raw ?? JSON.stringify(payload ?? { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: pn }, messages: [msg] } }] }] });
  const sig = sigOverride ?? 'sha256=' + createHmac('sha256', 'sec').update(body).digest('hex');
  const r = await handler(new Request('http://x/', { method: 'POST', body, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json', ...headers } }));
  return { status: r.status, body: await r.json().catch(() => null) };
}
export const reply = (id) => ({ type: 'interactive', interactive: { list_reply: { id, title: id } } });
export const btn = (id) => ({ type: 'interactive', interactive: { button_reply: { id, title: id } } });
export const setLlm = (v) => (llmDown = v);
export { handler, T };
export const lastOut = (phone) => { const out = T.messages.filter(m => m.direction === 'outbound' && T.sessions.some(s => s.id === m.session_id && s.phone_e164 === phone) || (m.direction==='outbound' && T.leads.some(l=>l.id===m.lead_id && l.phone_e164===phone))); return out.slice(-3).map(m => m.message_text); };
