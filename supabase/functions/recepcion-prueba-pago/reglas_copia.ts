// COPIA AUTOCONTENIDA (a proposito) de las funciones puras de ../recibir-respuesta-pago/respuesta.ts que usa la prueba aislada.
// Motivo: que la funcion de prueba se despliegue sola, sin depender de importar archivos de otra carpeta de funciones.
// Paridad con el original comprobada por test/paridad.test.mjs (si el original cambia, ese test falla hasta actualizar esta copia).
// Funcion temporal: se elimina junto con la funcion al terminar la prueba.

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
