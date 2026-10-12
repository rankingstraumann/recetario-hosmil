// Pruebas del analisis (parse.ts + xlsx_read.ts). Ejecutar: ./run-tests.sh   (Node >= 22, --experimental-strip-types)
// La libreria XLSX se inyecta: aqui y en produccion es SheetJS 0.20.3 (vendor/xlsx.mini.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, decodeCsv, parseCsv, normExternalId, normYear, normTrade, normPhone, ImportError, LIMITS } from '../parse.ts';
import { readWorkbook } from '../xlsx_read.ts';

const here = dirname(fileURLToPath(import.meta.url));
import { XLSX } from '../vendor/xlsx.mini.mjs';
const xlsxBytes = new Uint8Array(readFileSync(join(here, 'fixtures/trade_up_ficticio.xlsx')));
const csvBytes = new Uint8Array(readFileSync(join(here, 'fixtures/telefonos_ficticio.csv')));

const A = analyze(readWorkbook(XLSX, xlsxBytes));
const byRow = (a, sheet, row) => a.rows.find((r) => r.sheet === sheet && r.row === row);
const codes = (r) => r.problems.map((p) => p.code);

test('XLSX multi-hoja: se leen las hojas y se detecta el encabezado tras la fila de titulo', () => {
  assert.deepEqual(A.sheets.map((s) => s.name), ['Hoja A', 'Hoja B', 'Hoja vacía', 'Sin encabezados']);
  assert.equal(A.sheets[0].header_row, 2);
});
test('fila valida: mapeo completo y tipos', () => {
  const r = byRow(A, 'Hoja A', 3);
  assert.equal(r.status, 'VALIDO');
  assert.equal(r.external_customer_id, '1000000001');
  assert.equal(typeof r.external_customer_id, 'string');
  assert.equal(r.clinic_name, 'Clínica Ficticia Uno'); assert.equal(r.full_name, 'Persona Prueba Uno');
  assert.equal(r.source_owner, 'Cartera Ficticia A'); assert.equal(r.priority_source, 'Alta');
  assert.equal(r.last_billed_year, 2025); assert.equal(r.trade_up_financial, true);
  assert.equal(r.notes, 'Nota uno'); assert.equal(r.phone_e164, null);
});
test('Contacto vacio: NO se inventa nombre de persona; trade up vacio -> null', () => {
  const r = byRow(A, 'Hoja A', 4);
  assert.equal(r.full_name, null); assert.equal(r.clinic_name, 'Clínica Ficticia Dos'); assert.equal(r.trade_up_financial, null);
  assert.equal(r.status, 'VALIDO');
});
test('raw_payload conserva TODAS las columnas originales (incl. Uso VV, Interés, Fecha como ISO)', () => {
  const r = byRow(A, 'Hoja A', 3);
  assert.equal(r.raw_payload['Uso VV'], 'Sí'); assert.equal(r.raw_payload['Interés'], 'Alto');
  assert.equal(r.raw_payload['Fecha'], '2026-09-30'); assert.equal(r.raw_payload['Sold-To'], 1000000001);
  assert.equal(r.raw_payload._hoja, 'Hoja A'); assert.equal(r.raw_payload._fila, 3);
});
test('encabezado repetido dentro de la hoja: se detecta y se excluye', () => {
  assert.equal(A.sheets[0].repeated_headers, 1);
  assert.equal(byRow(A, 'Hoja A', 5), undefined);
  assert.equal(A.summary.encabezados_repetidos, 1);
});
test('Sold-To decimal anomalo -> INVALIDO', () => {
  const r = byRow(A, 'Hoja A', 6);
  assert.equal(r.status, 'INVALIDO'); assert.ok(codes(r).includes('SOLD_TO_INVALIDO')); assert.equal(r.external_customer_id, null);
});
test('anio decimal o fuera de rango -> INVALIDO', () => {
  assert.ok(codes(byRow(A, 'Hoja A', 7)).includes('ANIO_INVALIDO'));
  assert.ok(codes(byRow(A, 'Hoja A', 8)).includes('ANIO_INVALIDO'));
  assert.equal(byRow(A, 'Hoja A', 8).status, 'INVALIDO');
});
test('Trade Up ambiguo (X): null + advertencia, no se inventa', () => {
  const r = byRow(A, 'Hoja A', 8);
  assert.equal(r.trade_up_financial, null); assert.ok(codes(r).includes('TRADE_UP_AMBIGUO'));
});
test('duplicado externo dentro del archivo: la primera queda, la siguiente es DUPLICADO', () => {
  assert.equal(byRow(A, 'Hoja A', 3).status, 'VALIDO');
  const d = byRow(A, 'Hoja A', 9);
  assert.equal(d.status, 'DUPLICADO'); assert.ok(codes(d).includes('SOLD_TO_DUP_ARCHIVO'));
  assert.match(d.problems.find((p) => p.code === 'SOLD_TO_DUP_ARCHIVO').msg, /fila 3/);
});
test('nombre repetido: solo ADVERTENCIA en ambas filas (no se fusiona)', () => {
  for (const n of [10, 11]) { const r = byRow(A, 'Hoja A', n); assert.equal(r.status, 'ADVERTENCIA'); assert.ok(codes(r).includes('NOMBRE_DUP_ARCHIVO')); }
  assert.equal(A.summary.adv_nombre, 2);
});
test('fila vacia se omite; fila sin identificacion -> INVALIDO', () => {
  assert.equal(A.sheets[0].empty_rows_skipped, 1);
  assert.ok(codes(byRow(A, 'Hoja A', 13)).includes('SIN_IDENTIFICACION'));
});
test('Sold-To como TEXTO conserva ceros iniciales', () => {
  const r = byRow(A, 'Hoja B', 2);
  assert.equal(r.external_customer_id, '0001234567'); assert.equal(r.last_billed_year, 2024); assert.equal(r.trade_up_financial, true);
});
test('formulas Excel NO se evaluan (solo valores)', () => {
  const r = byRow(A, 'Hoja B', 3);
  assert.equal(r.external_customer_id, null); assert.equal(r.last_billed_year, null);
  assert.ok(codes(r).includes('SIN_SOLD_TO'));
});
test('hoja vacia y hoja sin encabezados reconocibles se informan y se omiten', () => {
  assert.equal(A.sheets[2].note, 'Hoja vacía'); assert.match(A.sheets[3].note, /Sin encabezados/);
  assert.equal(A.summary.hojas_vacias, 1);
  assert.equal(A.rows.filter((r) => r.sheet === 'Sin encabezados').length, 0);
});
test('duplicado CONTRA BD (Sold-To) = DUPLICADO; telefono/nombre contra BD = ADVERTENCIA', () => {
  const ex = [{ external_customer_id: '1000000002', phone_e164: null, full_name: null, clinic_name: null },
              { external_customer_id: null, phone_e164: null, full_name: 'persona prueba ocho', clinic_name: null }];
  const a = analyze(readWorkbook(XLSX, xlsxBytes), ex);
  assert.equal(byRow(a, 'Hoja A', 4).status, 'DUPLICADO'); assert.ok(codes(byRow(a, 'Hoja A', 4)).includes('SOLD_TO_DUP_BD'));
  assert.ok(codes(byRow(a, 'Hoja B', 2)).includes('NOMBRE_DUP_BD')); assert.equal(byRow(a, 'Hoja B', 2).status, 'ADVERTENCIA');
});
test('resumen XLSX consistente', () => {
  const s = A.summary;
  assert.equal(s.total, A.rows.length);
  assert.equal(s.validas + s.invalidas, s.total);
  assert.equal(s.invalidas, 4);       // Sold-To decimal, anio decimal, anio rango, sin identificacion
  assert.equal(s.duplicado_fuerte, 1);
  assert.equal(s.sin_consentimiento, s.total);
  assert.equal(s.sin_telefono, s.total);
  assert.equal(s.listas_para_importar, s.total - s.invalidas - s.duplicado_fuerte);
});

// ---------------- CSV ----------------
const C = analyze([{ name: 'CSV', rows: parseCsv(decodeCsv(csvBytes)) }], [{ external_customer_id: null, phone_e164: '+56990000009', full_name: null, clinic_name: null }]);
test('CSV ; con BOM, acentos, comillas y salto de linea dentro de celda', () => {
  assert.equal(C.rows.length, 6);
  assert.equal(C.rows[0].clinic_name, 'Clínica Csv Uno'); assert.equal(C.rows[0].notes, 'Nota; con punto y coma');
  assert.equal(C.rows[5].notes, 'Línea 1 Línea 2');
});
test('telefonos: normalizacion E.164 y no normalizable', () => {
  assert.equal(C.rows[0].phone_e164, '+56990000001'); assert.equal(C.rows[1].phone_e164, '+56990000001');
  assert.equal(C.rows[3].phone_e164, '+56990000004');
  assert.equal(C.rows[2].phone_e164, null); assert.ok(codes(C.rows[2]).includes('TEL_NO_NORMALIZABLE'));
  assert.ok(codes(C.rows[2]).includes('EMAIL_INVALIDO')); assert.equal(C.rows[2].email, null);
});
test('telefono repetido en archivo y contra BD: ADVERTENCIA, nunca fusion', () => {
  assert.ok(codes(C.rows[0]).includes('TEL_DUP_ARCHIVO') && codes(C.rows[1]).includes('TEL_DUP_ARCHIVO'));
  assert.ok(codes(C.rows[4]).includes('TEL_DUP_BD'));
  assert.equal(C.rows[0].status, 'ADVERTENCIA'); assert.equal(C.rows.length, 6);
  assert.equal(C.summary.adv_telefono, 3);
  assert.equal(C.summary.sin_telefono, 2);
});
test('CSV en windows-1252 (no UTF-8) se decodifica', () => {
  const bytes = new Uint8Array([...'Cliente;Sold-To\nCl'].map((c) => c.charCodeAt(0)).concat([0xed], [...'nica;123'].map((c) => c.charCodeAt(0))));
  const rows = parseCsv(decodeCsv(bytes));
  assert.equal(rows[1][0], 'Clínica');
});

// ---------------- Normalizadores y limites ----------------
test('normExternalId', () => {
  assert.deepEqual(normExternalId(47505090), { value: '47505090', invalid: false });
  assert.equal(normExternalId(47505090.666).invalid, true);
  assert.equal(normExternalId('47505090.0').invalid, true);
  assert.equal(normExternalId('4.75E+7').invalid, true);
  assert.equal(normExternalId('00012').value, '00012');
  assert.deepEqual(normExternalId(''), { value: null, invalid: false });
});
test('normYear / normTrade / normPhone', () => {
  assert.equal(normYear(2026).value, 2026); assert.equal(normYear('2026').value, 2026); assert.equal(normYear(2026.5).invalid, true);
  assert.equal(normYear(1989).invalid, true); assert.equal(normYear('20x6').invalid, true);
  for (const v of ['O', 'o', 'SI', 'SÍ', 'TRUE', 1, '1']) assert.equal(normTrade(v).value, true, String(v));
  for (const v of ['NO', 'FALSE', 0, '0']) assert.equal(normTrade(v).value, false, String(v));
  assert.deepEqual(normTrade(''), { value: null, ambiguous: false });
  assert.deepEqual(normTrade('Quizás'), { value: null, ambiguous: true });
  assert.equal(normPhone('9 8765 4321').e164, '+56987654321'); assert.equal(normPhone('+1 415 555 2671').e164, '+14155552671');
  assert.equal(normPhone('12345').e164, null); assert.equal(normPhone('').raw, null);
});
test('limite de filas y de hojas', () => {
  const rows = [['Sold-To', 'Cliente']]; for (let i = 0; i < LIMITS.maxRows + 1; i++) rows.push([String(i + 1), 'C' + i + ' prueba']);
  assert.throws(() => analyze([{ name: 'X', rows }]), (e) => e instanceof ImportError && e.code === 'filas_excedidas');
  const many = Array.from({ length: LIMITS.maxSheets + 1 }, (_, i) => ({ name: 'S' + i, rows: [] }));
  assert.throws(() => analyze(many), (e) => e.code === 'hojas_excedidas');
});
test('archivo XLSX corrupto -> ImportError archivo_ilegible', () => {
  assert.throws(() => readWorkbook(XLSX, new Uint8Array([0x50, 0x4b, 1, 2, 3, 4])), (e) => e instanceof ImportError);
});
test('el analisis es determinista', () => {
  const b = analyze(readWorkbook(XLSX, xlsxBytes));
  assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(A)));
});
