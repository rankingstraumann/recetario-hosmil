// Confirmacion de importacion (Outbound 3). Modulo PURO (testeable en Node): arma los argumentos de la RPC
// public.confirm_prospect_import a partir de un Analysis recalculado en servidor. No toca red ni base.
import type { Analysis, ParsedRow } from './parse.ts';

export const IMPORTABLE: ReadonlyArray<ParsedRow['status']> = ['VALIDO', 'ADVERTENCIA'];

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ConfirmArgs = {
  p_filename: string; p_sha256: string; p_size: number;
  p_total: number; p_invalid: number; p_duplicates: number;
  p_rows: Array<Record<string, unknown>>;
  p_is_test: boolean; p_real_confirmed: boolean;
};

export class ModeError extends Error {
  code: string; msg: string;
  constructor(code: string, msg: string) { super(code); this.code = code; this.msg = msg; }
}

/** El SERVIDOR decide is_test. Defecto = PRUEBA. REAL exige confirmacion explicita (campo real_confirmed='yes'). */
export function resolveBatchMode(batchMode: unknown, realConfirmed: unknown): { isTest: boolean; realConfirmed: boolean } {
  const m = batchMode == null || batchMode === '' ? 'test' : String(batchMode);
  if (m === 'test') return { isTest: true, realConfirmed: false };
  if (m === 'real') {
    if (String(realConfirmed ?? '') !== 'yes') throw new ModeError('confirmacion_real_requerida', 'Importar en modo REAL exige la segunda confirmación explícita.');
    return { isTest: false, realConfirmed: true };
  }
  throw new ModeError('modo_lote_invalido', 'Modo de lote no válido (usa PRUEBA o REAL).');
}

/** Solo filas VALIDO/ADVERTENCIA. consentimiento y outreach_status NO viajan (los fija la RPC); is_test lo fija el servidor segun el modo validado. */
export function buildConfirmArgs(a: Analysis, file: { name: string; size: number; sha256: string }, mode: { isTest: boolean; realConfirmed: boolean } = { isTest: true, realConfirmed: false }): ConfirmArgs {
  const rows = a.rows.filter((r) => IMPORTABLE.includes(r.status));
  const invalid = a.rows.filter((r) => r.status === 'INVALIDO').length;
  const dups = a.rows.filter((r) => r.status === 'DUPLICADO').length;
  if (rows.length + invalid + dups !== a.rows.length) throw new Error('conteos_inconsistentes');
  if (rows.length !== a.summary.listas_para_importar || invalid !== a.summary.invalidas || dups !== a.summary.duplicado_fuerte) {
    throw new Error('conteos_inconsistentes');
  }
  return {
    p_filename: file.name, p_sha256: file.sha256, p_size: file.size,
    p_total: a.rows.length, p_invalid: invalid, p_duplicates: dups,
    p_is_test: mode.isTest, p_real_confirmed: mode.realConfirmed,
    p_rows: rows.map((r) => ({
      sheet: r.sheet, row: r.row,
      external_customer_id: r.external_customer_id, full_name: r.full_name, clinic_name: r.clinic_name,
      source_owner: r.source_owner, priority_source: r.priority_source, last_billed_year: r.last_billed_year,
      trade_up_financial: r.trade_up_financial, phone_raw: r.phone_raw, phone_e164: r.phone_e164,
      email: r.email, notes: r.notes, raw_payload: r.raw_payload,
    })),
  };
}

/** Traduce el error de la RPC a una respuesta HTTP sin filtrar detalle de la base. */
export function mapRpcError(code: string | undefined, message: string | undefined): { status: number; code: string; message: string } {
  const m = message ?? '';
  if (m.includes('IMPORT_YA_CONFIRMADO')) return { status: 409, code: 'ya_importado', message: 'Este archivo ya fue importado; no se importó nada nuevo.' };
  if (m.includes('CONFIRMACION_REAL_REQUERIDA')) return { status: 400, code: 'confirmacion_real_requerida', message: 'Importar en modo REAL exige la segunda confirmación explícita.' };
  if (m.includes('NO_AUTORIZADO') || code === '42501') return { status: 403, code: 'no_autorizado', message: 'No tienes permiso para importar prospectos.' };
  if (m.includes('CONTEOS_INCONSISTENTES') || m.includes('FILA_INVALIDA') || m.includes('PARAMETROS_INVALIDOS') || m.includes('LOTE_EXCEDIDO')) {
    return { status: 422, code: 'lote_rechazado', message: 'El lote fue rechazado por validaciones del servidor. No se importó nada.' };
  }
  return { status: 500, code: 'error_importacion', message: 'No se pudo completar la importación. No se importó nada.' };
}
