// reply.ts -- OUTBOUND 7: resolucion CONSERVADORA del prospecto que responde (logica pura, sin I/O).
// Una respuesta inbound NUNCA puede marcar mas de un prospecto como replied (los telefonos pueden repetirse entre Sold-To).
export interface SentRow { prospect_id: string; sent_at: string }
export type ReplyTarget = { kind: 'none' } | { kind: 'one'; id: string; via: 'unico' | 'envio_reciente' } | { kind: 'ambiguous' };

/**
 * @param candidateIds ids con phone_e164 exacto y outreach_status='contacted'
 * @param sent         envios outbound status='sent' (digital_outbound_sends) de esos candidatos
 *  0 candidatos -> none | 1 -> ese | >1 -> el del envio 'sent' MAS RECIENTE, solo si es inequivoco; si no -> ambiguous (no se actualiza ninguno)
 */
export function pickReplyTarget(candidateIds: string[], sent: SentRow[]): ReplyTarget {
  const ids = [...new Set(candidateIds)];
  if (ids.length === 0) return { kind: 'none' };
  if (ids.length === 1) return { kind: 'one', id: ids[0], via: 'unico' };
  const rel = sent.filter((s) => ids.includes(s.prospect_id) && Number.isFinite(Date.parse(s.sent_at)))
    .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
  if (rel.length === 0) return { kind: 'ambiguous' };
  const top = rel[0];
  // empate exacto con OTRO prospecto => no es inequivoco
  if (rel.some((r) => r.prospect_id !== top.prospect_id && Date.parse(r.sent_at) === Date.parse(top.sent_at))) return { kind: 'ambiguous' };
  return { kind: 'one', id: top.prospect_id, via: 'envio_reciente' };
}
