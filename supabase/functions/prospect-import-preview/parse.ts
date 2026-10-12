// PARSING DETERMINISTA de planillas de prospectos (Outbound 2: solo PREVIEW).
// Modulo puro: sin red, sin librerias, sin IA. No inserta nada. No registra datos personales.

export const LIMITS = {
  maxBytes: 5 * 1024 * 1024, // 5 MB
  maxRows: 5000,             // filas de datos totales (todas las hojas)
  maxSheets: 20,
  maxCols: 60,
  maxCellLen: 2000,
  maxFieldLen: 300,          // campos cortos (nombre, cliente, cartera...)
  headerScanRows: 10,
};

export type RawSheet = { name: string; rows: unknown[][] };
export type Status = 'VALIDO' | 'INVALIDO' | 'DUPLICADO' | 'ADVERTENCIA';

export class ImportError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// ---------------- Normalizacion de texto ----------------
export function normKey(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
export function cleanStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const iso = v.toISOString();
    s = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  } else if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else s = String(v);
  return s.normalize('NFC').replace(/[\s ]+/g, ' ').trim();
}

// ---------------- Encabezados reconocidos ----------------
export type Field = 'external' | 'clinic' | 'contact' | 'owner' | 'priority' | 'year' | 'trade' | 'notes' | 'phone' | 'email';
const ALIASES: Record<string, Field> = {
  'sold to': 'external', 'soldto': 'external', 'sold to party': 'external',
  'cliente': 'clinic', 'clinica': 'clinic', 'razon social': 'clinic', 'nombre cliente': 'clinic',
  'contacto': 'contact', 'nombre contacto': 'contact', 'nombre': 'contact',
  'cartera original': 'owner', 'cartera': 'owner',
  'prioridad': 'priority',
  'ultimo ano facturado': 'year', 'ultimo anio facturado': 'year', 'ultimo ano fact': 'year',
  'trade up financiero': 'trade',
  'observacion': 'notes', 'observaciones': 'notes',
  'telefono': 'phone', 'celular': 'phone', 'fono': 'phone', 'movil': 'phone', 'whatsapp': 'phone',
  'telefono contacto': 'phone', 'celular contacto': 'phone',
  'email': 'email', 'correo': 'email', 'e mail': 'email', 'correo electronico': 'email',
};
export function fieldOf(cell: unknown): Field | null {
  const k = normKey(cleanStr(cell));
  return k && Object.prototype.hasOwnProperty.call(ALIASES, k) ? ALIASES[k] : null;
}

// ---------------- CSV (RFC 4180 + delimitador auto) ----------------
export function decodeCsv(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('windows-1252').decode(bytes); }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
export function parseCsv(text: string, maxRows = LIMITS.maxRows + 50): unknown[][] {
  // delimitador: el mas frecuente (fuera de comillas) en las primeras lineas
  const cand = [',', ';', '\t', '|'];
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false, lines = 0;
  for (let i = 0; i < text.length && lines < 5; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === '\n') lines++;
    else if (!inQ && c in counts) counts[c]++;
  }
  const delim = cand.reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');
  const rows: unknown[][] = [];
  let row: string[] = [], cell = '', q = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows) throw new ImportError('filas_excedidas', 'El archivo supera el máximo de filas permitido.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) pushCell();
    else if (c === '\r') { /* se ignora; \n cierra la fila */ }
    else if (c === '\n') pushRow();
    else cell += c;
  }
  if (cell !== '' || row.length) pushRow();
  return rows;
}

// ---------------- Normalizadores de campo ----------------
export function normExternalId(v: unknown): { value: string | null; invalid: boolean } {
  if (v === null || v === undefined || cleanStr(v) === '') return { value: null, invalid: false };
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || Math.abs(v) >= 1e15) return { value: null, invalid: true };
    return { value: String(v), invalid: false };
  }
  const s = cleanStr(v);
  return /^[A-Za-z0-9-]{1,20}$/.test(s) ? { value: s, invalid: false } : { value: null, invalid: true };
}
export function normYear(v: unknown): { value: number | null; invalid: boolean } {
  if (v === null || v === undefined || cleanStr(v) === '') return { value: null, invalid: false };
  let n: number;
  if (typeof v === 'number') { if (!Number.isInteger(v)) return { value: null, invalid: true }; n = v; }
  else { const s = cleanStr(v); if (!/^\d{4}$/.test(s)) return { value: null, invalid: true }; n = Number(s); }
  return n >= 1990 && n <= 2100 ? { value: n, invalid: false } : { value: null, invalid: true };
}
// Criterio documentado: O/SI/TRUE/VERDADERO/YES/1 -> true; NO/FALSE/FALSO/0 -> false;
// vacio -> null (ausencia de marca != "no"); cualquier otro valor -> null + advertencia (no se inventa).
export function normTrade(v: unknown): { value: boolean | null; ambiguous: boolean } {
  const s = normKey(cleanStr(v));
  if (s === '') return { value: null, ambiguous: false };
  if (['o', 'si', 'true', 'verdadero', 'yes', '1'].includes(s)) return { value: true, ambiguous: false };
  if (['no', 'false', 'falso', '0'].includes(s)) return { value: false, ambiguous: false };
  return { value: null, ambiguous: true };
}
// Telefono Chile: celular 9 digitos que empieza con 9 (con o sin 56/+56) -> +569XXXXXXXX.
// Internacional "+" valido E.164 -> tal cual. Cualquier otra cosa -> null (con advertencia si venia dato).
export function normPhone(v: unknown): { raw: string | null; e164: string | null } {
  const raw = cleanStr(v);
  if (!raw) return { raw: null, e164: null };
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    const d = digits.slice(1).replace(/\D/g, '');
    const e = '+' + d;
    if (/^\+569\d{8}$/.test(e)) return { raw, e164: e };
    if (d.startsWith('56')) return { raw, e164: null }; // +56 no celular
    return { raw, e164: /^\+[1-9]\d{6,14}$/.test(e) ? e : null };
  }
  const d = digits.replace(/\D/g, '');
  if (/^9\d{8}$/.test(d)) return { raw, e164: '+56' + d };
  if (/^569\d{8}$/.test(d)) return { raw, e164: '+' + d };
  return { raw, e164: null };
}

// ---------------- Analisis ----------------
export type Existing = { external_customer_id: string | null; phone_e164: string | null; full_name: string | null; clinic_name: string | null };
export type Problem = { code: string; level: 'invalid' | 'duplicate' | 'warning'; msg: string };
export type ParsedRow = {
  sheet: string; row: number; status: Status; problems: Problem[];
  external_customer_id: string | null; full_name: string | null; clinic_name: string | null;
  source_owner: string | null; priority_source: string | null; last_billed_year: number | null;
  trade_up_financial: boolean | null; phone_raw: string | null; phone_e164: string | null; email: string | null;
  notes: string | null; raw_payload: Record<string, unknown>;
};
export type SheetInfo = { name: string; data_rows: number; empty_rows_skipped: number; repeated_headers: number; header_row: number | null; note: string | null };
export type Summary = {
  total: number; validas: number; invalidas: number; duplicado_fuerte: number; adv_telefono: number; adv_nombre: number;
  sin_telefono: number; sin_consentimiento: number; listas_para_importar: number;
  encabezados_repetidos: number; hojas_vacias: number;
};
export type Analysis = { summary: Summary; rows: ParsedRow[]; sheets: SheetInfo[] };

const P = (code: string, level: Problem['level'], msg: string): Problem => ({ code, level, msg });

export function analyze(sheets: RawSheet[], existing: Existing[] = []): Analysis {
  if (sheets.length > LIMITS.maxSheets) throw new ImportError('hojas_excedidas', 'El archivo tiene demasiadas hojas.');
  const rows: ParsedRow[] = [];
  const infos: SheetInfo[] = [];
  let totalData = 0;

  for (const sh of sheets) {
    const info: SheetInfo = { name: sh.name, data_rows: 0, empty_rows_skipped: 0, repeated_headers: 0, header_row: null, note: null };
    infos.push(info);
    const isEmpty = (r: unknown[]) => !r || r.every((c) => cleanStr(c) === '');
    if (sh.rows.every(isEmpty)) { info.note = 'Hoja vacía'; continue; }

    // 1) encabezado: primera fila (dentro de las primeras N) con >=2 campos reconocidos
    let hIdx = -1; let colField: (Field | null)[] = [];
    for (let i = 0; i < Math.min(sh.rows.length, LIMITS.headerScanRows); i++) {
      const r = sh.rows[i] || [];
      const f = r.map(fieldOf);
      if (f.filter(Boolean).length >= 2) { hIdx = i; colField = f; break; }
    }
    if (hIdx < 0) { info.note = 'Sin encabezados reconocibles: hoja omitida'; continue; }
    info.header_row = hIdx + 1;
    const headerNames = (sh.rows[hIdx] || []).map(cleanStr);
    if (headerNames.length > LIMITS.maxCols) throw new ImportError('columnas_excedidas', 'La hoja tiene demasiadas columnas.');
    const used = new Set<Field>();
    const idxOf: Partial<Record<Field, number>> = {};
    colField.forEach((f, ci) => { if (f && !used.has(f)) { used.add(f); idxOf[f] = ci; } });
    const hKeys = new Set(headerNames.map(normKey).filter(Boolean));

    for (let ri = hIdx + 1; ri < sh.rows.length; ri++) {
      const r = sh.rows[ri] || [];
      if (isEmpty(r)) { info.empty_rows_skipped++; continue; }
      // encabezado repetido dentro de la hoja
      const rf = r.map(fieldOf).filter(Boolean).length;
      const matches = r.filter((c) => hKeys.has(normKey(cleanStr(c)))).length;
      if (rf >= 2 && matches >= Math.max(2, Math.ceil(hKeys.size / 2))) { info.repeated_headers++; continue; }
      if (r.length > LIMITS.maxCols) throw new ImportError('columnas_excedidas', 'Una fila tiene demasiadas columnas.');

      totalData++;
      if (totalData > LIMITS.maxRows) throw new ImportError('filas_excedidas', 'El archivo supera el máximo de ' + LIMITS.maxRows + ' filas.');
      info.data_rows++;

      const get = (f: Field) => (idxOf[f] !== undefined ? r[idxOf[f] as number] : undefined);
      const problems: Problem[] = [];
      // raw_payload: TODAS las columnas con su valor original (sin normalizar)
      const raw: Record<string, unknown> = { _hoja: sh.name, _fila: ri + 1 };
      headerNames.forEach((h, ci) => {
        const v = r[ci];
        if (v === null || v === undefined || cleanStr(v) === '') return;
        const key = h || ('col_' + (ci + 1));
        raw[key in raw ? key + '_' + (ci + 1) : key] = v instanceof Date ? cleanStr(v) : v;
      });
      for (const c of r) if (typeof c === 'string' && c.length > LIMITS.maxCellLen) throw new ImportError('celda_excedida', 'Una celda supera el largo máximo permitido.');

      const ext = normExternalId(get('external'));
      if (ext.invalid) problems.push(P('SOLD_TO_INVALIDO', 'invalid', 'Sold-To inválido (decimal, científico o con caracteres no permitidos)'));
      else if (!ext.value) problems.push(P('SIN_SOLD_TO', 'warning', 'Sin Sold-To: no se puede detectar duplicado fuerte'));

      const yr = normYear(get('year'));
      if (yr.invalid) problems.push(P('ANIO_INVALIDO', 'invalid', 'Año de última facturación inválido (debe ser entero 1990–2100)'));
      const tr = normTrade(get('trade'));
      if (tr.ambiguous) problems.push(P('TRADE_UP_AMBIGUO', 'warning', 'Valor ambiguo en Trade Up financiero: se deja vacío'));

      const short = (f: Field): string | null => {
        const s = cleanStr(get(f));
        if (!s) return null;
        if (s.length > LIMITS.maxFieldLen) { problems.push(P('TEXTO_LARGO', 'invalid', 'Texto demasiado largo en ' + f)); return null; }
        return s;
      };
      const clinic = short('clinic'), contact = short('contact'), owner = short('owner'), prio = short('priority');
      const notesS = cleanStr(get('notes'));
      const notes = notesS ? notesS.slice(0, LIMITS.maxCellLen) : null;

      const ph = normPhone(get('phone'));
      if (ph.raw && !ph.e164) problems.push(P('TEL_NO_NORMALIZABLE', 'warning', 'Teléfono no reconocible como celular: se deja sin teléfono'));
      let email: string | null = cleanStr(get('email')) || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { problems.push(P('EMAIL_INVALIDO', 'warning', 'Correo inválido: se deja vacío')); email = null; }

      if (!ext.value && !ext.invalid && !clinic && !contact && !ph.e164 && !email) {
        problems.push(P('SIN_IDENTIFICACION', 'invalid', 'Fila sin Sold-To, cliente, contacto ni teléfono'));
      }

      rows.push({
        sheet: sh.name, row: ri + 1, status: 'VALIDO', problems,
        external_customer_id: ext.value, full_name: contact, clinic_name: clinic,
        source_owner: owner, priority_source: prio, last_billed_year: yr.value,
        trade_up_financial: tr.value, phone_raw: ph.raw, phone_e164: ph.e164, email, notes, raw_payload: raw,
      });
    }
  }

  // ---------- Duplicados ----------
  const nameKey = (r: { full_name: string | null; clinic_name: string | null }) => {
    const k = normKey(r.full_name || r.clinic_name || '');
    return k.length >= 4 ? k : '';
  };
  const exExt = new Set(existing.map((e) => e.external_customer_id).filter(Boolean) as string[]);
  const exPhone = new Set(existing.map((e) => e.phone_e164).filter(Boolean) as string[]);
  const exName = new Set(existing.map((e) => nameKey(e)).filter(Boolean));

  const firstByExt = new Map<string, ParsedRow>();
  const phoneGroups = new Map<string, ParsedRow[]>();
  const nameGroups = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    if (r.problems.some((p) => p.level === 'invalid')) continue;
    // 1) Sold-To exacto = duplicado FUERTE (la primera aparicion queda; las siguientes son duplicados)
    if (r.external_customer_id) {
      const first = firstByExt.get(r.external_customer_id);
      if (first) r.problems.push(P('SOLD_TO_DUP_ARCHIVO', 'duplicate', 'Sold-To repetido en el archivo (ya aparece en hoja "' + first.sheet + '", fila ' + first.row + ')'));
      else firstByExt.set(r.external_customer_id, r);
      if (exExt.has(r.external_customer_id)) r.problems.push(P('SOLD_TO_DUP_BD', 'duplicate', 'Ya existe un prospecto con este Sold-To'));
    }
    // 2) y 3) solo advertencias; se marcan TODOS los miembros del grupo; nunca se fusiona
    if (r.phone_e164) {
      (phoneGroups.get(r.phone_e164) ?? phoneGroups.set(r.phone_e164, []).get(r.phone_e164)!).push(r);
      if (exPhone.has(r.phone_e164)) r.problems.push(P('TEL_DUP_BD', 'warning', 'Este teléfono ya existe en prospectos (posible duplicado)'));
    }
    const nk = nameKey(r);
    if (nk) {
      (nameGroups.get(nk) ?? nameGroups.set(nk, []).get(nk)!).push(r);
      if (exName.has(nk)) r.problems.push(P('NOMBRE_DUP_BD', 'warning', 'Nombre/cliente similar ya existe en prospectos (revisar)'));
    }
  }
  for (const g of phoneGroups.values()) if (g.length > 1) g.forEach((r) => r.problems.push(P('TEL_DUP_ARCHIVO', 'warning', 'Teléfono repetido en el archivo (' + g.length + ' filas): posible duplicado')));
  for (const g of nameGroups.values()) if (g.length > 1) g.forEach((r) => r.problems.push(P('NOMBRE_DUP_ARCHIVO', 'warning', 'Nombre/cliente repetido en el archivo (' + g.length + ' filas): revisar')));

  // ---------- Estado final y resumen ----------
  for (const r of rows) {
    r.status = r.problems.some((p) => p.level === 'invalid') ? 'INVALIDO'
      : r.problems.some((p) => p.level === 'duplicate') ? 'DUPLICADO'
      : r.problems.length ? 'ADVERTENCIA' : 'VALIDO';
  }
  const has = (r: ParsedRow, pre: string) => r.problems.some((p) => p.code.startsWith(pre));
  const summary: Summary = {
    total: rows.length,
    validas: rows.filter((r) => r.status !== 'INVALIDO').length,
    invalidas: rows.filter((r) => r.status === 'INVALIDO').length,
    duplicado_fuerte: rows.filter((r) => r.status === 'DUPLICADO').length,
    adv_telefono: rows.filter((r) => has(r, 'TEL_DUP')).length,
    adv_nombre: rows.filter((r) => has(r, 'NOMBRE_DUP')).length,
    sin_telefono: rows.filter((r) => !r.phone_e164).length,
    sin_consentimiento: rows.length, // whatsapp_consent = 'unknown' por defecto en toda fila importada
    listas_para_importar: rows.filter((r) => r.status === 'VALIDO' || r.status === 'ADVERTENCIA').length,
    encabezados_repetidos: infos.reduce((a, s) => a + s.repeated_headers, 0),
    hojas_vacias: infos.filter((s) => s.note === 'Hoja vacía').length,
  };
  return { summary, rows, sheets: infos };
}
