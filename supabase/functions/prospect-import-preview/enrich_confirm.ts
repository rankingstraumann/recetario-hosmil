// OUTBOUND 5 -- argumentos y errores de la RPC confirm_prospect_enrichment. Modulo puro.
import type { EnrichAnalysis, EnrichUpdate } from './enrich.ts';

export type EnrichArgs = { p_filename: string; p_sha256: string; p_size: number; p_total: number; p_matched: number; p_updates: EnrichUpdate[] };

export function buildEnrichArgs(a: EnrichAnalysis, file: { name: string; size: number; sha256: string }): EnrichArgs {
  return {
    p_filename: file.name.slice(0, 200), p_sha256: file.sha256, p_size: file.size,
    p_total: a.summary.filas_archivo, p_matched: a.summary.match_exacto,
    p_updates: a.updates, // solo filas ACTUALIZA con campos a completar; el Sold-To viaja para verificacion cruzada en la RPC
  };
}
// Telefonos duplicados: la confirmacion exige reconocimiento explicito (dup_ack='yes'). Devuelve true si se puede continuar.
export function dupAckOk(a: EnrichAnalysis, ack: unknown): boolean {
  return a.summary.telefonos_duplicados === 0 || ack === 'yes';
}
export function mapEnrichRpcError(code: string | undefined, message: string | undefined): { status: number; code: string; message: string } {
  const m = message ?? '';
  if (m.includes('ENRIQUECIMIENTO_YA_APLICADO')) return { status: 409, code: 'ya_aplicado', message: 'Este archivo ya fue aplicado; no se actualizó nada.' };
  if (m.includes('NO_AUTORIZADO') || code === '42501') return { status: 403, code: 'no_autorizado', message: 'No tienes permiso para enriquecer prospectos.' };
  if (m.includes('PROSPECTO_NO_VALIDO')) return { status: 409, code: 'prospecto_cambio', message: 'Un prospecto cambió o ya no es válido desde el preview. No se actualizó nada; vuelve a analizar el archivo.' };
  if (m.includes('CONTEOS_INCONSISTENTES') || m.includes('FILA_INVALIDA') || m.includes('PARAMETROS_INVALIDOS') || m.includes('LOTE_EXCEDIDO'))
    return { status: 422, code: 'lote_rechazado', message: 'El lote fue rechazado por validaciones del servidor. No se actualizó nada.' };
  return { status: 500, code: 'error_enriquecimiento', message: 'No se pudo completar el enriquecimiento. No se actualizó nada.' };
}
