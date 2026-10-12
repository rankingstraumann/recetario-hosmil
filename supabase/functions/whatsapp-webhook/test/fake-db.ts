// FAKE in-memory db para pruebas locales (misma interfaz que db.ts real)
import type { Ctx, Fields } from './engine.ts';
import { pickReplyTarget } from './reply.ts';
import { selectOutboundProspect } from './outbound-sirios.ts';
export const T: any = { sessions: [], leads: [], messages: [], acts: [], prospects: [], sends: [], failConversion: false, rpcCalls: [] };
let seq = 1;
const uid = () => 'id-' + (seq++);
function score(l: any) {
  let s = 0;
  if (l.uses_intraoral_scanner) s += 10 + (l.current_scanner ? 5 : 0); else if (l.uses_intraoral_scanner === false) s += 5;
  s += ({ renew: 25, trade_up: 25, first_scanner: 20, digital_flow: 15, know_sirios: 10 } as any)[l.need] || 0;
  s += ({ now: 25, '1_3_months': 20, '3_6_months': 10 } as any)[l.purchase_timeline] || 0;
  s += l.wants_demo && l.wants_quote ? 30 : l.wants_quote ? 25 : l.wants_demo ? 20 : 0;
  if (l.high_intent_override) s = Math.max(s, 70);
  l.score = s; l.temperature = s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold';
  if (['new','qualifying','cold','warm','hot'].includes(l.status)) l.status = l.temperature;
}
const clone = (x: any) => (x ? JSON.parse(JSON.stringify(x)) : x);
export function makeDb() {
  return {
    async findInbound(pid: string) { const m = T.messages.find((x: any) => x.provider_message_id === pid); return m ? clone(m) : null; },
    async markProspectReplied(phone: string) {
      const cand = T.prospects.filter((p: any) => p.phone_e164 === phone && p.outreach_status === 'contacted');
      const ids = cand.map((p: any) => p.id);
      const sent = ids.length > 1 ? T.sends.filter((x: any) => x.status === 'sent' && ids.includes(x.prospect_id)).map((x: any) => ({ prospect_id: x.prospect_id, sent_at: x.sent_at })) : [];
      const t = pickReplyTarget(ids, sent);
      if (t.kind !== 'one') return t.kind === 'none' ? 'none' : 'ambiguous';
      const row = T.prospects.find((p: any) => p.id === t.id && p.outreach_status === 'contacted'); if (row) row.outreach_status = 'replied';
      return 'updated';
    },
    async getOutboundSelection(phone: string) {
      const cands = T.prospects.filter((p: any) => p.phone_e164 === phone && ['contacted', 'replied'].includes(p.outreach_status)).map((p: any) => clone(p));
      const ids = cands.map((p: any) => p.id);
      const sent = T.sends.filter((x: any) => x.status === 'sent' && ids.includes(x.prospect_id)).map((x: any) => ({ prospect_id: x.prospect_id, sent_at: x.sent_at }));
      return cands.length ? selectOutboundProspect(cands, sent) : { kind: 'none' };
    },
    // Espejo FIEL de la RPC complete_outbound_conversion (sql/leads-digital/016): mismas barreras, idempotencia y efectos.
    async completeOutboundConversion(a: any) {
      T.rpcCalls.push(a.prospect_id);
      if (T.failConversion) throw new Error('db_completeOutboundConversion:simulated');
      const p = T.prospects.find((x: any) => x.id === a.prospect_id); if (!p) throw new Error('PROSPECTO_NO_ENCONTRADO');
      const s = T.sessions.find((x: any) => x.id === a.session_id); if (!s) throw new Error('SESION_NO_ENCONTRADA');
      if (p.is_test !== true) throw new Error('PROSPECTO_REAL_NO_PERMITIDO');
      if (p.whatsapp_consent !== 'yes') throw new Error('SIN_CONSENTIMIENTO');
      if (p.outreach_status === 'opted_out') throw new Error('PROSPECTO_OPT_OUT');
      if (!['contacted', 'replied', 'converted'].includes(p.outreach_status) || (p.outreach_status === 'converted' && !p.linked_lead_id)) throw new Error('ESTADO_NO_VALIDO');
      if (!p.phone_e164 || s.phone_e164 !== p.phone_e164 || s.context?.journey !== 'outbound_sirios' || s.context?.o?.prospect_id !== p.id) throw new Error('SESION_NO_CORRESPONDE');
      if (['contacted', 'replied'].includes(p.outreach_status) && !T.sends.some((x: any) => x.prospect_id === p.id && x.status === 'sent')) throw new Error('SIN_ENVIO_VALIDO');
      if (p.linked_lead_id && s.lead_id && p.linked_lead_id !== s.lead_id) throw new Error('LEAD_CONFLICTO');
      const was = p.outreach_status; const f = a.fields || {};
      let l = T.leads.find((x: any) => x.id === (p.linked_lead_id || s.lead_id));
      let created = false;
      const cols: any = { ...leadColumns({ ...f, high_intent: false, high_intent_reason: undefined }), customer_profile: f.customer_profile ?? null, commercial_route: f.commercial_route ?? null, product_interest: f.product_interest ?? null, cta_selected: f.cta_selected ?? null, ai_summary: a.summary ?? null };
      if (!l) { l = { id: uid(), status: 'new', source_channel: 'meta_whatsapp', phone_e164: p.phone_e164, is_test: true, high_intent_override: false, updated_at: new Date().toISOString(), ...cols }; l.high_intent_override = f.high_intent === true; if (f.high_intent === true) l.high_intent_reason = f.high_intent_reason ?? null; T.leads.push(l); created = true; }
      else { for (const k of Object.keys(cols)) { if (cols[k] !== null && cols[k] !== undefined) l[k] = cols[k]; } if (f.high_intent === true) { l.high_intent_override = true; l.high_intent_reason = l.high_intent_reason ?? f.high_intent_reason ?? null; } }
      score(l);
      p.linked_lead_id = l.id; p.outreach_status = 'converted'; s.lead_id = l.id;
      T.messages.filter((m: any) => m.session_id === s.id && !m.lead_id).forEach((m: any) => (m.lead_id = l.id));
      if (was !== 'converted') T.acts.push({ lead_id: l.id, event_type: 'outbound_sirios_conversion', detail: { session_id: s.id, prospect_id: p.id, lead_created: created } });
      return { lead_id: l.id, score: l.score, temperature: l.temperature, status: l.status, lead_created: created, already_converted: was === 'converted' };
    },
    async getActiveSession(phone: string) { return clone(T.sessions.find((s: any) => s.phone_e164 === phone && !['completed','expired','handed_off'].includes(s.status)) || null); },
    async getLatestSession(phone: string) { const a = T.sessions.filter((s: any) => s.phone_e164 === phone); return clone(a[a.length - 1] || null); },
    async createSession(phone: string, ctx: Ctx, leadId: string | null, nowIso: string) {
      if (T.sessions.some((s: any) => s.phone_e164 === phone && !['completed','expired','handed_off'].includes(s.status))) throw new Error('unique active');
      const s = { id: uid(), phone_e164: phone, lead_id: leadId, current_step: 'start', status: 'started', last_message_at: nowIso, context: ctx }; T.sessions.push(s); return clone(s); },
    async updateSession(id: string, p: any) { Object.assign(T.sessions.find((s: any) => s.id === id), clone(p)); },
    async getLead(id: string) { return clone(T.leads.find((l: any) => l.id === id) || null); },
    async createLead(phone: string, f: Fields, isTest: boolean) { const l: any = { id: uid(), status: 'new', source_channel: 'meta_whatsapp', phone_e164: phone, is_test: isTest, high_intent_override: false, updated_at: new Date().toISOString(), ...leadColumns(f) }; score(l); T.leads.push(l); return clone(l); },
    async updateLead(id: string, p: any) { const l = T.leads.find((x: any) => x.id === id); Object.assign(l, clone(p)); if (!('updated_at' in p)) l.updated_at = new Date().toISOString(); else l.updated_at = p.updated_at; score(l); return clone(l); },
    async insertMessage(row: any) { if (row.provider_message_id && T.messages.some((m: any) => m.provider_message_id === row.provider_message_id)) return { duplicate: true, id: null }; if (!row.lead_id && !row.session_id) throw new Error('check owner'); const m = { id: T.messages.length + 1, created_at: new Date().toISOString(), ...clone(row) }; T.messages.push(m); return { duplicate: false, id: m.id }; },
    async updateMessage(id: number, p: any) { Object.assign(T.messages.find((m: any) => m.id === id), clone(p)); },
    async linkMessages(sid: string, lid: string) { T.messages.filter((m: any) => m.session_id === sid && !m.lead_id).forEach((m: any) => (m.lead_id = lid)); },
    async addActivity(lid: string, ev: string, d: any) { T.acts.push({ lead_id: lid, event_type: ev, detail: d }); },
    async lastAckSince(lid: string, since: string) { return T.messages.some((m: any) => m.lead_id === lid && m.direction === 'outbound' && m.metadata?.kind === 'ack' && m.created_at >= since); },
  };
}
export function leadColumns(f: Fields) {
  const c: any = { uses_intraoral_scanner: f.uses_intraoral_scanner ?? null, current_scanner: f.current_scanner ?? null, need: f.need ?? null, purchase_timeline: f.purchase_timeline ?? null, wants_demo: f.wants_demo ?? null, wants_quote: f.wants_quote ?? null };
  if (f.contact_name) c.contact_name = f.contact_name; if (f.clinic_name) c.clinic_name = f.clinic_name; if (f.commune) c.commune = f.commune;
  if (f.high_intent) { c.high_intent_override = true; if (f.high_intent_reason) c.high_intent_reason = f.high_intent_reason; }
  return c;
}
export type Db = ReturnType<typeof makeDb>; export type Lead = any; export type Session = any;
