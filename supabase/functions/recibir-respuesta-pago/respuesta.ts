// respuesta.ts -- Analisis PURO de respuestas de Customer Service / Finanzas (Fase E). Sin red, sin BD, sin Deno.
// Principio rector: ante CUALQUIER duda => 'ambigua' (queda para revision manual) y NUNCA se cambia un estado.
// Las frases que reconocen la validacion de Finanzas y el formato del N° SAP son PROVISIONALES (decision pendiente de Daniel):
// estan aqui, en listas explicitas, para ajustarlas sin tocar la logica.

// ---------------------------------------------------------------------------------------------------------------
// 1) Texto NUEVO de la respuesta (sin citas, sin el correo original, sin cadenas "De:/Enviado:")
// ---------------------------------------------------------------------------------------------------------------
export function htmlATexto(html: string): string {
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '\n')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ');
}

const SEP_UNA_LINEA = [
  /^\s*-{2,}\s*(original message|mensaje original|forwarded message|mensaje reenviado)/i,
  /^\s*_{5,}\s*$/,
  /^\s*(el|on)\s.+(escribi[oó]|wrote)\s*:?\s*$/i,
];
const ENCABEZADO_CITA = /^\s*\*?(de|from)\*?\s*:\s*\S/i;
const SIGUIENTE_CITA = /^\s*\*?(enviado( el)?|sent|fecha|date|para|to|asunto|subject)\*?\s*:/i;

export function extraerTextoNuevo(texto: string, html?: string): string {
  const base = (texto && texto.trim()) ? texto : (html ? htmlATexto(html) : '');
  const lineas = base.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (/^\s*>/.test(l)) continue;                                                    // linea citada
    if (SEP_UNA_LINEA.some((r) => r.test(l))) break;
    if (/^\s*(el|on)\s/i.test(l) && i + 1 < lineas.length && /(escribi[oó]|wrote)\s*:?\s*$/i.test(l + ' ' + lineas[i + 1]) ) break;   // "El ... <correo>\n escribió:"
    if (ENCABEZADO_CITA.test(l) && lineas.slice(i + 1, i + 5).some((x) => SIGUIENTE_CITA.test(x))) break;   // bloque Outlook "De: / Enviado: / Para: / Asunto:"
    out.push(l);
  }
  return out.join('\n').trim();
}

// ---------------------------------------------------------------------------------------------------------------
// 2) Finanzas: confirmacion EXPLICITA de que el pago fue validado
// ---------------------------------------------------------------------------------------------------------------
const PAGO = '(?:pago|transferencia|abono|dep[oó]sito|comprobante)';
const ESTADO_OK = '(?:validad[oa]s?|confirmad[oa]s?|verificad[oa]s?|acreditad[oa]s?|recibid[oa]s?|aprobad[oa]s?|conciliad[oa]s?)';
export const FRASES_FINANZAS: RegExp[] = [
  new RegExp(`\\b${PAGO}\\s+(?:ya\\s+)?(?:ha\\s+sido\\s+|fue\\s+|est[aá]\\s+|queda\\s+|se\\s+encuentra\\s+)?${ESTADO_OK}\\b`, 'i'),      // "pago validado", "pago fue confirmado"
  new RegExp(`\\b${ESTADO_OK}\\s+(?:el|la)\\s+${PAGO}\\b`, 'i'),                                                                      // "validado el pago"
  new RegExp(`\\b${PAGO}\\s+(?:est[aá]\\s+)?(?:ok|correcto|conforme)\\b`, 'i'),                                                       // "pago ok"
  /^\s*(?:ok[\s,.\-–]*)?pago\s+validado\s*[.!]?\s*$/im,
];
// Cualquier señal de duda, negacion, condicion o pregunta invalida la confirmacion (queda para revision).
const DUDA_FIN = /\b(no|ni|aun|a[uú]n|todav[ií]a|pendiente|falta|faltan|rechaz\w*|observ\w*|diferencia\w*|incompleto|parcial|menor|menos|devol\w*|revis\w*|verific(?:ar|amos|ando)|cuando|si|pero|excepto)\b|\?/i;
const BENIGNO = /\b(?:sin|no\s+(?:hay|existen|tiene|tenemos|presenta))\s+(?:observaci\w+|problemas?|diferencias?|reparos?|novedad\w*)\b/gi;   // "sin observaciones" NO es duda
const MENCION_FIN = /\b(pago|transferencia|abono|dep[oó]sito|comprobante|valid\w*|confirm\w*|concili\w*)\b/i;

export type AnalisisFin = { tipo: 'finanzas' } | { tipo: 'ambigua'; motivo: string } | { tipo: 'nada' };
export function analizarFinanzas(textoNuevo: string): AnalisisFin {
  const t = textoNuevo.trim();
  if (!t) return { tipo: 'nada' };
  const pos = FRASES_FINANZAS.some((r) => r.test(t));
  const duda = DUDA_FIN.test(t.replace(BENIGNO, ' '));
  if (pos && !duda) return { tipo: 'finanzas' };
  if (pos && duda) return { tipo: 'ambigua', motivo: 'finanzas_confirmacion_con_dudas' };
  if (MENCION_FIN.test(t)) return { tipo: 'ambigua', motivo: 'finanzas_sin_confirmacion_explicita' };
  return { tipo: 'nada' };
}

// ---------------------------------------------------------------------------------------------------------------
// 3) Customer Service: numero de pedido SAP (unico e inequivoco)
// ---------------------------------------------------------------------------------------------------------------
export interface CtxCS { rut?: string | null; telefono?: string | null }
const KW_SAP = /\b(?:pedido|sap|orden\s+de\s+venta|ov)\b/i;
const DUDA_CS = /\b(no|aun|a[uú]n|todav[ií]a|pendiente|falta|faltan|error|problema|anul\w*|cancel\w*|rechaz\w*|corregir|err[oó]ne\w*|reemplaz\w*|modific\w*|antes|anterior)\b|\?/i;
const soloDigitos = (s?: string | null) => (s || '').replace(/\D/g, '');

export type AnalisisCS = { tipo: 'sap'; valor: string } | { tipo: 'ambigua'; motivo: string } | { tipo: 'nada' };
export function analizarCS(textoNuevo: string, ctx: CtxCS = {}): AnalisisCS {
  const t = textoNuevo.trim();
  if (!t) return { tipo: 'nada' };
  const lineas = t.split('\n');
  const excluidos = new Set([soloDigitos(ctx.rut).replace(/\d$/, ''), soloDigitos(ctx.rut), soloDigitos(ctx.telefono)].filter((x) => x.length >= 6));
  const candidatos = new Set<string>();
  let hayKw = false;
  for (let i = 0; i < lineas.length; i++) {
    if (!KW_SAP.test(lineas[i])) continue;
    hayKw = true;
    let ventana = lineas[i];
    if (!/\d{6}/.test(ventana)) { for (let j = i + 1; j < lineas.length; j++) { if (lineas[j].trim()) { ventana += ' ' + lineas[j]; break; } } }   // "Pedido SAP:" y el numero en la linea siguiente
    for (const m of ventana.matchAll(/(?<![\d+\-.,\/])\d{6,12}(?![\d]|-[0-9kK]\b|[.,]\d)/g)) {
      const n = m[0];
      const antes = ventana.slice(Math.max(0, m.index! - 8), m.index!);
      if (/\+?56\s*9?\s*$/.test(antes)) continue;                       // telefono chileno
      if (excluidos.has(n)) continue;                                   // RUT o telefono del paciente
      candidatos.add(n);
    }
  }
  const duda = DUDA_CS.test(t);
  if (candidatos.size === 1 && !duda) return { tipo: 'sap', valor: [...candidatos][0] };
  if (candidatos.size === 1 && duda) return { tipo: 'ambigua', motivo: 'cs_numero_con_dudas' };
  if (candidatos.size > 1) return { tipo: 'ambigua', motivo: 'cs_multiples_numeros' };
  if (hayKw && /\b(ingres\w*|cread\w*|generad\w*|listo)\b/i.test(t)) return { tipo: 'ambigua', motivo: 'cs_sin_numero_reconocible' };
  return { tipo: 'nada' };
}

// ---------------------------------------------------------------------------------------------------------------
// 4) Identidad del hilo y del remitente
// ---------------------------------------------------------------------------------------------------------------
const soloCorreo = (s: string) => { const m = s.match(/<([^<>]+)>/); return (m ? m[1] : s).trim().toLowerCase(); };
/** Token de hilo: SOLO desde direcciones reply+<32 hex>@<dominio exacto>. Si hay mas de un token distinto => null (ambiguo). */
export function tokenDeDestinatarios(dirs: string[], dominio: string): string | null {
  const toks = new Set<string>();
  for (const d of dirs || []) { const m = soloCorreo(String(d)).match(/^reply\+([a-f0-9]{32})@(.+)$/); if (m && m[2] === dominio.toLowerCase()) toks.add(m[1]); }
  return toks.size === 1 ? [...toks][0] : null;
}

/** El remitente se toma como DIRECCION SIMPLE (nunca el nombre visible). */
export function remitenteSimple(from: string): string { return soloCorreo(String(from || '')); }

/** Objeto `authentication` que Resend devuelve en GET /emails/receiving/{id} (documentado: pass | fail | gray | processing_failed | unknown, o null). */
export interface AuthResend { spf?: unknown; dkim?: unknown; dmarc?: unknown }
export type VeredictoAuth = 'verificado' | 'no_verificado' | 'reintentar';
/**
 * Autenticacion del remitente con el resultado que entrega Resend. REGLA SEGURA (por defecto y unica implementada):
 *   - 'verificado'    : dmarc === 'pass' (DMARC exige alineacion del dominio del From con SPF o DKIM; es la unica senal que prueba que el
 *                       dominio del From es el que dice ser). spf/dkim 'pass' por separado NO bastan: pueden ser de un dominio ajeno.
 *   - 'reintentar'    : dmarc === 'processing_failed' (fallo de procesamiento de Resend, no del remitente): se responde 503 y Resend reintenta.
 *   - 'no_verificado' : cualquier otro valor (fail, gray, unknown, ausente, null, tipos raros). La BD registra el evento y NO cambia nada.
 * Relajar esta regla (p.ej. dominios corporativos sin DMARC, que darian 'gray') solo se decide con evidencia de la prueba aislada real.
 */
export function autenticacionResend(a: AuthResend | null | undefined): VeredictoAuth {
  const raw = a && typeof a === 'object' ? (a as AuthResend).dmarc : undefined;
  const d = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (d === 'pass') return 'verificado';
  if (d === 'processing_failed') return 'reintentar';
  return 'no_verificado';
}

// ---------------------------------------------------------------------------------------------------------------
// 5) Firma del webhook (Svix, el esquema que usa Resend): HMAC-SHA256 de "id.timestamp.cuerpo", tolerancia 5 min
// ---------------------------------------------------------------------------------------------------------------
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64e = (u: Uint8Array) => btoa(String.fromCharCode(...u));
export async function verificarSvix(h: { id: string | null; timestamp: string | null; signature: string | null }, cuerpo: string, secreto: string, ahoraMs = Date.now()): Promise<boolean> {
  try {
    if (!h.id || !h.timestamp || !h.signature || !secreto) return false;
    const ts = Number(h.timestamp); if (!Number.isFinite(ts) || Math.abs(ahoraMs / 1000 - ts) > 300) return false;
    const key = await crypto.subtle.importKey('raw', b64d(secreto.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const esperado = b64e(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h.id}.${h.timestamp}.${cuerpo}`))));
    let ok = false;
    for (const par of h.signature.split(' ')) {
      const [v, sig] = par.split(',');
      if (v !== 'v1' || !sig || sig.length !== esperado.length) continue;
      let d = 0; for (let i = 0; i < sig.length; i++) d |= sig.charCodeAt(i) ^ esperado.charCodeAt(i);
      if (d === 0) ok = true;
    }
    return ok;
  } catch { return false; }
}
