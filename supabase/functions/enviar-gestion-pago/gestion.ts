// gestion.ts -- Replica FIEL (servidor) del bloque que genera el boton "Copiar gestion completa" de admin.html
// (copiarGestionCompleta + institucionInfo/fmt/valorSeguro/descuentoEfectivo/esc). Logica PURA: sin red, sin BD, sin Deno.
// La fidelidad se comprueba con test/gestion.test.mjs, que EJECUTA la funcion original de admin.html como oraculo.
// Unicas diferencias deliberadas (endurecimiento para correo automatico): fecha en America/Santiago (el servidor corre en UTC),
// comillas escapadas dentro de href, solo enlaces https, saltos de linea eliminados del asunto (anti inyeccion de cabeceras).

export interface Item { codigo?: unknown; descripcion?: unknown; cantidad?: unknown; descuento?: unknown; precioLista?: unknown; precioFinal?: unknown; subtotal?: unknown }
export interface Cotizacion {
  numero?: string | null; institucion?: string | null; paciente?: string | null; rut?: string | null; paciente_email?: string | null;
  paciente_direccion?: string | null; paciente_whatsapp?: string | null; doctor?: string | null;
  items?: Item[] | null; total?: number | null; comprobante_path?: string | null;
  profesional_sucursal?: string | null; profesional_direccion_despacho?: string | null;
}
export interface Pago { comprobante_path: string; monto: number; created_at: string }
/** Un comprobante ya resuelto. texto=null => comprobante "legacy" (sin fila en cotizacion_pagos). link=null => no se pudo firmar. */
export interface ComprobanteLink { texto: string | null; link: string | null }

export interface InstInfo { label: string; despacho: string; responsable: string; codigo: string }

// ---- helpers copiados de admin.html (mismo comportamiento) --------------------------------------------------------
export function institucionInfo(inst: unknown): InstInfo {
  const raw = (inst as string | null | undefined) || '';
  const s = raw.toUpperCase();
  if (s.indexOf('TEMUCO') !== -1) return { label: 'U Mayor Temuco', despacho: 'U. Mayor Temuco — Avenida Alemania 0281, 2° piso, Odontología, Temuco', responsable: 'Bethania', codigo: 'UMAYORT' };
  if (s.indexOf('UNAB') !== -1) return { label: 'UNAB Stgo', despacho: 'UNAB Santiago — Echaurren 237', responsable: 'Nicole', codigo: 'UNAB' };
  if (s.indexOf('UDP') !== -1) return { label: 'UDP Stgo', despacho: 'UDP Santiago — Av. Ejército Libertador 219', responsable: 'Carla', codigo: 'UDP' };
  if (s.indexOf('MAYOR') !== -1) return { label: 'U Mayor Stgo', despacho: "U. Mayor Santiago — Av. Libertador Bernardo O'Higgins 2013", responsable: 'Nicole', codigo: 'UMAYOR' };
  if (s.indexOf('HOSMIL') !== -1) return { label: 'HOSMIL', despacho: 'Hospital Militar (HOSMIL)', responsable: 'Nicole', codigo: 'HOSMIL' };
  if (s.indexOf('ARMADA') !== -1 || s.indexOf('CENTRAL ODONT') !== -1 || s.indexOf('CENTRALODONTOLOGICA') !== -1) {
    return { label: 'ARMADA', despacho: 'Central Odontológica Armada', responsable: 'Catalina', codigo: 'ARMADA' };
  }
  if (s.indexOf('POLICIA DE INVESTIGACIONES') !== -1 || s.indexOf('POLICÍA DE INVESTIGACIONES') !== -1 || s.indexOf('PDI') !== -1) {
    return { label: 'PDI', despacho: 'Dirección del paciente', responsable: 'Nicole', codigo: 'PDI' };
  }
  return { label: raw || '-', despacho: raw || '-', responsable: '-', codigo: '' };
}

export function fmt(n: unknown): string { return '$' + Math.round((n as number) || 0).toLocaleString('es-CL'); }

export function valorSeguro(v: unknown): unknown { return (v === null || v === undefined || v === '') ? '-' : v; }

export function descuentoEfectivo(it: Item): string {
  if (typeof it.descuento === 'number') {
    return (it.descuento > 1 ? Math.round(it.descuento) : Math.round(it.descuento * 100)) + '%';
  }
  if (typeof it.precioLista === 'number' && it.precioLista > 0 && typeof it.precioFinal === 'number') {
    const pct = Math.round((1 - it.precioFinal / it.precioLista) * 100);
    return pct <= 0 ? '0%' : '≈' + pct + '%';
  }
  return '-';
}

export function esc(s: unknown): string {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const escAttr = (s: unknown) => esc(s).replace(/"/g, '&quot;');
const soloHttps = (u: string | null): string | null => (u && /^https:\/\//i.test(u) ? u : null);

/** Fecha corta del comprobante en la zona de los usuarios (el servidor corre en UTC). */
export function fechaComprobante(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' });
}

/** Etiquetas de comprobantes: una por pago registrado, o el legacy si no hay filas. Los links se resuelven aparte (firmado). */
export function etiquetasComprobantes(c: Cotizacion, pagos: Pago[]): { path: string; texto: string | null }[] {
  if (pagos.length > 0) return pagos.map((p) => ({ path: p.comprobante_path, texto: fmt(p.monto) + ' (' + fechaComprobante(p.created_at) + ')' }));
  if (c.comprobante_path) return [{ path: c.comprobante_path, texto: null }];
  return [];
}

/** Asunto EXACTO: "Nombre paciente - RUT paciente: XXXXXXXX-X - Institución: NOMBRE INSTITUCIÓN" (sin saltos de linea). */
export function construirAsunto(c: Cotizacion): string {
  const inst = institucionInfo(c.institucion);
  const limpio = (v: unknown) => String(v).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return limpio(valorSeguro(c.paciente)) + ' - RUT paciente: ' + limpio(valorSeguro(c.rut)) + ' - Institución: ' + limpio(c.institucion || inst.label || '-');
}

export interface Gestion { asunto: string; texto: string; html: string; institucion: InstInfo }

export function construirGestion(c: Cotizacion, listaComprobantes: ComprobanteLink[]): Gestion {
  const inst = institucionInfo(c.institucion);
  const tel = c.paciente_whatsapp ? ('+56 9 ' + c.paciente_whatsapp) : '-';
  const datosLineas = [
    'Institución: ' + (c.institucion || inst.label || '-'),
    'N° Cotización: ' + valorSeguro(c.numero),
    'Nombre paciente: ' + valorSeguro(c.paciente),
    'RUT paciente: ' + valorSeguro(c.rut),
    'Correo paciente: ' + valorSeguro(c.paciente_email),
    'Dirección paciente: ' + valorSeguro(c.paciente_direccion),
    'Teléfono paciente: ' + tel,
    'Dr. tratante: ' + valorSeguro(c.doctor),
  ];
  const direccionDespacho = (inst.codigo === 'ARMADA' || inst.codigo === 'PDI')
    ? valorSeguro(c.paciente_direccion)
    : (inst.codigo === 'HOSMIL' && c.profesional_sucursal && c.profesional_direccion_despacho)
      ? (c.profesional_sucursal + ' — ' + c.profesional_direccion_despacho)
      : (inst.despacho || '-');

  const items = c.items || [];
  const filasProductosTxt = items.map((it) => [
    valorSeguro(it.codigo), valorSeguro(it.descripcion), valorSeguro(it.cantidad), descuentoEfectivo(it), fmt(it.subtotal),
  ].join(' | '));

  const lineasComprobantesTxt = listaComprobantes.length > 0
    ? listaComprobantes.map((cp, i) => {
        const etiqueta = cp.texto ? ('Comprobante ' + (i + 1) + ' — ' + cp.texto + ': ') : 'Link comprobante de pago: ';
        return etiqueta + (soloHttps(cp.link) || 'No se pudo generar link');
      })
    : ['Link comprobante de pago: -'];
  const texto = [
    datosLineas.join('\n'), '', 'Despachar a: ' + direccionDespacho, '', lineasComprobantesTxt.join('\n'), '',
    'PEDIDO / PRODUCTOS', 'Código | Descripción | Cant. | Dscto. | Subtotal', filasProductosTxt.join('\n'), '', 'Total: ' + fmt(c.total),
  ].join('\n');

  const filasProductosHtml = items.map((it) => '<tr>' +
    '<td style="border:1px solid #ddd;padding:6px;text-align:left;">' + esc(it.codigo) + '</td>' +
    '<td style="border:1px solid #ddd;padding:6px;text-align:left;">' + esc(it.descripcion) + '</td>' +
    '<td style="border:1px solid #ddd;padding:6px;text-align:right;">' + esc(it.cantidad) + '</td>' +
    '<td style="border:1px solid #ddd;padding:6px;text-align:right;">' + esc(descuentoEfectivo(it)) + '</td>' +
    '<td style="border:1px solid #ddd;padding:6px;text-align:right;">' + esc(fmt(it.subtotal)) + '</td>' +
  '</tr>').join('');
  const tablaHtml = '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">' +
    '<thead><tr>' +
      '<th style="border:1px solid #ddd;padding:6px;text-align:left;background:#f5f5f5;">Código</th>' +
      '<th style="border:1px solid #ddd;padding:6px;text-align:left;background:#f5f5f5;">Descripción</th>' +
      '<th style="border:1px solid #ddd;padding:6px;text-align:right;background:#f5f5f5;">Cant.</th>' +
      '<th style="border:1px solid #ddd;padding:6px;text-align:right;background:#f5f5f5;">Dscto.</th>' +
      '<th style="border:1px solid #ddd;padding:6px;text-align:right;background:#f5f5f5;">Subtotal</th>' +
    '</tr></thead>' +
    '<tbody>' + filasProductosHtml + '</tbody>' +
  '</table>';
  const comprobantesHtmlBloque = listaComprobantes.length > 0
    ? listaComprobantes.map((cp, i) => {
        const etiqueta = cp.texto ? ('Comprobante ' + (i + 1) + ' — ' + cp.texto + ': ') : 'Link comprobante de pago: ';
        const l = soloHttps(cp.link);
        const valor = l ? ('<a href="' + escAttr(l) + '">' + esc(l) + '</a>') : 'No se pudo generar link';
        return '<div>' + esc(etiqueta) + valor + '</div>';
      }).join('')
    : '<div>Link comprobante de pago: -</div>';
  const datosHtml = datosLineas.map((linea) => {
    const idx = linea.indexOf(': ');
    const label = idx >= 0 ? linea.slice(0, idx + 1) : linea;
    const valor = idx >= 0 ? linea.slice(idx + 2) : '';
    return '<div>' + esc(label) + ' ' + esc(valor) + '</div>';
  }).join('');
  const html = '<div style="font-family:Arial,sans-serif;font-size:13px;">' +
    datosHtml + '<br><br>' + '<div>Despachar a: ' + esc(direccionDespacho) + '</div>' + '<br><br>' +
    comprobantesHtmlBloque + '<br><br>' + '<div style="font-weight:bold;">PEDIDO / PRODUCTOS</div>' + '<br>' +
    tablaHtml + '<br><br>' + '<div style="font-weight:bold;">Total: ' + esc(fmt(c.total)) + '</div>' +
  '</div>';

  return { asunto: construirAsunto(c), texto, html, institucion: inst };
}
