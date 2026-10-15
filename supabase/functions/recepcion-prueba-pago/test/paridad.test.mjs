// La copia autocontenida (reglas_copia.ts) debe comportarse IGUAL que el original (recibir-respuesta-pago/respuesta.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as O from '../../recibir-respuesta-pago/respuesta.ts';
import * as C from '../reglas_copia.ts';

const TOK = 'a1b2c3d4e5f60718293a4b5c6d7e8f90', D = 'pedidos.recetariostra.cl';
test('paridad: tokenDeDestinatarios y remitenteSimple', () => {
  const casos = [[`reply+${TOK}@${D}`], [`Pagos <reply+${TOK}@${D}>`, 'x@y.cl'], [`REPLY+${TOK.toUpperCase()}@${D.toUpperCase()}`], [`reply+${TOK}@evil.cl`], [`reply+${TOK}@${D}.evil.cl`],
    [`reply+${TOK}@${D}`, `reply+${'b'.repeat(32)}@${D}`], [`reply+${TOK.slice(1)}@${D}`], [`reply+${TOK}+x@${D}`], [], ['sin-arroba'], [`reply+${TOK}@${D}`, `reply+${TOK}@${D}`]];
  for (const c of casos) assert.equal(C.tokenDeDestinatarios(c, D), O.tokenDeDestinatarios(c, D), JSON.stringify(c));
  for (const f of ['Cobranza <COBRANZA.cl@straumann.com>', '"x@y.cl" <evil@x.cl>', '', 'a@b.cl', '<a@b.cl>', '  A@B.CL  ']) assert.equal(C.remitenteSimple(f), O.remitenteSimple(f), f);
});
test('paridad: autenticacionResend', () => {
  for (const x of [{ dmarc: 'pass' }, { dmarc: 'PASS' }, { dmarc: 'fail' }, { dmarc: 'gray' }, { dmarc: 'processing_failed' }, { dmarc: 'unknown' }, {}, null, undefined, 'pass', { dmarc: ['pass'] }, { dmarc: ' pass' }, { spf: 'pass', dkim: 'pass' }])
    assert.equal(C.autenticacionResend(x), O.autenticacionResend(x), JSON.stringify(x));
});
test('paridad: verificarSvix (valida, mala, vieja, sin cabeceras, con y sin prefijo whsec_)', async () => {
  const raw = Buffer.from('secreto-de-paridad-0123456789').toString('base64'), SEC = 'whsec_' + raw, body = '{"a":1}', id = 'msg_1', now = Date.now();
  const ts = (d) => String(Math.floor(now / 1000) + d);
  const sig = (t, b = body, k = raw) => 'v1,' + createHmac('sha256', Buffer.from(k, 'base64')).update(`${id}.${t}.${b}`).digest('base64');
  const casos = [
    [{ id, timestamp: ts(0), signature: sig(ts(0)) }, body, SEC], [{ id, timestamp: ts(0), signature: sig(ts(0)) }, body, raw], [{ id, timestamp: ts(0), signature: sig(ts(0)) }, body + 'x', SEC],
    [{ id, timestamp: ts(-900), signature: sig(ts(-900)) }, body, SEC], [{ id, timestamp: ts(-299), signature: sig(ts(-299)) }, body, SEC], [{ id, timestamp: ts(0), signature: 'v1,AAAA' }, body, SEC],
    [{ id: null, timestamp: ts(0), signature: sig(ts(0)) }, body, SEC], [{ id, timestamp: 'abc', signature: sig(ts(0)) }, body, SEC], [{ id, timestamp: ts(0), signature: 'v2,' + sig(ts(0)).slice(3) }, body, SEC],
    [{ id, timestamp: ts(0), signature: 'v1,XXXX ' + sig(ts(0)) }, body, SEC], [{ id, timestamp: ts(0), signature: sig(ts(0)) }, body, ''],
  ];
  for (const [h, b, s] of casos) assert.equal(await C.verificarSvix(h, b, s, now), await O.verificarSvix(h, b, s, now), JSON.stringify(h));
  assert.equal(await C.verificarSvix(casos[0][0], body, SEC, now), true);
});
