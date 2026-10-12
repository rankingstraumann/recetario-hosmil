// whatsapp-webhook — Leads Digital Fase 2. verify_jwt=false (Meta no envía JWT):
// la seguridad es X-Hub-Signature-256 (HMAC con App Secret) + verify token en el GET.
import {
  ACK, GREETING, OFFFLOW, RESUME, UNSUPPORTED, applyTurn, commercialQuestion, finalMessage, fromInteractiveId, keywordExtract,
  leadReady, plainFallback, questionFor, strongIntent, trivialMessage, type Ctx, type Fields, type Out, type Step,
} from './engine.ts';
import { extractWithLlm } from './extract.ts';
import { leadFieldsOut, outboundSummary, outboundTurn } from './outbound-sirios.ts';
import { buildSummary } from './summary.ts';
import { sendMessage, type WaCfg } from './whatsapp.ts';
import { leadColumns, makeDb, type Db, type Lead, type Session } from './db.ts';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_MESSAGES_PER_REQUEST = 20;
const MAX_TEXT = 1000;
const SESSION_EXPIRY_MS = 72 * 3600 * 1000;
const LOST_REOPEN_MS = 30 * 24 * 3600 * 1000;
const ACK_COOLDOWN_MS = 6 * 3600 * 1000;
const INFLIGHT_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;
const PID_RE = /^[A-Za-z0-9._=:+\-]{1,200}$/;

const env = (k: string) => Deno.env.get(k) || '';
const mask = (p: string) => `***${p.slice(-4)}`;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------- Firma ----------
async function hmacHex(secret: string, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- Entrada ----------
type Inbound = { type: string; text: string; interactiveId?: string };
function readInbound(m: any): Inbound {
  const t = String(m?.type || 'unknown');
  if (t === 'text') return { type: t, text: String(m.text?.body || '') };
  if (t === 'interactive') {
    const r = m.interactive?.button_reply || m.interactive?.list_reply;
    return { type: t, text: String(r?.title || ''), interactiveId: r?.id ? String(r.id) : undefined };
  }
  if (t === 'button') return { type: t, text: String(m.button?.text || '') };
  return { type: t, text: '' };
}

// ---------- Decisión de sesión (política del mismo número) ----------
type Decision =
  | { kind: 'flow'; session: Session; resumed: boolean }
  | { kind: 'ack'; lead: Lead; reason: 'active' | 'lost_recent' | 'won'; session: Session };

async function resolve(db: Db, phone: string, nowMs: number): Promise<Decision> {
  const nowIso = new Date(nowMs).toISOString();
  const active = await db.getActiveSession(phone);
  if (active) {
    if (nowMs - Date.parse(active.last_message_at) < SESSION_EXPIRY_MS) return { kind: 'flow', session: active, resumed: false };
    // CASO B: expira y retoma datos en una sesión nueva (mismo lead si existe)
    await db.updateSession(active.id, { status: 'expired' });
    const prev: Ctx = active.context || { fields: {} };
    const ctx: Ctx = prev.journey === 'outbound_sirios'
      ? { ...prev, fields: { ...(prev.fields || {}) }, first_turn: true, resumed: true }   // OUTBOUND 9A: conserva el journey y su estado
      : { fields: { ...(prev.fields || {}) }, greeted: true, first_turn: true, resumed: true, llm_calls: 0, msg_count: 0 };
    const s = await db.createSession(phone, ctx, active.lead_id, nowIso);
    return { kind: 'flow', session: s, resumed: true };
  }
  const last = await db.getLatestSession(phone);
  if (last && last.lead_id && (last.status === 'completed' || last.status === 'handed_off')) {
    const lead = await db.getLead(last.lead_id);
    if (lead) {
      if (lead.status === 'won') return { kind: 'ack', lead, reason: 'won', session: last };                       // CASO E
      if (lead.status === 'lost') {                                                                                  // CASO D
        if (nowMs - Date.parse(lead.updated_at) < LOST_REOPEN_MS) return { kind: 'ack', lead, reason: 'lost_recent', session: last };
      } else return { kind: 'ack', lead, reason: 'active', session: last };                                          // CASO C
    }
  }
  if (last && last.status === 'expired' && last.lead_id) {
    const prev: Ctx = last.context || { fields: {} };
    const ctx: Ctx = prev.journey === 'outbound_sirios'
      ? { ...prev, fields: { ...(prev.fields || {}) }, first_turn: true, resumed: true }
      : { fields: { ...(prev.fields || {}) }, greeted: true, first_turn: true, resumed: true, llm_calls: 0, msg_count: 0 };
    return { kind: 'flow', session: await db.createSession(phone, ctx, last.lead_id, nowIso), resumed: true };
  }
  const s = await db.createSession(phone, { fields: {}, first_turn: true, llm_calls: 0, msg_count: 0 }, null, nowIso);
  return { kind: 'flow', session: s, resumed: false };
}

// ---------- Envío + registro ----------
async function deliver(db: Db, wa: WaCfg, sim: Sim, phone: string, outs: Out[], owner: { sessionId: string | null; leadId: string | null }, kind: string) {
  for (const o of outs) {
    let res = await sendMessage(wa, phone, o, sim.failSend);
    if (!res.ok && o.kind !== 'text' && !sim.failSend) res = await sendMessage(wa, phone, plainFallback(o), false);
    const meta: Record<string, unknown> = { kind, step: o.step ?? null };
    if (res.dry) { meta.dry_run = true; meta.payload = res.payload; }
    if (!res.ok) meta.error = res.error;
    await db.insertMessage({
      lead_id: owner.leadId, session_id: owner.sessionId, direction: 'outbound', channel: 'whatsapp',
      message_text: o.body, provider_message_id: res.id ?? null, metadata: meta,
    });
    if (!res.ok) {
      log({ ev: 'send_failed', phone: mask(phone), error: res.error });
      if (owner.leadId) await db.addActivity(owner.leadId, 'whatsapp_send_failed', { error: res.error, kind });
      return false;
    }
  }
  return true;
}

type Sim = { failLlm: boolean; failSend: boolean; nowMs: number };

// ---------- Procesamiento de un mensaje ----------
async function handleMessage(db: Db, wa: WaCfg, sim: Sim, m: any): Promise<string> {
  const pid = String(m?.id || '');
  if (!PID_RE.test(pid)) return 'bad_id';
  const phone = '+' + String(m?.from || '').replace(/\D/g, '');
  if (!PHONE_RE.test(phone)) return 'bad_phone';
  const nowMs = sim.nowMs;

  // Idempotencia
  const ex = await db.findInbound(pid);
  let inboundId: number | null = null;
  let attempts = 1;
  if (ex) {
    const md = ex.metadata || {};
    if (md.processed === true) return 'duplicate';
    if (Date.now() - Date.parse(ex.created_at) < INFLIGHT_MS) return 'duplicate_inflight';
    attempts = (md.attempts || 1) + 1;
    if (attempts > MAX_ATTEMPTS) { await db.updateMessage(ex.id, { metadata: { ...md, processed: true, gave_up: true } }); return 'gave_up'; }
    inboundId = ex.id;
    await db.updateMessage(ex.id, { metadata: { ...md, attempts } });
  }

  // OUTBOUND 7: si el remitente es un prospecto contactado por plantilla => replied (el bot sigue igual). Best-effort: nunca rompe el flujo.
  try { if ((await db.markProspectReplied(phone)) === 'ambiguous') log({ ev: 'prospect_replied_ambiguous' }); } catch (_e) { log({ ev: 'prospect_replied_failed' }); }

  const inb = readInbound(m);
  const text = inb.text.slice(0, MAX_TEXT);
  const dec = await resolve(db, phone, nowMs);
  const baseMeta = { type: inb.type, attempts, processed: false, truncated: inb.text.length > MAX_TEXT || undefined };

  const store = async (leadId: string | null, sessionId: string | null) => {
    if (inboundId !== null) return true;
    const r = await db.insertMessage({
      lead_id: leadId, session_id: sessionId, direction: 'inbound', channel: 'whatsapp',
      message_text: inb.type === 'text' || inb.type === 'interactive' || inb.type === 'button' ? text : null,
      provider_message_id: pid, metadata: baseMeta,
    });
    if (r.duplicate) return false;
    inboundId = r.id;
    return true;
  };
  const done = async (leadId: string | null) => {
    if (inboundId !== null) await db.updateMessage(inboundId, { ...(leadId ? { lead_id: leadId } : {}), metadata: { ...baseMeta, processed: true } });
  };

  // ===== Conversación ya cerrada / lead existente: no repetir preguntas =====
  if (dec.kind === 'ack') {
    if (!(await store(dec.lead.id, null))) return 'duplicate';
    const intent = inb.type === 'text' ? strongIntent(text) : undefined;
    const evt = dec.reason === 'won' ? 'whatsapp_recontact_after_won' : 'whatsapp_new_message';
    await db.addActivity(dec.lead.id, evt, { high_intent: !!intent, reason: dec.reason });
    const patch: Record<string, unknown> = { updated_at: new Date(nowMs).toISOString() };
    if (intent && dec.reason !== 'won' && !dec.lead.high_intent_override) { patch.high_intent_override = true; patch.high_intent_reason = intent; }
    await db.updateLead(dec.lead.id, patch);
    const recentAck = await db.lastAckSince(dec.lead.id, new Date(nowMs - ACK_COOLDOWN_MS).toISOString());
    if (!recentAck) await deliver(db, wa, sim, phone, [{ kind: 'text', body: ACK }], { sessionId: null, leadId: dec.lead.id }, 'ack');
    await done(dec.lead.id);
    return `ack_${dec.reason}`;
  }

  // ===== Flujo de 5 preguntas =====
  const session = dec.session;
  let leadId = session.lead_id;
  if (!(await store(leadId, session.id))) return 'duplicate';

  let ctx: Ctx = { ...(session.context || { fields: {} }), fields: { ...(session.context?.fields || {}) } };
  ctx.msg_count = (ctx.msg_count || 0) + 1;
  const wasFirst = !!ctx.first_turn || !ctx.greeted;

  // Tipos no soportados (audio, imagen, etc.)
  if (!(inb.type === 'text' || inb.type === 'interactive' || inb.type === 'button') || !text.trim()) {
    const ok = await deliver(db, wa, sim, phone, [{ kind: 'text', body: UNSUPPORTED }], { sessionId: session.id, leadId }, 'unsupported');
    await db.updateSession(session.id, { last_message_at: new Date(nowMs).toISOString(), context: ctx });
    await done(leadId);
    return ok ? 'unsupported' : 'unsupported_send_failed';
  }

  // ===== OUTBOUND 9A: journey outbound_sirios (mismo webhook/motor; se activa SOLO por session.context.journey; Inbound V1 no pasa por aqui) =====
  if (ctx.journey === 'outbound_sirios') {
    const turn = outboundTurn(ctx, { text, interactiveId: inb.interactiveId });
    ctx = turn.ctx; ctx.first_turn = false;
    const nowIsoO = new Date(nowMs).toISOString();
    if (turn.done) {
      const lf = leadFieldsOut(ctx.fields);   // 9A: la intencion fuerte NO se propaga al scoring; queda en el contexto
      let leadO: Lead | null = null;
      if (!leadId) {
        leadO = await db.createLead(phone, lf, env('WHATSAPP_LEADS_IS_TEST') !== 'false');
        leadId = leadO.id;
        await db.linkMessages(session.id, leadId);
        await db.addActivity(leadId, 'whatsapp_lead_created', { session_id: session.id, is_test: env('WHATSAPP_LEADS_IS_TEST') !== 'false', journey: 'outbound_sirios' });
      }
      leadO = await db.updateLead(leadId, { ...leadColumns(lf), ai_summary: outboundSummary(ctx.fields) });
      await db.addActivity(leadId, 'whatsapp_conversation_completed', { temperature: leadO.temperature, score: leadO.score, session_id: session.id, journey: 'outbound_sirios' });
    }
    await deliver(db, wa, sim, phone, turn.outs, { sessionId: session.id, leadId }, turn.done ? 'final' : 'question');
    await db.updateSession(session.id, {
      status: turn.done ? 'completed' : String(turn.step), current_step: turn.done ? 'done' : String(turn.step), last_message_at: nowIsoO, context: ctx, lead_id: leadId,
    });
    await done(leadId);
    log({ ev: 'processed_outbound', phone: mask(phone), step: turn.step, route: ctx.fields.commercial_route });
    return `outbound_${turn.step}`;
  }

  const pending: Step = ctx.pending ?? 'q1';
  let parsed: Fields = {};
  const fromId = inb.interactiveId ? fromInteractiveId(inb.interactiveId) : {};
  const trivial = inb.type === 'text' && trivialMessage(text);
  if (Object.keys(fromId).length) parsed = fromId;
  else if (trivial) parsed = {}; // saludo sin contenido: no se interpreta
  else {
    const det = keywordExtract(text, pending, ctx.fields);
    let llm: Fields | null = null;
    if ((ctx.llm_calls || 0) < 40) {
      ctx.llm_calls = (ctx.llm_calls || 0) + 1;
      llm = await extractWithLlm(text, pending, env('ANTHROPIC_API_KEY'), sim.failLlm);
    }
    parsed = llm ? { ...det, ...llm } : det;
    if (llm) log({ ev: 'llm_ok', phone: mask(phone), fields: Object.keys(llm) });
    else log({ ev: 'llm_fallback', phone: mask(phone) });
    const si = strongIntent(text);
    if (si) { parsed.high_intent = true; parsed.high_intent_reason = parsed.high_intent_reason || si; }
  }

  const res = applyTurn(ctx, parsed);
  ctx = res.ctx;
  const offflow = (!wasFirst && !res.changed && !trivial) || (inb.type === 'text' && commercialQuestion(text));
  let after: Step = res.after;
  const nowIso = new Date(nowMs).toISOString();
  const isTest = env('WHATSAPP_LEADS_IS_TEST') !== 'false';

  // Lead: se crea al completar P2; luego se actualiza (el trigger de Supabase calcula score/temperatura/estado)
  let lead: Lead | null = null;
  if (!leadId && leadReady(ctx.fields)) {
    lead = await db.createLead(phone, ctx.fields, isTest);
    leadId = lead.id;
    await db.linkMessages(session.id, leadId);
    await db.addActivity(leadId, 'whatsapp_lead_created', { session_id: session.id, is_test: isTest });
  } else if (leadId && res.changed) {
    lead = await db.updateLead(leadId, leadColumns(ctx.fields));
  }

  const outs: Out[] = [];
  if (!ctx.greeted) { outs.push({ kind: 'text', body: GREETING }); ctx.greeted = true; }
  if (dec.resumed && wasFirst) outs.push({ kind: 'text', body: RESUME });
  if (offflow) outs.push({ kind: 'text', body: OFFFLOW });

  let status = 'q1';
  if (after === 'done') {
    if (leadId) {
      lead = await db.updateLead(leadId, { ...leadColumns(ctx.fields), ai_summary: buildSummary(ctx.fields) });
      await db.addActivity(leadId, 'whatsapp_conversation_completed', { temperature: lead.temperature, score: lead.score, session_id: session.id });
    }
    outs.push({ kind: 'text', body: finalMessage(lead?.temperature || 'cold', ctx.fields.contact_name) });
    ctx.pending = 'done';
    status = 'completed';
  } else {
    if (after === 'q1b') ctx.q1b_asked = true;
    if (after === 'q5') { ctx.q5_asks = (ctx.q5_asks || 0) + 1; }
    outs.push(questionFor(after, ctx));
    if (after === 'q5') ctx.privacy_sent = true;
    ctx.pending = after;
    status = after === 'q1b' ? 'q1' : after;
  }
  ctx.first_turn = false;

  await deliver(db, wa, sim, phone, outs, { sessionId: session.id, leadId }, after === 'done' ? 'final' : 'question');
  await db.updateSession(session.id, {
    status, current_step: after === 'done' ? 'done' : after, last_message_at: nowIso, context: ctx, lead_id: leadId,
  });
  await done(leadId);
  log({ ev: 'processed', phone: mask(phone), step: after, offflow, lead: !!leadId, temp: lead?.temperature });
  return `flow_${after}`;
}

// ---------- HTTP ----------
Deno.serve(async (req: Request) => {
  const verifyToken = env('WHATSAPP_VERIFY_TOKEN');
  const appSecret = env('WHATSAPP_APP_SECRET');
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID');

  if (req.method === 'GET') {
    const u = new URL(req.url);
    const token = u.searchParams.get('hub.verify_token') || '';
    const challenge = u.searchParams.get('hub.challenge') || '';
    if (!verifyToken) return json(500, { error: 'not_configured' });
    if (u.searchParams.get('hub.mode') === 'subscribe' && token && safeEq(token, verifyToken) && challenge) {
      return new Response(challenge.slice(0, 200), { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return json(403, { error: 'forbidden' });
  }
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!appSecret || !phoneNumberId) return json(500, { error: 'not_configured' });

  const declared = Number(req.headers.get('content-length') || '0');
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  const raw: Uint8Array<ArrayBuffer> = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return json(413, { error: 'too_large' });

  const sigHeader = req.headers.get('x-hub-signature-256') || '';
  const m = sigHeader.match(/^sha256=([0-9a-f]{64})$/i);
  if (!m || !safeEq(m[1].toLowerCase(), await hmacHex(appSecret, raw))) {
    log({ ev: 'bad_signature' });
    return json(401, { error: 'bad_signature' });
  }

  let body: any;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return json(400, { error: 'bad_json' }); }
  if (body?.object !== 'whatsapp_business_account') return json(200, { ok: true, ignored: 'object' });

  if (env('LEADS_BOT_ENABLED') !== 'true') { log({ ev: 'bot_disabled' }); return json(200, { ok: true, disabled: true }); }

  const token = env('WHATSAPP_ACCESS_TOKEN') || undefined;
  const wa: WaCfg = { token, phoneNumberId, version: env('WHATSAPP_GRAPH_VERSION') || 'v21.0' };
  const simulation = !token; // sin token no se envía nada a Meta
  const hdr = (k: string) => (simulation ? req.headers.get(k) : null);
  const simNow = hdr('x-sim-now') ? Date.parse(hdr('x-sim-now')!) : NaN;
  const sim: Sim = { failLlm: hdr('x-sim-fail-llm') === '1', failSend: hdr('x-sim-fail-send') === '1', nowMs: Number.isFinite(simNow) ? simNow : Date.now() };

  const results: string[] = [];
  let ignored = 0;
  try {
    const db = makeDb();
    let count = 0;
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (ch?.field !== 'messages') continue;
        const v = ch.value || {};
        if (v?.metadata?.phone_number_id !== phoneNumberId) { ignored++; continue; }
        for (const msg of Array.isArray(v.messages) ? v.messages : []) {
          if (++count > MAX_MESSAGES_PER_REQUEST) break;
          results.push(await handleMessage(db, wa, sim, msg));
        }
      }
    }
  } catch (e) {
    // Fallo de base de datos antes de procesar: 500 para que Meta reintente (la idempotencia evita duplicados)
    log({ ev: 'error', msg: String((e as Error).message).slice(0, 200) });
    return json(500, { error: 'processing_failed' });
  }
  return json(200, { ok: true, results, ignored_phone_number: ignored });
});
