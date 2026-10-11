// prospect-import-preview -- OUTBOUND 2/3: analiza un Excel/CSV. mode=preview (defecto): devuelve el PREVIEW y NO inserta nada.
//   mode=confirm (Outbound 3): RE-ANALIZA el mismo archivo en servidor y llama a la RPC atomica confirm_prospect_import (V1: solo datos de prueba).
//
// Garantias:
//  - Solo Lead Admin (is_lead_admin() con el JWT del propio usuario). Sin service_role: la lectura de
//    digital_prospects para detectar duplicados usa la sesion del usuario (RLS).
//  - El archivo se procesa en memoria: no se guarda en Storage ni en la base.
//  - Parsing determinista (sin IA, sin servicios externos). No se evaluan formulas.
//  - Los logs contienen SOLO contadores/codigos; nunca nombres, telefonos, correos ni filas.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
// SheetJS 0.20.3 oficial, build MINI (solo XLSX; sin CSV) VENDORIZADO en ./vendor/xlsx.mini.mjs: contenido oficial + 1 linea `export { XLSX };`.
// Ver vendor/VENDOR.md (origen, transformacion y SHA-256). Sin descarga ni CDN en runtime. No usar npm:xlsx (0.18.5, vulnerable).
// El CSV NO pasa por SheetJS: lo procesa parseCsv/decodeCsv (parse.ts).
import { XLSX } from './vendor/xlsx.mini.mjs';
import { analyze, decodeCsv, ImportError, LIMITS, parseCsv, type Existing, type RawSheet } from './parse.ts';
import { readWorkbook } from './xlsx_read.ts';
import { buildConfirmArgs, mapRpcError, ModeError, resolveBatchMode, sha256Hex } from './confirm.ts';
import { analyzeEnrich, type Target } from './enrich.ts';
import { buildEnrichArgs, dupAckOk, mapEnrichRpcError } from './enrich_confirm.ts';

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
    const mode = String(form.get('mode') ?? 'preview');
    const isEnrich = mode === 'enrich_preview' || mode === 'enrich_confirm';
    if (mode !== 'preview' && mode !== 'confirm' && !isEnrich) return fail(400, 'modo_invalido', 'Modo no válido.');
    // Modo del lote (PRUEBA por defecto). Lo valida el SERVIDOR; REAL exige real_confirmed='yes' solo al confirmar.
    let batch: { isTest: boolean; realConfirmed: boolean };
    try { batch = isEnrich ? { isTest: false, realConfirmed: true } : resolveBatchMode(form.get('batch_mode'), mode === 'confirm' ? form.get('real_confirmed') : 'yes'); }
    catch (e) { if (e instanceof ModeError) return fail(400, e.code, e.msg); throw e; }
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

    // 3b) ENRIQUECIMIENTO (Outbound 5): solo prospectos REALES existentes; nunca crea; match por Sold-To exacto
    if (isEnrich) {
      const targets: Target[] = [];
      for (let from = 0; from < 100000; from += 1000) {
        const r = await sb.from('digital_prospects').select('id,external_customer_id,full_name,phone_raw,phone_e164,email')
          .eq('is_test', false).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
        if (r.error) return fail(500, 'error_base', 'No se pudo consultar la base.');
        targets.push(...(r.data as Target[]));
        if ((r.data ?? []).length < 1000) break;
      }
      const e = analyzeEnrich(sheets, targets);
      if (mode === 'enrich_confirm') {
        if (!dupAckOk(e, form.get('dup_ack'))) return fail(400, 'telefonos_duplicados_sin_reconocer', 'Hay teléfonos duplicados: confirma que los revisaste.');
        if (e.updates.length === 0) return fail(422, 'nada_que_actualizar', 'No hay datos para completar.');
        const args = buildEnrichArgs(e, { name, size: bytes.length, sha256: await sha256Hex(bytes) });
        const r = await sb.rpc('confirm_prospect_enrichment', args);
        if (r.error) {
          const m = mapEnrichRpcError(r.error.code, r.error.message);
          console.log(JSON.stringify({ evt: 'prospect_enrich_error', code: m.code, pg: r.error.code ?? null })); // sin detalle
          return fail(m.status, m.code, m.message);
        }
        console.log(JSON.stringify({ evt: 'prospect_enrich', ...(r.data as Record<string, unknown>) })); // solo contadores
        return json(200, { ok: true, enrichment_performed: true, ...(r.data as Record<string, unknown>) });
      }
      console.log(JSON.stringify({ evt: 'prospect_enrich_preview', ext, bytes: bytes.length, ...e.summary })); // solo contadores
      return json(200, { ok: true, enrichment_performed: false, file: { name, ext, size: bytes.length }, summary: e.summary, sheets: e.sheets, rows: e.rows });
    }

    // 4) Prospectos existentes (solo 4 columnas) para duplicados; con RLS del usuario
    const existing: Existing[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      // Duplicados SOLO dentro del mismo modo: los prospectos de prueba no bloquean un lote real (ni al reves).
      const r = await sb.from('digital_prospects').select('external_customer_id,phone_e164,full_name,clinic_name')
        .eq('is_test', batch.isTest).order('created_at', { ascending: true }).range(from, from + 999);
      if (r.error) return fail(500, 'error_base', 'No se pudo consultar la base para detectar duplicados.');
      existing.push(...(r.data as Existing[]));
      if ((r.data ?? []).length < 1000) break;
    }

    const a = analyze(sheets, existing);

    // 5) CONFIRMAR: se usa el analisis recalculado AQUI (nunca el del frontend). RPC atomica con el JWT del usuario.
    if (mode === 'confirm') {
      const args = buildConfirmArgs(a, { name, size: bytes.length, sha256: await sha256Hex(bytes) }, batch);
      const r = await sb.rpc('confirm_prospect_import', args);
      if (r.error) {
        const m = mapRpcError(r.error.code, r.error.message);
        console.log(JSON.stringify({ evt: 'prospect_confirm_error', code: m.code, pg: r.error.code ?? null })); // sin detalle
        return fail(m.status, m.code, m.message);
      }
      const out = r.data as { import_id: string; total: number; imported: number; duplicates_omitted: number; invalid: number };
      console.log(JSON.stringify({ evt: 'prospect_confirm', mode: batch.isTest ? 'test' : 'real', total: out.total, imported: out.imported, duplicates_omitted: out.duplicates_omitted, invalid: out.invalid }));
      return json(200, { ok: true, import_performed: true, batch_mode: batch.isTest ? 'test' : 'real', ...out });
    }
    console.log(JSON.stringify({ evt: 'prospect_preview', ext, bytes: bytes.length, sheets: a.sheets.length, ...a.summary })); // solo contadores
    return json(200, {
      ok: true, import_performed: false, batch_mode: batch.isTest ? 'test' : 'real',
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
