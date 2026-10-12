#!/usr/bin/env node
// Simulador firmado del webhook de WhatsApp (sin Meta). Uso:
//   WEBHOOK_URL=https://<proyecto>.supabase.co/functions/v1/whatsapp-webhook \
//   APP_SECRET=<mismo WHATSAPP_APP_SECRET de la función> PHONE_NUMBER_ID=<mismo valor> \
//   node scripts/whatsapp-simulate.mjs <+56900001234> "texto" | node scripts/whatsapp-simulate.mjs <+56...> --id q2:trade_up
// Flags: --bad-sig  --dup <wamid>  --pn <otro_phone_number_id>  --type audio  --header "x-sim-fail-llm: 1"
// NUNCA uses el App Secret real en un equipo compartido. Con la función en modo simulación (sin WHATSAPP_ACCESS_TOKEN) no se envía nada a Meta.
import { createHmac } from 'node:crypto';
const [phone, text, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(n); const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const { WEBHOOK_URL, APP_SECRET, PHONE_NUMBER_ID } = process.env;
if (!WEBHOOK_URL || !APP_SECRET || !PHONE_NUMBER_ID || !phone) { console.error('Faltan WEBHOOK_URL, APP_SECRET, PHONE_NUMBER_ID o teléfono'); process.exit(1); }
const type = val('--type') || (val('--id') ? 'interactive' : 'text');
const msg = { from: phone.replace('+', ''), id: val('--dup') || `wamid.SIM${Date.now()}${Math.floor(Math.random() * 1e4)}`, type, timestamp: String(Math.floor(Date.now() / 1000)) };
if (type === 'text') msg.text = { body: text };
if (type === 'interactive') msg.interactive = { list_reply: { id: val('--id'), title: val('--id') } };
const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'SIM', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: val('--pn') || PHONE_NUMBER_ID }, messages: [msg] } }] }] });
const sig = flag('--bad-sig') ? 'sha256=' + '0'.repeat(64) : 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
const headers = { 'content-type': 'application/json', 'x-hub-signature-256': sig };
const h = val('--header'); if (h) { const [k, ...v] = h.split(':'); headers[k.trim()] = v.join(':').trim(); }
const r = await fetch(WEBHOOK_URL, { method: 'POST', headers, body });
console.log(r.status, await r.text());
