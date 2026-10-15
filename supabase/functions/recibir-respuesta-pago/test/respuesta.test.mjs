// Pruebas unitarias del analisis de respuestas (sin red ni BD).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extraerTextoNuevo, analizarFinanzas, analizarCS, tokenDeDestinatarios, remitenteSimple, autenticacionResend, verificarSvix, htmlATexto } from '../respuesta.ts';

const TOK = 'a'.repeat(32);

// ---------- texto nuevo ----------
test('texto nuevo: Gmail ES (cita con ">" y encabezado "El ... escribió:")', () => {
  const t = 'Pago validado.\n\nSaludos\n\nEl lun, 12 oct 2026 a las 10:00, Recetario <no-responder@recetariostra.cl> escribió:\n> Institución: UDP\n> Pedido SAP 9999999999';
  assert.equal(extraerTextoNuevo(t), 'Pago validado.\n\nSaludos');
});
test('texto nuevo: Gmail ES con encabezado partido en dos lineas', () => {
  const t = 'Pedido SAP 1234567890\n\nEl lun, 12 oct 2026 a las 10:00, Recetario\n<no-responder@recetariostra.cl> escribió:\n> N° Cotización: C-1';
  assert.equal(extraerTextoNuevo(t), 'Pedido SAP 1234567890');
});
test('texto nuevo: Gmail EN y Outlook ES (De:/Enviado:)', () => {
  assert.equal(extraerTextoNuevo('OK pago confirmado\nOn Mon, Oct 12, 2026 at 10:00 AM X <x@y.cl> wrote:\n> hola'), 'OK pago confirmado');
  const o = 'Pedido 1234567890\n\n________________________________\nDe: Recetario <no-responder@recetariostra.cl>\nEnviado: lunes, 12 de octubre de 2026 10:00\nPara: m.cl.customerservicechile@straumann.com\nAsunto: X\n\nPedido SAP 5555555555';
  assert.equal(extraerTextoNuevo(o), 'Pedido 1234567890');
  const o2 = 'Listo, pago validado\nDe: Recetario <x@y.cl>\nEnviado el: lunes\nPara: z\nAsunto: w\nPedido 8888888888';
  assert.equal(extraerTextoNuevo(o2), 'Listo, pago validado');
});
test('texto nuevo: "-----Original Message-----" y solo HTML (blockquote descartado)', () => {
  assert.equal(extraerTextoNuevo('Pago validado\n-----Original Message-----\nPedido 1234567890'), 'Pago validado');
  const h = '<div>Pedido SAP <b>1234567890</b></div><blockquote>Pedido SAP 9999999999</blockquote>';
  assert.match(extraerTextoNuevo('', h), /1234567890/); assert.doesNotMatch(extraerTextoNuevo('', h), /9999999999/);
  assert.equal(htmlATexto('a&nbsp;&amp;&lt;b'), 'a &<b');
});
test('texto nuevo: un "De:" aislado (sin Enviado/Para/Asunto) NO corta el mensaje', () => {
  assert.match(extraerTextoNuevo('De: ventas llegó el pago\nPago validado'), /Pago validado/);
});

// ---------- Finanzas ----------
for (const ok of ['Pago validado', 'Pago validado.', 'ok pago validado', 'El pago fue confirmado', 'Transferencia recibida y validada', 'Validado el pago', 'Comprobante verificado', 'Pago OK', 'Pago ya fue acreditado. Gracias', 'Pago validado, sin observaciones', 'Pago validado. No hay observaciones']) {
  test(`Finanzas: confirma -> "${ok}"`, () => assert.deepEqual(analizarFinanzas(ok), { tipo: 'finanzas' }));
}
for (const [txt, motivo] of [
  ['No se ha visto el pago', 'finanzas_sin_confirmacion_explicita'], ['Pago pendiente de validar', 'finanzas_sin_confirmacion_explicita'], ['¿Pueden enviar el comprobante?', 'finanzas_sin_confirmacion_explicita'],
  ['Pago validado pero falta una diferencia', 'finanzas_confirmacion_con_dudas'], ['Pago validado, aún no concilia el saldo', 'finanzas_confirmacion_con_dudas'], ['Pago validado?', 'finanzas_confirmacion_con_dudas'],
  ['Pago validado, si el paciente confirma', 'finanzas_confirmacion_con_dudas'], ['Estamos revisando el pago', 'finanzas_sin_confirmacion_explicita'], ['Pago rechazado', 'finanzas_sin_confirmacion_explicita'],
  ['Pago validado por $50.000 menos', 'finanzas_confirmacion_con_dudas'], ['Pago validado, pago parcial', 'finanzas_confirmacion_con_dudas'],
]) test(`Finanzas: ambigua -> "${txt}"`, () => assert.deepEqual(analizarFinanzas(txt), { tipo: 'ambigua', motivo }));
for (const n of ['', '   ', 'Gracias, saludos', 'Recibido']) test(`Finanzas: nada -> "${n}"`, () => assert.deepEqual(analizarFinanzas(n), { tipo: 'nada' }));
test('Finanzas: un N° SAP dicho por Finanzas no es confirmacion', () => assert.deepEqual(analizarFinanzas('Pedido SAP 1234567890'), { tipo: 'nada' }));

// ---------- Customer Service ----------
const cs = (t, c) => analizarCS(t, c);
for (const [txt, val] of [
  ['Pedido SAP: 1234567890', '1234567890'], ['Pedido ingresado N° 1234567890', '1234567890'], ['Se ingresó el pedido 1234567890. Saludos', '1234567890'],
  ['SAP 1234567890', '1234567890'], ['Orden de venta 1234567890 creada', '1234567890'], ['Pedido SAP:\n1234567890', '1234567890'], ['N° pedido SAP 1234567890 (UDP)', '1234567890'],
  ['pedido 1234567890\npedido 1234567890', '1234567890'],   // mismo numero repetido = inequivoco
]) test(`CS: SAP -> "${txt.replace(/\n/g, '\\n')}"`, () => assert.deepEqual(cs(txt), { tipo: 'sap', valor: val }));
for (const [txt, motivo] of [
  ['Pedido SAP 1234567890 y 1234567891', 'cs_multiples_numeros'], ['Pedido anterior 1111111111 reemplazado por 2222222222', 'cs_multiples_numeros'],
  ['Pedido SAP 1234567890 pendiente de liberar', 'cs_numero_con_dudas'], ['Pedido SAP 1234567890 con error', 'cs_numero_con_dudas'], ['¿Pedido SAP 1234567890?', 'cs_numero_con_dudas'],
  ['Pedido ingresado, luego les aviso el número', 'cs_sin_numero_reconocible'], ['Listo el pedido', 'cs_sin_numero_reconocible'],
]) test(`CS: ambigua -> "${txt}"`, () => assert.deepEqual(cs(txt), { tipo: 'ambigua', motivo }));
for (const n of ['', 'Gracias', 'Recibido, lo reviso', 'Pago validado']) test(`CS: nada -> "${n}"`, () => assert.deepEqual(cs(n), { tipo: 'nada' }));
test('CS: no confunde RUT, telefono, montos ni numero sin palabra clave con un N° SAP', () => {
  assert.deepEqual(cs('Pedido para RUT 16072120-0', { rut: '16072120-0' }), { tipo: 'nada' });
  assert.deepEqual(cs('Pedido del paciente RUT 16072120-0, SAP 1234567890', { rut: '16072120-0' }), { tipo: 'sap', valor: '1234567890' });
  assert.deepEqual(cs('Pedido SAP 1234567890, contacto +56 9 12345678'), { tipo: 'sap', valor: '1234567890' });
  assert.deepEqual(cs('Pedido por $1.234.567'), { tipo: 'nada' });
  assert.deepEqual(cs('Total 1234567890'), { tipo: 'nada' }, 'sin palabra clave no se toma');
  assert.deepEqual(cs('Pedido 12345678', { telefono: '912345678' }).tipo, 'sap');
});

// ---------- hilo y remitente ----------
test('token de hilo: solo reply+<32hex>@dominio exacto; varios tokens distintos => null', () => {
  const d = 'pedidos.recetariostra.cl';
  assert.equal(tokenDeDestinatarios([`reply+${TOK}@${d}`], d), TOK);
  assert.equal(tokenDeDestinatarios([`Pagos <reply+${TOK}@${d}>`, 'x@y.cl'], d), TOK);
  assert.equal(tokenDeDestinatarios([`REPLY+${TOK}@PEDIDOS.RECETARIOSTRA.CL`], d), TOK);
  assert.equal(tokenDeDestinatarios([`reply+${TOK}@evil.cl`], d), null);
  assert.equal(tokenDeDestinatarios([`reply+${TOK}@${d}.evil.cl`], d), null);
  assert.equal(tokenDeDestinatarios([`reply+${'b'.repeat(32)}@${d}`, `reply+${TOK}@${d}`], d), null);
  assert.equal(tokenDeDestinatarios([`reply+${TOK}@${d}`, `reply+${TOK}@${d}`], d), TOK);
  assert.equal(tokenDeDestinatarios([`reply+xyz@${d}`, 'a@b.cl'], d), null);
});
test('remitente: direccion simple, nunca el nombre visible', () => {
  assert.equal(remitenteSimple('Cobranza <COBRANZA.cl@straumann.com>'), 'cobranza.cl@straumann.com');
  assert.equal(remitenteSimple('"cobranza.cl@straumann.com" <evil@x.cl>'), 'evil@x.cl');
});
test('autenticacion (objeto de Resend): solo dmarc=pass verifica; processing_failed reintenta; todo lo demas falla cerrado', () => {
  const A = autenticacionResend;
  assert.equal(A({ spf: 'pass', dkim: 'pass', dmarc: 'pass' }), 'verificado');
  assert.equal(A({ dmarc: 'PASS' }), 'verificado');
  assert.equal(A({ spf: 'pass', dkim: 'pass', dmarc: 'fail' }), 'no_verificado');
  assert.equal(A({ spf: 'pass', dkim: 'pass', dmarc: 'gray' }), 'no_verificado');       // dominio sin DMARC publicado: NO se acepta
  assert.equal(A({ spf: 'pass', dkim: 'pass' }), 'no_verificado');                       // spf/dkim solos no prueban el dominio del From
  assert.equal(A({ dmarc: 'unknown' }), 'no_verificado');
  assert.equal(A({ dmarc: 'processing_failed' }), 'reintentar');
  for (const x of [null, undefined, {}, 'pass', 1, true, { dmarc: ['pass'] }, { dmarc: { v: 'pass' } }, { dmarc: ' pass' }, { dmarc: 'pass ' }]) assert.equal(A(x), 'no_verificado', JSON.stringify(x));
});

// ---------- firma Svix ----------
const SECRET = 'whsec_' + Buffer.from('clave-de-prueba-0123456789').toString('base64');
const firmar = (id, ts, body, secret = SECRET) => 'v1,' + createHmac('sha256', Buffer.from(secret.replace('whsec_', ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
test('Svix: firma valida, firmas multiples, y rechazos', async () => {
  const body = '{"type":"email.received"}', id = 'msg_1', now = 1_800_000_000_000, ts = String(now / 1000);
  const h = (sig, over = {}) => ({ id, timestamp: ts, signature: sig, ...over });
  assert.equal(await verificarSvix(h(firmar(id, ts, body)), body, SECRET, now), true);
  assert.equal(await verificarSvix(h('v1,AAAA ' + firmar(id, ts, body)), body, SECRET, now), true);
  assert.equal(await verificarSvix(h(firmar(id, ts, body)), body + ' ', SECRET, now), false, 'cuerpo alterado');
  assert.equal(await verificarSvix(h(firmar(id, ts, body, 'whsec_' + Buffer.from('otra').toString('base64'))), body, SECRET, now), false, 'otra clave');
  assert.equal(await verificarSvix(h(firmar(id, ts, body), { id: 'msg_2' }), body, SECRET, now), false, 'otro id');
  assert.equal(await verificarSvix(h(firmar(id, ts, body)), body, SECRET, now + 301_000), false, 'repeticion antigua');
  assert.equal(await verificarSvix(h(firmar(id, ts, body)), body, SECRET, now - 301_000), false, 'fecha futura');
  assert.equal(await verificarSvix(h(null), body, SECRET, now), false); assert.equal(await verificarSvix(h(firmar(id, ts, body)), body, '', now), false);
  assert.equal(await verificarSvix(h('v2,' + firmar(id, ts, body).slice(3)), body, SECRET, now), false, 'version desconocida');
});
