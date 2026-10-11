// FAKE in-memory db para pruebas locales (misma interfaz que db.ts real)
import type { Ctx, Fields } from './engine.ts';
export const T: any = { sessions: [], leads: [], messages: [], acts: [] };
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
