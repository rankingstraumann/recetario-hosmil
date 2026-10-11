// OUTBOUND 5 -- enriquecimiento controlado de prospectos REALES ya importados. Modulo PURO (sin red ni base).
// Reglas: match UNICAMENTE por Sold-To exacto contra prospectos is_test=false; nunca crea prospectos; solo completa
// full_name / phone_raw+phone_e164 / email cuando el dato actual esta VACIO (nunca sobrescribe, nunca borra);
// no toca consentimiento ni estado de contacto.
import { cleanStr, fieldOf, ImportError, LIMITS, normExternalId, normKey, normPhone, type Field, type RawSheet } from './parse.ts';

export type Target = { id: string; external_customer_id: string | null; full_name: string | null; phone_raw: string | null; phone_e164: string | null; email: string | null };
export type EStatus = 'ACTUALIZA' | 'SIN_CAMBIOS' | 'SIN_MATCH' | 'INVALIDO' | 'DUPLICADO_ARCHIVO' | 'MATCH_MULTIPLE';
export type EField = 'full_name' | 'phone' | 'email';
export type EnrichRow = {
  sheet: string; row: number; status: EStatus; external_customer_id: string | null;
  fills: EField[]; conflicts: EField[]; warnings: string[]; has_mobile: boolean; phone_dup: boolean;
};
export type EnrichUpdate = { id: string; external_customer_id: string; full_name?: string; phone_raw?: string; phone_e164?: string; email?: string };
export type EnrichSummary = {
  filas_archivo: number; match_exacto: number; sin_match: number; invalidas: number; duplicadas_archivo: number; match_multiple: number;
  con_movil_valido: number; sin_movil: number; telefonos_duplicados: number; filas_con_telefono_duplicado: number;
  contactos_a_completar: number; telefonos_a_completar: number; emails_a_completar: number;
  conflictos: number; filas_a_actualizar: number; sin_cambios: number;
};
export type EnrichAnalysis = { summary: EnrichSummary; sheets: { name: string; data_rows: number; header_row: number | null }[]; rows: EnrichRow[]; updates: EnrichUpdate[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FIELD_MAX = 300;

type Parsed = { sheet: string; row: number; sold: string | null; soldInvalid: boolean; name: string; phone: { raw: string | null; e164: string | null }; phoneGiven: boolean; email: string; emailInvalid: boolean };

export function analyzeEnrich(sheets: RawSheet[], targets: Target[]): EnrichAnalysis {
  // --- 1) parseo del archivo (encabezado = primera fila de las 10 primeras con Sold-To y al menos otro campo reconocido)
  const parsed: Parsed[] = [];
  const sheetInfo: EnrichAnalysis['sheets'] = [];
  let total = 0;
  for (const sh of sheets) {
    let hdr = -1, map: Partial<Record<Field, number>> = {};
    for (let i = 0; i < Math.min(sh.rows.length, LIMITS.headerScanRows); i++) {
      const m: Partial<Record<Field, number>> = {};
      sh.rows[i].forEach((c, ci) => { const f = fieldOf(c); if (f && m[f] === undefined) m[f] = ci; });
      if (m.external !== undefined && (m.contact !== undefined || m.phone !== undefined || m.email !== undefined)) { hdr = i; map = m; break; }
    }
    if (hdr < 0) { sheetInfo.push({ name: sh.name, data_rows: 0, header_row: null }); continue; }
    let n = 0;
    for (let i = hdr + 1; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      const at = (f: Field) => (map[f] === undefined ? undefined : r[map[f] as number]);
      const keys = Object.keys(map) as Field[];
      // fila repetida de encabezado
      if (keys.filter((k) => fieldOf(at(k)) === k).length >= 2) continue;
      if (r.every((c) => cleanStr(c) === '')) continue;
      total++; n++;
      if (total > LIMITS.maxRows) throw new ImportError('filas_excedidas', 'El archivo supera el máximo de filas permitido.');
      const id = normExternalId(at('external'));
      const email = cleanStr(at('email')).toLowerCase();
      const phoneCell = at('phone');
      const phone = normPhone(phoneCell);
      parsed.push({
        sheet: sh.name, row: i + 1, sold: id.value, soldInvalid: id.invalid, name: cleanStr(at('contact')).slice(0, FIELD_MAX),
        phone, phoneGiven: cleanStr(phoneCell) !== '', email, emailInvalid: email !== '' && !EMAIL_RE.test(email),
      });
    }
    sheetInfo.push({ name: sh.name, data_rows: n, header_row: hdr + 1 });
  }
  if (!sheetInfo.some((s) => s.header_row !== null))
    throw new ImportError('sin_encabezado', 'No se encontró un encabezado con "Sold-To" y al menos Contacto, Teléfono o Email.');

  // --- 2) indices
  const byExt = new Map<string, Target[]>();
  for (const t of targets) if (t.external_customer_id) { const a = byExt.get(t.external_customer_id) ?? []; a.push(t); byExt.set(t.external_customer_id, a); }
  const fileCount = new Map<string, number>();
  for (const p of parsed) if (p.sold) fileCount.set(p.sold, (fileCount.get(p.sold) ?? 0) + 1);
  const dbPhone = new Map<string, Set<string>>();
  for (const t of targets) if (t.phone_e164) { const s = dbPhone.get(t.phone_e164) ?? new Set<string>(); s.add(t.id); dbPhone.set(t.phone_e164, s); }
  // telefonos del archivo -> Sold-To distintos que lo usan (solo filas con Sold-To valido y no repetido)
  const filePhone = new Map<string, Set<string>>();
  for (const p of parsed) if (p.sold && fileCount.get(p.sold) === 1 && p.phone.e164) { const s = filePhone.get(p.phone.e164) ?? new Set<string>(); s.add(p.sold); filePhone.set(p.phone.e164, s); }

  // --- 3) clasificacion fila a fila
  const rows: EnrichRow[] = [], updates: EnrichUpdate[] = [];
  const dupPhones = new Set<string>();
  const S: EnrichSummary = {
    filas_archivo: parsed.length, match_exacto: 0, sin_match: 0, invalidas: 0, duplicadas_archivo: 0, match_multiple: 0,
    con_movil_valido: 0, sin_movil: 0, telefonos_duplicados: 0, filas_con_telefono_duplicado: 0,
    contactos_a_completar: 0, telefonos_a_completar: 0, emails_a_completar: 0, conflictos: 0, filas_a_actualizar: 0, sin_cambios: 0,
  };
  for (const p of parsed) {
    const base = { sheet: p.sheet, row: p.row, external_customer_id: p.sold, fills: [] as EField[], conflicts: [] as EField[], warnings: [] as string[], has_mobile: !!p.phone.e164, phone_dup: false };
    const push = (status: EStatus, extra: Partial<EnrichRow> = {}) => { rows.push({ ...base, ...extra, status }); };
    if (p.soldInvalid || !p.sold) { S.invalidas++; push('INVALIDO', { warnings: [p.soldInvalid ? 'sold_to_invalido' : 'sin_sold_to'] }); continue; }
    // estadisticas de telefono sobre las filas NO invalidas (con Sold-To utilizable)
    if (p.phone.e164) S.con_movil_valido++; else S.sin_movil++;
    if ((fileCount.get(p.sold) ?? 0) > 1) { S.duplicadas_archivo++; push('DUPLICADO_ARCHIVO', { warnings: ['sold_to_repetido_en_archivo'] }); continue; }
    const cand = byExt.get(p.sold) ?? [];
    if (cand.length === 0) { S.sin_match++; push('SIN_MATCH'); continue; }
    if (cand.length > 1) { S.match_multiple++; push('MATCH_MULTIPLE', { warnings: ['sold_to_repetido_en_base'] }); continue; }
    S.match_exacto++;
    const t = cand[0];
    const fills: EField[] = [], conflicts: EField[] = [], warnings: string[] = [];
    const u: EnrichUpdate = { id: t.id, external_customer_id: p.sold };
    // nombre
    if (p.name) {
      if (!cleanStr(t.full_name)) { fills.push('full_name'); u.full_name = p.name; }
      else if (normKey(t.full_name) !== normKey(p.name)) conflicts.push('full_name');
    }
    // telefono (raw + e164 juntos; solo si hay movil valido)
    let phoneDup = false;
    if (p.phoneGiven) {
      if (!p.phone.e164) warnings.push('telefono_no_movil_valido');
      else {
        const fileDup = (filePhone.get(p.phone.e164)?.size ?? 0) > 1;
        const dbOthers = [...(dbPhone.get(p.phone.e164) ?? [])].filter((id) => id !== t.id).length > 0;
        phoneDup = fileDup || dbOthers;
        if (!cleanStr(t.phone_e164) && !cleanStr(t.phone_raw)) { fills.push('phone'); u.phone_raw = (p.phone.raw ?? '').slice(0, FIELD_MAX); u.phone_e164 = p.phone.e164; }
        else if (t.phone_e164 !== p.phone.e164) conflicts.push('phone');
      }
    }
    // email
    if (p.email) {
      if (p.emailInvalid) warnings.push('email_invalido');
      else if (!cleanStr(t.email)) { fills.push('email'); u.email = p.email.slice(0, FIELD_MAX); }
      else if (cleanStr(t.email).toLowerCase() !== p.email) conflicts.push('email');
    }
    if (phoneDup && p.phone.e164) { dupPhones.add(p.phone.e164); S.filas_con_telefono_duplicado++; warnings.push('telefono_duplicado'); }
    if (fills.includes('full_name')) S.contactos_a_completar++;
    if (fills.includes('phone')) S.telefonos_a_completar++;
    if (fills.includes('email')) S.emails_a_completar++;
    if (conflicts.length) S.conflictos++;
    base.phone_dup = phoneDup;
    if (fills.length) { S.filas_a_actualizar++; updates.push(u); push('ACTUALIZA', { fills, conflicts, warnings, phone_dup: phoneDup }); }
    else { S.sin_cambios++; push('SIN_CAMBIOS', { conflicts, warnings, phone_dup: phoneDup }); }
  }
  S.telefonos_duplicados = dupPhones.size;
  return { summary: S, sheets: sheetInfo, rows, updates };
}
