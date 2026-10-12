// Fidelidad de gestion.ts vs el boton ORIGINAL "Copiar gestion completa" (admin.html).
// ORACULO: se extrae el codigo real de admin.html y se ejecuta en un vm con stubs (portapapeles, storage). Cero red.
process.env.TZ = 'America/Santiago';   // el navegador de los usuarios corre en Santiago
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { construirGestion, construirAsunto, etiquetasComprobantes, institucionInfo, fmt } from '../gestion.ts';

const adminPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../admin.html');
const src = readFileSync(adminPath, 'utf8');
const cut = (from, to) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, 'no se pudo extraer ' + from); return src.slice(a, b); };
const ORIGINAL = [
  cut('function institucionInfo(inst)', 'const DOMINIO_POR_CODIGO'),
  cut('function fmt(n)', 'function fechaCorta'),
  cut('function esc(s)', 'function renderLogin'),
  cut('async function copiarGestionCompleta(id, btn)', 'function exportarExcel'),
].join('\n');

/** Ejecuta la funcion ORIGINAL y devuelve lo que habria quedado en el portapapeles. */
async function oraculo(c, pagos, firmar /* path => url|null */) {
  let captured = null;
  class Blob { constructor(parts) { this.t = parts.join(''); } }
  class ClipboardItem { constructor(o) { this.o = o; } }
  const ctx = {
    cotizaciones: [c], pagosPorCotizacion: pagos.length ? { [c.id]: pagos } : {},
    sb: { storage: { from: () => ({ createSignedUrl: async (p) => { const u = firmar(p); return u ? { data: { signedUrl: u }, error: null } : { data: null, error: { message: 'x' } }; } }) } },
    navigator: { clipboard: { write: async (items) => { captured = { html: items[0].o['text/html'].t, texto: items[0].o['text/plain'].t }; }, writeText: async () => { throw new Error('no deberia'); } } },
    window: { ClipboardItem }, ClipboardItem, Blob, console: { warn() {} }, alert() {}, setTimeout() {}, Date, Math, String, Number, Array, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(ORIGINAL, ctx);
  await ctx.copiarGestionCompleta(c.id, { textContent: 'x', disabled: false });
  return captured;
}

/** Misma resolucion que el emisor: etiqueta por pago + enlace firmado (o null). */
function resolver(c, pagos, firmar) {
  return etiquetasComprobantes(c, pagos).map((e) => ({ texto: e.texto, link: firmar(e.path) }));
}
const firmarOk = (p) => 'https://proyecto.supabase.co/storage/v1/object/sign/comprobantes/' + p + '?token=T0K';

const base = {
  id: 'c1', numero: 'COT-0001', institucion: 'UDP Santiago', paciente: 'Scarlett Salas López', rut: '16072120-0', paciente_email: 'a@b.cl',
  paciente_direccion: 'Calle 1 #23, Ñuñoa', paciente_whatsapp: '912345678', doctor: 'Dr. Pérez', total: 1234567,
  items: [
    { codigo: '104.060', descripcion: 'Implante <Helix> & co', cantidad: 2, descuento: 0.15, subtotal: 500000 },
    { codigo: '140.1080', descripcion: 'Pilar', cantidad: 1, descuento: 20, subtotal: 734567 },
    { codigo: '2010.725-NOV', descripcion: 'Sin descuento explicito', cantidad: 3, precioLista: 100000, precioFinal: 80000, subtotal: 240000 },
    { codigo: 'X', descripcion: 'Sin datos', cantidad: 1, precioLista: 100, precioFinal: 120, subtotal: 120 },
    { codigo: '', descripcion: null, cantidad: undefined, subtotal: 0 },
  ],
};
const pagos2 = [
  { comprobante_path: 'u/1.pdf', monto: 700000, created_at: '2026-10-12T02:30:00Z' },   // 11-10 en Santiago (UTC dice 12)
  { comprobante_path: 'u/2.pdf', monto: 534567, created_at: '2026-10-12T15:00:00Z' },
];

const casos = [
  ['UDP con 2 pagos', base, pagos2, firmarOk],
  ['UNAB un pago', { ...base, institucion: 'UNAB Santiago' }, pagos2.slice(0, 1), firmarOk],
  ['UMAYOR (Mayor Santiago)', { ...base, institucion: 'Universidad Mayor Santiago' }, pagos2, firmarOk],
  ['UMAYORT Temuco', { ...base, institucion: 'Universidad Mayor Temuco' }, pagos2, firmarOk],
  ['HOSMIL generico (sin snapshot)', { ...base, institucion: 'HOSMIL' }, pagos2, firmarOk],
  ['HOSMIL con sede', { ...base, institucion: 'HOSMIL', profesional_sucursal: 'Sede Norte', profesional_direccion_despacho: 'Av. X 123' }, pagos2, firmarOk],
  ['ARMADA usa direccion paciente', { ...base, institucion: 'Central Odontológica de la Armada' }, pagos2, firmarOk],
  ['PDI usa direccion paciente', { ...base, institucion: 'Policía de Investigaciones' }, pagos2, firmarOk],
  ['PDI sin direccion paciente', { ...base, institucion: 'PDI', paciente_direccion: null }, pagos2, firmarOk],
  ['institucion desconocida (UC)', { ...base, institucion: 'Pontificia UC' }, pagos2, firmarOk],
  ['legacy: sin pagos pero con comprobante_path', { ...base, comprobante_path: 'legacy/x.pdf' }, [], firmarOk],
  ['sin comprobantes', { ...base }, [], firmarOk],
  ['firma falla en un comprobante', base, pagos2, (p) => (p === 'u/2.pdf' ? null : firmarOk(p))],
  ['firma falla en legacy', { ...base, comprobante_path: 'legacy/x.pdf' }, [], () => null],
  ['campos vacios', { id: 'c1', institucion: '', total: null, items: null }, [], firmarOk],
  ['sin whatsapp', { ...base, paciente_whatsapp: null }, pagos2, firmarOk],
  ['caracteres especiales', { ...base, paciente: 'A<b>&"\'', doctor: 'Dr. <x>' }, pagos2, firmarOk],
];

for (const [nombre, c, pagos, firmar] of casos) {
  test('fidelidad vs original: ' + nombre, async () => {
    const o = await oraculo(c, pagos, firmar);
    const g = construirGestion(c, resolver(c, pagos, firmar));
    assert.equal(g.texto, o.texto, 'texto plano distinto');
    assert.equal(g.html, o.html, 'html distinto');
  });
}

test('fmt coincide con el original en montos tipicos', () => {
  for (const n of [0, null, undefined, 999, 1000, 1234, 12345, 1234567, 99999999, 1000.5, 2.4]) assert.equal(fmt(n), ('$' + Math.round(n || 0).toLocaleString('es-CL')));
  assert.equal(fmt(1234567), '$1.234.567');
});

test('institucionInfo coincide con el original para todos los nombres reales', async () => {
  const ctx = {}; vm.createContext(ctx); vm.runInContext(cut('function institucionInfo(inst)', 'const DOMINIO_POR_CODIGO'), ctx);
  for (const n of ['UDP Santiago', 'UNAB', 'Universidad Mayor Temuco', 'Universidad Mayor Santiago', 'HOSMIL', 'Central Odontológica de la Armada', 'CENTRALODONTOLOGICA', 'Policía de Investigaciones', 'PDI', 'UC', '', null, undefined, 'xyz']) {
    const a = ctx.institucionInfo(n), b = institucionInfo(n);
    for (const k of ['label', 'despacho', 'responsable', 'codigo']) assert.equal(b[k], a[k], `${n}:${k}`);
  }
});

test('asunto EXACTO: "Nombre - RUT paciente: X - Institución: NOMBRE"', () => {
  assert.equal(construirAsunto(base), 'Scarlett Salas López - RUT paciente: 16072120-0 - Institución: UDP Santiago');
  assert.equal(construirAsunto({ ...base, rut: null }), 'Scarlett Salas López - RUT paciente: - - Institución: UDP Santiago');
});

test('asunto: sin saltos de linea (anti inyeccion de cabeceras)', () => {
  const a = construirAsunto({ ...base, paciente: 'Juan\r\nBcc: x@y.cl', rut: '1-9\n' });
  assert.ok(!/[\r\n]/.test(a)); assert.equal(a, 'Juan Bcc: x@y.cl - RUT paciente: 1-9 - Institución: UDP Santiago');
});

test('endurecimiento: solo enlaces https y comillas escapadas en href', () => {
  const g = construirGestion(base, [{ texto: null, link: 'javascript:alert(1)' }, { texto: null, link: 'https://x.cl/a"onmouseover="y' }]);
  assert.ok(!g.html.includes('javascript:') && !g.texto.includes('javascript:'));
  assert.ok(g.html.includes('No se pudo generar link'));
  assert.ok(!g.html.includes('href="https://x.cl/a"onmouseover'));
});

test('fecha del comprobante usa America/Santiago aunque el servidor este en UTC', () => {
  const g = construirGestion(base, resolver(base, pagos2, firmarOk));
  assert.match(g.texto, /\$700\.000 \(11-10-2026\)/);
});
