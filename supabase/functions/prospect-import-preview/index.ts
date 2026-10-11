// prospect-import-preview -- OUTBOUND 2: analiza un Excel/CSV y devuelve un PREVIEW. NO inserta nada.
//
// Garantias:
//  - Solo Lead Admin (is_lead_admin() con el JWT del propio usuario). Sin service_role: la lectura de
//    digital_prospects para detectar duplicados usa la sesion del usuario (RLS).
//  - El archivo se procesa en memoria: no se guarda en Storage ni en la base.
//  - Parsing determinista (sin IA, sin servicios externos). No se evaluan formulas.
//  - Los logs contienen SOLO contadores/codigos; nunca nombres, telefonos, correos ni filas.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
// SheetJS pinneada (version fija). Importacion server-side; NO se usa CDN en admin.html.
// NOTA DE SEGURIDAD: 0.18.5 es la ultima en npm y tiene CVE conocidas (CVE-2023-30533 prototype pollution, CVE-2024-22363 ReDoS),
// corregidas en 0.19.3/0.20.2 (solo distribuidas por cdn.sheetjs.com, que el bundler de Supabase no permite importar).
// Mitigaciones: solo Lead Admin, limite 5 MB / 5000 filas, sin formulas, sin salida de red. Pendiente: vendorizar 0.20.3.
import XLSX from 'npm:xlsx@0.18.5';
import { analyze, decodeCsv, ImportError, LIMITS, parseCsv, type Existing, type RawSheet } from './parse.ts';
import { readWorkbook } from './xlsx_read.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (status: number, code: string, message: string) => json(status, { ok: false, error: code, message });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(405, 'metodo_no_permitido', 'Usa POST.');

  // 1) Autorizacion: Lead Admin con el JWT del usuario
  const auth = req.headers.get('Authorization') ?? '';
  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!auth.startsWith('Bearer ') || !url || !anon) return fail(401, 'no_autenticado', 'Sesión requerida.');
  const sb = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const adm = await sb.rpc('is_lead_admin');
  if (adm.error || adm.data !== true) return fail(403, 'no_autorizado', 'No tienes permiso para importar prospectos.');

  try {
    // 2) Limites de tamano (antes de leer el cuerpo)
    const cl = Number(req.headers.get('content-length') ?? '0');
    if (cl > LIMITS.maxBytes + 64 * 1024) return fail(413, 'archivo_grande', 'El archivo supera 5 MB.');
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return fail(400, 'sin_archivo', 'Adjunta un archivo en el campo "file".');
    if (file.size > LIMITS.maxBytes) return fail(413, 'archivo_grande', 'El archivo supera 5 MB.');
    const name = String(file.name || 'archivo');
    const ext = name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : name.toLowerCase().endsWith('.csv') ? 'csv' : null;
    if (!ext) return fail(400, 'extension_no_permitida', 'Solo se aceptan archivos .xlsx o .csv.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) return fail(400, 'archivo_vacio', 'El archivo está vacío.');
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (ext === 'xlsx' && !isZip) return fail(400, 'formato_invalido', 'El archivo no es un .xlsx válido.');
    if (ext === 'csv' && isZip) return fail(400, 'formato_invalido', 'El archivo .csv parece un Excel; guárdalo como .xlsx o CSV real.');

    // 3) Parsing determinista
    const sheets: RawSheet[] = ext === 'xlsx'
      ? readWorkbook(XLSX, bytes)
      : [{ name: 'CSV', rows: parseCsv(decodeCsv(bytes)) }];

    // 4) Prospectos existentes (solo 4 columnas) para duplicados; con RLS del usuario
    const existing: Existing[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      const r = await sb.from('digital_prospects').select('external_customer_id,phone_e164,full_name,clinic_name')
        .order('created_at', { ascending: true }).range(from, from + 999);
      if (r.error) return fail(500, 'error_base', 'No se pudo consultar la base para detectar duplicados.');
      existing.push(...(r.data as Existing[]));
      if ((r.data ?? []).length < 1000) break;
    }

    const a = analyze(sheets, existing);
    console.log(JSON.stringify({ evt: 'prospect_preview', ext, bytes: bytes.length, sheets: a.sheets.length, ...a.summary })); // solo contadores
    return json(200, {
      ok: true, import_performed: false,
      file: { name, ext, size: bytes.length },
      limits: { max_bytes: LIMITS.maxBytes, max_rows: LIMITS.maxRows, max_sheets: LIMITS.maxSheets },
      summary: a.summary, sheets: a.sheets,
      rows: a.rows.map(({ raw_payload: _omit, ...r }) => r), // raw_payload se reconstruye al confirmar (fase siguiente)
    });
  } catch (e) {
    if (e instanceof ImportError) return fail(422, e.code, e.message);
    console.log(JSON.stringify({ evt: 'prospect_preview_error', kind: (e as Error)?.name ?? 'error' })); // sin detalle (puede contener datos)
    return fail(500, 'error_interno', 'No se pudo analizar el archivo.');
  }
});
