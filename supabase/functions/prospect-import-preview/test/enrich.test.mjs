// OUTBOUND 5: pruebas del enriquecimiento (enrich.ts / enrich_confirm.ts) con el archivo y los prospectos FICTICIOS. Sin red ni base.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XLSX } from '../vendor/xlsx.mini.mjs';
import { ImportError, decodeCsv, parseCsv } from '../parse.ts';
import { readWorkbook } from '../xlsx_read.ts';
import { analyzeEnrich } from '../enrich.ts';
import { buildEnrichArgs, dupAckOk, mapEnrichRpcError } from '../enrich_confirm.ts';
import { sha256Hex } from '../confirm.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = new Uint8Array(readFileSync(join(here, 'fixtures/enriquecimiento_ficticio.xlsx')));
const T = (n, sold, o = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, external_customer_id: sold, full_name: null, phone_raw: null, phone_e164: null, email: null, ...o });
const TARGETS = [
  T(1, '1000000001'), T(2, '1000000002', { full_name: 'Nombre Previo', phone_raw: '9 2222 2222', phone_e164: '+56922222222' }),
  T(3, '1000000003'), T(4, '1000000004'), T(5, '1000000005'), T(6, '0001234567'),
  T(7, '1000000010'), T(8, '1000000010'), T(9, '1000000009', { phone_raw: '9 7777 7777', phone_e164: '+56977777777' }),
];
const A = analyzeEnrich(readWorkbook(XLSX, bytes), TARGETS);
const by = (sold, i = 0) => A.rows.filter((r) => r.external_customer_id === sold)[i];

test('preview: conteos exactos', () => {
  const s = A.summary;
  assert.deepEqual(s, {
    filas_archivo: 14, match_exacto: 7, sin_match: 2, invalidas: 2, duplicadas_archivo: 2, match_multiple: 1,
    con_movil_valido: 7, sin_movil: 5, telefonos_duplicados: 2, filas_con_telefono_duplicado: 3,
    contactos_a_completar: 4, telefonos_a_completar: 4, emails_a_completar: 2,
    conflictos: 1, filas_a_actualizar: 5, sin_cambios: 2,
  });
  assert.equal(s.match_exacto + s.sin_match + s.invalidas + s.duplicadas_archivo + s.match_multiple, s.filas_archivo); // cierra
  assert.equal(s.filas_a_actualizar + s.sin_cambios, s.match_exacto);
  assert.equal(A.rows.length, s.filas_archivo);
});
test('hoja sin encabezado se informa; el encabezado repetido y la fila vacia no cuentan', () => {
  assert.equal(A.sheets.length, 2);
  assert.equal(A.sheets[0].header_row, 2); assert.equal(A.sheets[0].data_rows, 14);
  assert.equal(A.sheets[1].header_row, null);
});
test('match SOLO por Sold-To exacto: numero 1234567 NO calza con texto 0001234567', () => {
  assert.equal(by('1234567').status, 'SIN_MATCH');
  assert.equal(by('0001234567').status, 'ACTUALIZA');
  assert.equal(A.updates.find((u) => u.external_customer_id === '0001234567').id, TARGETS[5].id);
});
test('nunca crea: SIN_MATCH no genera update; solo hay updates para ids de la base', () => {
  assert.equal(by('9999999999').status, 'SIN_MATCH');
  const ids = new Set(TARGETS.map((t) => t.id));
  assert.ok(A.updates.length > 0);
  A.updates.forEach((u) => assert.ok(ids.has(u.id)));
  assert.ok(!A.updates.some((u) => u.external_customer_id === '9999999999'));
});
test('fila 1: completa nombre + movil + email (email en minusculas), E.164 correcto', () => {
  const r = by('1000000001'), u = A.updates.find((x) => x.external_customer_id === '1000000001');
  assert.equal(r.status, 'ACTUALIZA'); assert.deepEqual(r.fills.sort(), ['email', 'full_name', 'phone']);
  assert.deepEqual(u, { id: TARGETS[0].id, external_customer_id: '1000000001', full_name: 'Persona Uno', phone_raw: '9 1111 1111', phone_e164: '+56911111111', email: 'uno@ejemplo.test' });
});
test('NO sobrescribe: dato existente distinto = conflicto; solo se completa lo vacio', () => {
  const r = by('1000000002'), u = A.updates.find((x) => x.external_customer_id === '1000000002');
  assert.deepEqual(r.fills, ['email']); assert.deepEqual(r.conflicts.sort(), ['full_name', 'phone']);
  assert.deepEqual(u, { id: TARGETS[1].id, external_customer_id: '1000000002', email: 'dos@ejemplo.test' });
  assert.ok(!('full_name' in u) && !('phone_e164' in u));
});
test('valor vacio del archivo jamas pisa ni genera campo', () => {
  const r = by('1000000009'); assert.equal(r.status, 'SIN_CAMBIOS');
  assert.ok(!A.updates.some((u) => u.external_customer_id === '1000000009'));
});
test('telefono fijo / correo invalido: advertencias, no se escriben, no cuenta como movil', () => {
  const r = by('1000000003');
  assert.equal(r.status, 'SIN_CAMBIOS'); assert.equal(r.has_mobile, false);
  assert.deepEqual(r.warnings.sort(), ['email_invalido', 'telefono_no_movil_valido']);
});
test('telefonos duplicados: dentro del archivo y contra otro prospecto de la base', () => {
  assert.equal(by('1000000001').phone_dup, true); assert.equal(by('1000000004').phone_dup, true); // mismo movil en 2 Sold-To
  assert.equal(by('1000000005').phone_dup, true);                                                    // ya lo tiene el prospecto 1000000009
  assert.ok(by('1000000005').warnings.includes('telefono_duplicado'));
  assert.equal(by('1000000002').phone_dup, false);
});
test('Sold-To repetido en archivo: ambas filas excluidas; repetido en base: MATCH_MULTIPLE excluido', () => {
  assert.deepEqual([0, 1].map((i) => by('1000000008', i).status), ['DUPLICADO_ARCHIVO', 'DUPLICADO_ARCHIVO']);
  assert.equal(by('1000000010').status, 'MATCH_MULTIPLE');
  assert.ok(!A.updates.some((u) => ['1000000008', '1000000010'].includes(u.external_customer_id)));
});
test('Sold-To vacio o decimal: INVALIDO sin update', () => {
  const inv = A.rows.filter((r) => r.status === 'INVALIDO');
  assert.equal(inv.length, 2);
  assert.deepEqual(inv.map((r) => r.warnings[0]).sort(), ['sin_sold_to', 'sold_to_invalido']);
});
test('updates solo traen claves permitidas (jamas consentimiento ni estado)', () => {
  const ok = new Set(['id', 'external_customer_id', 'full_name', 'phone_raw', 'phone_e164', 'email']);
  A.updates.forEach((u) => { Object.keys(u).forEach((k) => assert.ok(ok.has(k), k)); assert.equal('phone_raw' in u, 'phone_e164' in u); });
  assert.ok(!JSON.stringify(A.updates).match(/consent|outreach|whatsapp/i));
});
test('el preview (filas) no expone nombres, telefonos ni correos', () => {
  const blob = JSON.stringify(A.rows);
  assert.ok(!/Persona|ejemplo\.test|\+569|9 1111/.test(blob));
});
test('re-analisis tras aplicar: idempotente (nada que completar)', () => {
  const applied = TARGETS.map((t) => {
    const u = A.updates.find((x) => x.id === t.id); if (!u) return t;
    return { ...t, full_name: t.full_name ?? u.full_name ?? null, phone_raw: t.phone_raw ?? u.phone_raw ?? null, phone_e164: t.phone_e164 ?? u.phone_e164 ?? null, email: t.email ?? u.email ?? null };
  });
  const B = analyzeEnrich(readWorkbook(XLSX, bytes), applied);
  assert.equal(B.updates.length, 0); assert.equal(B.summary.filas_a_actualizar, 0);
});
test('archivo sin encabezado Sold-To + (contacto|telefono|email) => error claro', () => {
  assert.throws(() => analyzeEnrich([{ name: 'x', rows: [['Sold-To', 'Cliente'], ['1', 'a']] }], TARGETS), (e) => e instanceof ImportError && e.code === 'sin_encabezado');
  assert.throws(() => analyzeEnrich([{ name: 'x', rows: [['Contacto', 'Telefono']] }], TARGETS), (e) => e instanceof ImportError);
});
test('CSV con ; y BOM funciona igual', () => {
  const csv = '﻿Sold-To;Nombre;Celular;Correo\r\n1000000001;Persona Csv;56911112222;CSV@Ejemplo.test\r\n';
  const C = analyzeEnrich([{ name: 'CSV', rows: parseCsv(decodeCsv(new TextEncoder().encode(csv))) }], TARGETS);
  assert.equal(C.updates.length, 1); assert.equal(C.updates[0].phone_e164, '+56911112222'); assert.equal(C.updates[0].email, 'csv@ejemplo.test');
});
test('buildEnrichArgs: conteos y updates; hash 64 hex', async () => {
  const sha = await sha256Hex(bytes);
  const args = buildEnrichArgs(A, { name: 'enriquecimiento_ficticio.xlsx', size: bytes.length, sha256: sha });
  assert.match(args.p_sha256, /^[0-9a-f]{64}$/);
  assert.equal(args.p_total, 14); assert.equal(args.p_matched, 7); assert.equal(args.p_updates.length, 5);
  assert.ok(args.p_updates.length <= args.p_matched && args.p_matched <= args.p_total);
});
test('telefonos duplicados exigen reconocimiento explicito (dup_ack=yes)', () => {
  assert.equal(dupAckOk(A, null), false); assert.equal(dupAckOk(A, 'no'), false); assert.equal(dupAckOk(A, 'yes'), true);
  assert.equal(dupAckOk({ summary: { telefonos_duplicados: 0 } }, null), true);
});
test('mapEnrichRpcError: codigos y mensajes sin datos', () => {
  assert.equal(mapEnrichRpcError(undefined, 'ENRIQUECIMIENTO_YA_APLICADO').status, 409);
  assert.equal(mapEnrichRpcError('42501', 'x').status, 403);
  assert.equal(mapEnrichRpcError(undefined, 'PROSPECTO_NO_VALIDO').code, 'prospecto_cambio');
  assert.equal(mapEnrichRpcError(undefined, 'FILA_INVALIDA').status, 422);
  assert.equal(mapEnrichRpcError(undefined, 'raro con Persona Uno').status, 500);
  assert.ok(!mapEnrichRpcError(undefined, 'raro con Persona Uno').message.includes('Persona'));
});
test('index.ts: modos enrich_*, solo RPC confirm_prospect_enrichment, sin service_role, sin INSERT a prospectos, logs sin PII', () => {
  const src = readFileSync(join(here, '../index.ts'), 'utf8');
  assert.match(src, /enrich_preview/); assert.match(src, /enrich_confirm/);
  assert.equal((src.match(/\.rpc\('confirm_prospect_enrichment'/g) ?? []).length, 1);
  assert.ok(!/service_role|SERVICE_ROLE/i.test(src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'))); // ignora comentarios
  assert.ok(!/\.from\('digital_prospects'\)\s*\.(insert|update|upsert|delete)/.test(src));
  assert.match(src, /\.eq\('is_test', false\)/);
  const logs = src.split('\n').filter((l) => l.includes('console.log') && /enrich/.test(l));
  assert.ok(logs.length >= 3);
  logs.forEach((l) => assert.ok(!/full_name|phone|email|\brows\b|\bargs\b/.test(l.replace(/phone_e164/g, '')), l));
});
