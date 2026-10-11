// Pruebas de la confirmacion (confirm.ts): armado de argumentos de la RPC con el fixture FICTICIO.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XLSX } from '../vendor/xlsx.mini.mjs';
import { analyze } from '../parse.ts';
import { readWorkbook } from '../xlsx_read.ts';
import { buildConfirmArgs, mapRpcError, sha256Hex } from '../confirm.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = new Uint8Array(readFileSync(join(here, 'fixtures/trade_up_ficticio.xlsx')));
const A = analyze(readWorkbook(XLSX, bytes));
const sha = await sha256Hex(bytes);
const ARGS = buildConfirmArgs(A, { name: 'trade_up_ficticio.xlsx', size: bytes.length, sha256: sha });

test('sha256 del archivo: 64 hex y estable', async () => {
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex(bytes), sha);
});
test('conteos: 11 total, 4 invalidas, 1 duplicado, 6 filas a insertar', () => {
  assert.equal(ARGS.p_total, 11); assert.equal(ARGS.p_invalid, 4); assert.equal(ARGS.p_duplicates, 1); assert.equal(ARGS.p_rows.length, 6);
  assert.equal(ARGS.p_rows.length + ARGS.p_invalid + ARGS.p_duplicates, ARGS.p_total);
});
test('solo VALIDO/ADVERTENCIA viajan; INVALIDO y DUPLICADO jamas', () => {
  const ok = new Set(A.rows.filter((r) => r.status === 'VALIDO' || r.status === 'ADVERTENCIA').map((r) => r.sheet + '#' + r.row));
  assert.equal(ok.size, 6);
  ARGS.p_rows.forEach((r) => assert.ok(ok.has(r.sheet + '#' + r.row)));
  const dup = A.rows.find((r) => r.status === 'DUPLICADO');
  assert.ok(!ARGS.p_rows.some((r) => r.sheet === dup.sheet && r.row === dup.row), 'el duplicado fuerte no se envia');
});
test('Sold-To (si existe) unico y valido; fila sin Sold-To se envia; las advertencias de nombre SI se importan', () => {
  const ids = ARGS.p_rows.map((r) => r.external_customer_id).filter((i) => i != null);
  assert.equal(ARGS.p_rows.length - ids.length, 1, 'una fila lista no trae Sold-To (Hoja B fila 3)');
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach((i) => assert.match(i, /^[A-Za-z0-9-]{1,20}$/));
  assert.equal(A.rows.filter((r) => r.status === 'ADVERTENCIA').every((r) => ARGS.p_rows.some((x) => x.sheet === r.sheet && x.row === r.row)), true);
});
test('el cliente no dicta consentimiento, estado ni is_test (los fija la RPC)', () => {
  ARGS.p_rows.forEach((r) => {
    for (const k of ['whatsapp_consent', 'outreach_status', 'is_test', 'problems', 'status']) assert.ok(!(k in r), k);
  });
  assert.ok(ARGS.p_rows.every((r) => r.phone_e164 === null || /^\+[1-9][0-9]{6,14}$/.test(r.phone_e164)));
});
test('raw_payload y codigos se conservan como texto', () => {
  ARGS.p_rows.forEach((r) => { assert.ok(r.external_customer_id === null || typeof r.external_customer_id === 'string'); assert.equal(typeof r.raw_payload, 'object'); });
});
test('analisis inconsistente -> error (no se arma lote)', () => {
  const bad = structuredClone(A); bad.summary.listas_para_importar += 1;
  assert.throws(() => buildConfirmArgs(bad, { name: 'x.xlsx', size: 1, sha256: sha }), /conteos_inconsistentes/);
});
test('mapRpcError: ya importado 409, no autorizado 403, rechazado 422, resto 500 sin detalle', () => {
  assert.equal(mapRpcError('P0001', 'IMPORT_YA_CONFIRMADO').status, 409);
  assert.equal(mapRpcError('42501', 'NO_AUTORIZADO').status, 403);
  assert.equal(mapRpcError('P0001', 'CONTEOS_INCONSISTENTES').status, 422);
  const o = mapRpcError('XX000', 'duplicate key value violates unique constraint (Sold-To 123)');
  assert.equal(o.status, 500); assert.ok(!o.message.includes('123'));
});
if (process.env.DUMP_ARGS) { (await import('node:fs')).writeFileSync(process.env.DUMP_ARGS, JSON.stringify(ARGS)); }
