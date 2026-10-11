// Lectura de libros XLSX -> hojas crudas. La libreria se INYECTA (en produccion: SheetJS 0.20.3 pinneada por URL).
// Solo VALORES de celda: no se evaluan formulas, no se leen macros, estilos ni HTML.
import { ImportError, LIMITS, type RawSheet } from './parse.ts';

// deno-lint-ignore no-explicit-any
export function readWorkbook(XLSX: any, bytes: Uint8Array): RawSheet[] {
  let wb;
  try {
    wb = XLSX.read(bytes, {
      type: 'array', cellFormula: false, cellHTML: false, cellNF: false, cellStyles: false, cellText: false,
      cellDates: true, bookVBA: false, bookProps: false, sheetRows: LIMITS.maxRows + LIMITS.headerScanRows + 2,
    });
  } catch (_e) {
    throw new ImportError('archivo_ilegible', 'No se pudo leer el archivo Excel (¿está dañado o protegido?).');
  }
  if (!wb || !Array.isArray(wb.SheetNames)) throw new ImportError('archivo_ilegible', 'Archivo Excel sin hojas.');
  if (wb.SheetNames.length > LIMITS.maxSheets) throw new ImportError('hojas_excedidas', 'El archivo tiene demasiadas hojas.');
  return wb.SheetNames.map((name: string): RawSheet => {
    const ws = wb.Sheets[name];
    const rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true }) : [];
    return { name, rows };
  });
}
