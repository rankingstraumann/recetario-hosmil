// db.ts — Acceso a Supabase con service_role (solo dentro de la Edge Function; la key la inyecta Supabase).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Ctx, Fields } from './engine.ts';
import { pickReplyTarget, type SentRow } from './reply.ts';
import { selectOutboundProspect, type OutboundCandidate, type OutboundSelection } from './outbound-sirios.ts';

export type Session = { id: string; phone_e164: string; lead_id: string | null; current_step: string; status: string; last_message_at: string; context: Ctx };
export type Lead = { id: string; status: string; updated_at: string; high_intent_override: boolean; score: number; temperature: string };

const LEAD_COLS = 'id,status,updated_at,high_intent_override,score,temperature';

export function makeDb() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const fail = (op: string, error: any) => { throw new Error(`db_${op}:${error?.code || ''}:${String(error?.message || '').slice(0, 120)}`); };

  return {
    async findInbound(providerId: string) {
      const { data, error } = await sb.from('digital_lead_messages').select('id,created_at,metadata').eq('provider_message_id', providerId).maybeSingle();
      if (error) fail('findInbound', error);
      return data as { id: number; created_at: string; metadata: any } | null;
    },
    /** OUTBOUND 7: respuesta entrante de un prospecto contactado => replied. CONSERVADOR: nunca actualiza por telefono en bloque.
     *  Candidatos = phone exacto + contacted; 1 => ese; >1 => el del envio 'sent' mas reciente (digital_outbound_sends); si no es inequivoco => ninguno. */
    async markProspectReplied(phone: string): Promise<'updated' | 'none' | 'ambiguous'> {
      const c = await sb.from('digital_prospects').select('id').eq('phone_e164', phone).eq('outreach_status', 'contacted').limit(50);
      if (c.error) fail('replyCandidates', c.error);
      const ids = ((c.data || []) as { id: string }[]).map((r) => r.id);
      let sent: SentRow[] = [];
      if (ids.length > 1) {
        const s = await sb.from('digital_outbound_sends').select('prospect_id,sent_at').eq('status', 'sent').in('prospect_id', ids).order('sent_at', { ascending: false }).limit(50);
        if (s.error) fail('replySends', s.error);
        sent = (s.data || []) as SentRow[];
      }
      const t = pickReplyTarget(ids, sent);
      if (t.kind !== 'one') return t.kind === 'none' ? 'none' : 'ambiguous';
      // UN solo prospecto, por id (nunca por telefono); la condicion contacted evita pisar otro estado
      const u = await sb.from('digital_prospects').update({ outreach_status: 'replied' }).eq('id', t.id).eq('outreach_status', 'contacted');
      if (u.error) fail('markProspectReplied', u.error);
      return 'updated';
    },
    /** OUTBOUND 9B: candidatos (contacted/replied, cualquier is_test) + envios 'sent' => seleccion pura y conservadora (selectOutboundProspect). */
    async getOutboundSelection(phone: string): Promise<OutboundSelection> {
      const c = await sb.from('digital_prospects').select('id,is_test,whatsapp_consent,outreach_status,full_name,clinic_name,commune')
        .eq('phone_e164', phone).in('outreach_status', ['contacted', 'replied']).limit(50);
      if (c.error) fail('outboundCandidates', c.error);
      const cands = (c.data || []) as OutboundCandidate[];
      if (cands.length === 0) return { kind: 'none' };
      const s = await sb.from('digital_outbound_sends').select('prospect_id,sent_at').eq('status', 'sent').in('prospect_id', cands.map((x) => x.id)).order('sent_at', { ascending: false }).limit(200);
      if (s.error) fail('outboundSends', s.error);
      return selectOutboundProspect(cands, (s.data || []) as SentRow[]);
    },
    /** OUTBOUND 9B: conversion atomica prospecto -> lead (RPC SECURITY DEFINER solo service_role; valida TEST-ONLY y consentimiento en BD). */
    async completeOutboundConversion(a: { session_id: string; prospect_id: string; fields: Fields; summary: string }) {
      const { data, error } = await sb.rpc('complete_outbound_conversion', { p_session_id: a.session_id, p_prospect_id: a.prospect_id, p_fields: a.fields, p_summary: a.summary });
      if (error) fail('completeOutboundConversion', error);
      return data as { lead_id: string; score: number; temperature: string; status: string; lead_created: boolean; already_converted: boolean };
    },
    async getActiveSession(phone: string) {
      const { data, error } = await sb.from('digital_lead_sessions').select('*').eq('phone_e164', phone)
        .not('status', 'in', '(completed,expired,handed_off)').maybeSingle();
      if (error) fail('getActiveSession', error);
      return data as Session | null;
    },
    async getLatestSession(phone: string) {
      const { data, error } = await sb.from('digital_lead_sessions').select('*').eq('phone_e164', phone)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) fail('getLatestSession', error);
      return data as Session | null;
    },
    async createSession(phone: string, ctx: Ctx, leadId: string | null, nowIso: string) {
      const { data, error } = await sb.from('digital_lead_sessions').insert({
        phone_e164: phone, lead_id: leadId, context: ctx, last_message_at: nowIso,
      }).select('*').single();
      if (error) {
        if ((error as any).code === '23505') { // carrera: otra invocación creó la sesión activa
          const s = await this.getActiveSession(phone); if (s) return s;
        }
        fail('createSession', error);
      }
      return data as Session;
    },
    async updateSession(id: string, patch: Record<string, unknown>) {
      const { error } = await sb.from('digital_lead_sessions').update(patch).eq('id', id);
      if (error) fail('updateSession', error);
    },
    async getLead(id: string) {
      const { data, error } = await sb.from('digital_leads').select(LEAD_COLS).eq('id', id).maybeSingle();
      if (error) fail('getLead', error);
      return data as Lead | null;
    },
    async createLead(phone: string, f: Fields, isTest: boolean) {
      const { data, error } = await sb.from('digital_leads').insert({
        source_channel: 'meta_whatsapp', phone_e164: phone, is_test: isTest, ...leadColumns(f),
      }).select(LEAD_COLS).single();
      if (error) fail('createLead', error);
      return data as Lead;
    },
    async updateLead(id: string, patch: Record<string, unknown>) {
      const { data, error } = await sb.from('digital_leads').update(patch).eq('id', id).select(LEAD_COLS).single();
      if (error) fail('updateLead', error);
      return data as Lead;
    },
    async insertMessage(row: Record<string, unknown>) {
      const { data, error } = await sb.from('digital_lead_messages').insert(row).select('id').single();
      if (error) {
        if ((error as any).code === '23505') return { duplicate: true as const, id: null };
        fail('insertMessage', error);
      }
      return { duplicate: false as const, id: (data as any).id as number };
    },
    async updateMessage(id: number, patch: Record<string, unknown>) {
      const { error } = await sb.from('digital_lead_messages').update(patch).eq('id', id);
      if (error) fail('updateMessage', error);
    },
    async linkMessages(sessionId: string, leadId: string) {
      const { error } = await sb.from('digital_lead_messages').update({ lead_id: leadId }).eq('session_id', sessionId).is('lead_id', null);
      if (error) fail('linkMessages', error);
    },
    async addActivity(leadId: string, eventType: string, detail: Record<string, unknown>) {
      const { error } = await sb.from('digital_lead_activities').insert({ lead_id: leadId, event_type: eventType, detail });
      if (error) fail('addActivity', error);
    },
    async lastAckSince(leadId: string, sinceIso: string) {
      const { data, error } = await sb.from('digital_lead_messages').select('id').eq('lead_id', leadId).eq('direction', 'outbound')
        .contains('metadata', { kind: 'ack' }).gte('created_at', sinceIso).limit(1);
      if (error) fail('lastAckSince', error);
      return (data || []).length > 0;
    },
  };
}
export type Db = ReturnType<typeof makeDb>;

/** Columnas de negocio del lead. Siempre incluye las columnas de scoring para que el trigger recalcule. */
export function leadColumns(f: Fields): Record<string, unknown> {
  const c: Record<string, unknown> = {
    uses_intraoral_scanner: f.uses_intraoral_scanner ?? null,
    current_scanner: f.current_scanner ?? null,
    need: f.need ?? null,
    purchase_timeline: f.purchase_timeline ?? null,
    wants_demo: f.wants_demo ?? null,
    wants_quote: f.wants_quote ?? null,
  };
  if (f.contact_name) c.contact_name = f.contact_name;
  if (f.clinic_name) c.clinic_name = f.clinic_name;
  if (f.commune) c.commune = f.commune;
  if (f.high_intent) { c.high_intent_override = true; if (f.high_intent_reason) c.high_intent_reason = f.high_intent_reason; }
  return c;
}
