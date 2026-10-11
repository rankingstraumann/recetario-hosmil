// Genera fixtures 100% FICTICIOS (sin clientes reales). Usa SheetJS 0.20.3 vendorizada (../vendor/xlsx.mini.mjs). Uso: node make-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XLSX } from '../vendor/xlsx.mini.mjs';
import * as fs from 'node:fs';
XLSX.set_fs(fs);
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'); mkdirSync(dir, { recursive: true });

const H = ['Sold-To', 'Cliente', 'Prioridad', 'Último año facturado', 'Cartera original', 'Trade Up financiero', 'Contacto', 'Uso VV', 'Interés', 'Próxima acción', 'Fecha', 'Observación'];
const hojaA = [
  ['Base ficticia — Trade Up pendientes (PRUEBA)'],                     // fila de título previa al encabezado
  H,
  [1000000001, 'Clínica Ficticia Uno', 'Alta', 2025, 'Cartera Ficticia A', 'O', 'Persona Prueba Uno', 'Sí', 'Alto', 'Llamar', new Date(Date.UTC(2026, 8, 30)), 'Nota uno'],   // VALIDA
  [1000000002, 'Clínica Ficticia Dos', 'Media', 2024, 'Cartera Ficticia B', '', '', 'No', '', '', null, ''],                                                                   // VALIDA, sin contacto, trade vacio
  H,                                                                                                                                                                           // ENCABEZADO REPETIDO
  [47505090.666666664, 'Clínica Ficticia Tres', 'Baja', 2023, 'Cartera Ficticia A', 'NO', 'Persona Prueba Tres', '', '', '', null, ''],                                          // Sold-To DECIMAL -> invalido
  [1000000004, 'Clínica Ficticia Cuatro', 'Alta', 2025.5, 'Cartera Ficticia C', 'SI', 'Persona Prueba Cuatro', '', '', '', null, ''],                                           // ANIO decimal -> invalido
  [1000000005, 'Clínica Ficticia Cinco', 'Alta', 1985, 'Cartera Ficticia C', 'X', '', '', '', '', null, ''],                                                                    // ANIO fuera de rango -> invalido
  [1000000001, 'Clínica Ficticia Uno (sucursal)', 'Alta', 2025, 'Cartera Ficticia A', 'O', 'Persona Prueba Uno B', '', '', '', null, ''],                                       // DUPLICADO externo en archivo
  [1000000006, 'Clínica Repetida', 'Media', 2022, 'Cartera Ficticia B', 'TRUE', '', '', '', '', null, ''],                                                                       // nombre repetido (1/2)
  [1000000007, 'Clínica Repetida', 'Media', 2022, 'Cartera Ficticia B', '0', '', '', '', '', null, ''],                                                                          // nombre repetido (2/2)
  [null, null, null, null, null, null, null, null, null, null, null, null],                                                                                                     // fila vacia
  [null, null, null, null, 'Cartera huérfana', null, null, null, null, null, null, null],                                                                                        // sin identificacion -> invalido
];
const hojaB = [
  H,
  ['0001234567', 'Clínica Ficticia Ocho', 'Alta', '2024', 'Cartera Ficticia D', 'si', 'Persona Prueba Ocho', '', '', '', null, 'Cero inicial'], // texto con ceros iniciales
  [{ t: 'n', f: '2020+5' }, 'Clínica Ficticia Nueve', '', { t: 'n', f: '2020+5' }, '', '', '', '', '', '', null, 'formulas sin valor cacheado'],                       // formulas: NO se evaluan
];
function sheetFrom(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(c => (c && c.f) ? null : c)), { cellDates: true });
  // inyecta celdas con formula SIN valor cacheado
  rows.forEach((r, ri) => r.forEach((c, ci) => { if (c && c.f) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 'n', f: c.f }; }));
  return ws;
}
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheetFrom(hojaA), 'Hoja A');
XLSX.utils.book_append_sheet(wb, sheetFrom(hojaB), 'Hoja B');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Hoja vacía');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['cosa', 'otra'], ['x', 'y']]), 'Sin encabezados');
XLSX.writeFile(wb, join(dir, 'trade_up_ficticio.xlsx'), { cellDates: true });

// CSV con ';', BOM UTF-8, acentos, comillas, y columnas de telefono/correo
const csv = '﻿' + [
  'Sold-To;Cliente;Contacto;Teléfono;Correo;Observación',
  '2000000001;Clínica Csv Uno;Persona Csv Uno;+56 9 9000 0001;uno@ejemplo.test;"Nota; con punto y coma"',
  '2000000002;Clínica Csv Dos;Persona Csv Dos;9 9000 0001;dos@ejemplo.test;Teléfono repetido del anterior',
  '2000000003;Clínica Csv Tres;;22 2345 678;malcorreo;Fijo y correo inválido',
  '2000000004;Clínica Csv Cuatro;Persona Csv Cuatro;56990000004;;Formato 56…',
  '2000000005;Clínica Csv Cinco;Persona Existente;+56990000009;;Coincide con BD (teléfono)',
  '2000000006;Clínica Csv Seis;;;;"Línea 1\nLínea 2"',
].join('\r\n');
writeFileSync(join(dir, 'telefonos_ficticio.csv'), csv, 'utf8');
console.log('fixtures generados en', dir);
