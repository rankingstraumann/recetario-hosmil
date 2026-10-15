// logic.ts -- Receptor de respuestas de Customer Service / Finanzas (Fase E). Dependencias inyectadas: se prueba sin red.
// NO DESPLEGADA. Se mantiene inerte mientras pago_gestion_config.confirmaciones_activo<>'true' (la BD responde 'desactivado').
//
// Cadena de confianza (todas deben cumplirse para registrar algo):
//   firma Svix valida  ->  token de hilo reply+<32hex>@dominio  ->  gestion existente y YA enviada  ->  remitente en la lista autorizada
//   (direccion simple, nunca nombre visible)  ->  autenticacion del correo (authentication.dmarc === 'pass' de Resend)  ->  rol correcto  ->  contenido inequivoco.
// Cualquier eslabon que falle NO cambia estados: o se descarta (sin gestion) o queda un evento para revision manual.
import type { AuthResend } from './respuesta.ts';
import { analizarCS, analizarFinanzas, autenticacionResend, extraerTextoNuevo, remitenteSimple, tokenDeDestinatarios, verificarSvix } from './respuesta.ts';

export interface Cfg { webhookSecret: string; replyDomain: string }
export interface Res<T> { data: T | null; error: { code?: string } | null }
export interface Cuerpo { text?: string | null; html?: string | null; headers?: Record<string, unknown> | null; authentication?: AuthResend | null }
export interface Deps {
  cfg: Cfg;
  rpc(name: string, args?: Record<string, unknown>): Promise<Res<any>>;
  /** Cuerpo y cabeceras del correo recibido (el webhook de Resend solo trae metadatos). null = no disponible (error transitorio). */
  obtenerCuerpo(emailId: string): Promise<Cuerpo | null>;
  /** RUT y telefono del paciente: solo para no confundirlos con un N° SAP. */
  getContexto(cotizacionId: string): Promise<{ rut?: string | null; paciente_whatsapp?: string | null } | null>;
  now?: () => number;
  log(o: Record<string, unknown>): void;
}
export interface Entrada { rawBody: string; svixId: string | null; svixTimestamp: string | null; svixSignature: string | null }
export interface Resultado { status: number; body: Record<string, unknown> }

const LOG_OK = new Set(['ev', 'gid', 'resultado', 'rol', 'motivo', 'code', 'auth', 'dmarc']);
export function safeLog(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!LOG_OK.has(k)) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_:\-]{1,60}$/.test(v)) out[k] = v;
  }
  return out;
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const ok = (resultado: string): Resultado => ({ status: 200, body: { ok: true, resultado } });
const transitorio = (motivo: string): Resultado => ({ status: 503, body: { ok: false, error: motivo } });   // Resend reintenta; todo es idempotente
const extracto = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 300);

export async function handle(e: Entrada, deps: Deps): Promise<Resultado> {
  const log = (o: Record<string, unknown>) => deps.log(safeLog(o));
  // 1) Firma del webhook
  if (!(await verificarSvix({ id: e.svixId, timestamp: e.svixTimestamp, signature: e.svixSignature }, e.rawBody, deps.cfg.webhookSecret, (deps.now ?? Date.now)()))) {
    log({ ev: 'firma_invalida' }); return { status: 401, body: { ok: false, error: 'firma_invalida' } };
  }
  // 2) Evento
  let ev: any; try { ev = JSON.parse(e.rawBody); } catch { return ok('json_invalido_ignorado'); }
  if (ev?.type !== 'email.received' || !ev.data || typeof ev.data !== 'object') return ok('evento_ignorado');
  const d = ev.data;
  const from = remitenteSimple(String(d.from ?? ''));
  const destinos: string[] = [...(Array.isArray(d.to) ? d.to : []), ...(Array.isArray(d.cc) ? d.cc : []), ...(Array.isArray(d.received_for) ? d.received_for : [])].map(String);
  const emailId = String(d.email_id ?? '');
  const dedupe = 'in:' + (await sha(String(d.message_id || emailId || e.svixId || ''))).slice(0, 40);

  // 3) Hilo: token en la direccion de respuesta
  const token = tokenDeDestinatarios(destinos, deps.cfg.replyDomain);
  if (!token) { log({ ev: 'sin_token' }); return ok('sin_token'); }
  const rs = await deps.rpc('pago_gestion_resolver_respuesta', { p_token: token });
  if (rs.error) { log({ ev: 'resolver_error', code: rs.error.code ?? 'rpc' }); return transitorio('resolver'); }
  const g = Array.isArray(rs.data) ? rs.data[0] : rs.data;
  if (!g) { log({ ev: 'token_desconocido' }); return ok('token_desconocido'); }
  const gid = String(g.gestion_id).slice(0, 8);
  // Modo prueba: la BD marca modificable=false para gestiones de cotizaciones REALES (la BD ademas lo vuelve a exigir en cada funcion y trigger).
  // Estricto (=== false): sin leer el cuerpo, sin remitente, sin ninguna escritura.
  if (g.modificable === false) { log({ ev: 'bloqueado_modo_prueba', gid }); return ok('bloqueado_modo_prueba'); }
  if (!g.recibe) { log({ ev: 'gestion_no_enviada', gid, motivo: String(g.estado_envio) }); return ok('gestion_no_enviada'); }

  // 4) Remitente (lista autorizada) -- antes de leer el cuerpo
  const rr = await deps.rpc('pago_remitente_rol', { p_email: from });
  if (rr.error) { log({ ev: 'rol_error', gid, code: rr.error.code ?? 'rpc' }); return transitorio('rol'); }
  const rol: string | null = typeof rr.data === 'string' ? rr.data : null;
  if (!rol || (rol !== 'customer_service' && rol !== 'finanzas')) {
    // La BD registra 'respuesta_no_autorizada' (con el motivo) y NO cambia nada.
    const r = await deps.rpc('pago_gestion_registrar_confirmacion', { p_gestion_id: g.gestion_id, p_tipo: 'sap', p_dedupe: dedupe, p_valor: null, p_remitente: from, p_auth_ok: false });
    if (r.error) return transitorio('registrar');
    log({ ev: 'remitente_no_autorizado', gid, resultado: String(r.data) }); return ok(String(r.data));
  }
  const tipo = rol === 'customer_service' ? 'sap' : 'finanzas';

  // 5) Cuerpo y autenticacion del correo
  const cuerpo = await deps.obtenerCuerpo(emailId);
  if (!cuerpo) { log({ ev: 'cuerpo_no_disponible', gid }); return transitorio('cuerpo'); }
  const veredicto = autenticacionResend(cuerpo.authentication ?? null);
  if (veredicto === 'reintentar') { log({ ev: 'autenticacion_no_procesada', gid }); return transitorio('autenticacion'); }
  if (veredicto !== 'verificado') {
    const r = await deps.rpc('pago_gestion_registrar_confirmacion', { p_gestion_id: g.gestion_id, p_tipo: tipo, p_dedupe: dedupe, p_valor: null, p_remitente: from, p_auth_ok: false });
    if (r.error) return transitorio('registrar');
    const dm = String(cuerpo.authentication?.dmarc ?? 'ausente').toLowerCase();
    log({ ev: 'autenticacion_fallida', gid, rol, auth: false, dmarc: /^[a-z_]{1,20}$/.test(dm) ? dm : 'otro', resultado: String(r.data) }); return ok(String(r.data));
  }

  // 6) Contenido (solo el texto NUEVO de la respuesta)
  const nuevo = extraerTextoNuevo(cuerpo.text ?? '', cuerpo.html ?? undefined);
  const ctx = tipo === 'sap' ? await deps.getContexto(g.cotizacion_id) : null;
  const a = tipo === 'sap' ? analizarCS(nuevo, { rut: ctx?.rut, telefono: ctx?.paciente_whatsapp }) : analizarFinanzas(nuevo);
  if (a.tipo === 'nada') { log({ ev: 'sin_contenido_accionable', gid, rol }); return ok('sin_contenido_accionable'); }
  if (a.tipo === 'ambigua') {
    const r = await deps.rpc('pago_gestion_registrar_ambigua', { p_gestion_id: g.gestion_id, p_dedupe: dedupe, p_remitente: from, p_motivo: a.motivo, p_extracto: extracto(nuevo) });
    if (r.error) return transitorio('ambigua');
    log({ ev: 'ambigua', gid, rol, motivo: a.motivo, resultado: String(r.data) }); return ok(String(r.data));
  }

  // 7) Confirmacion inequivoca: la BD vuelve a verificar remitente/rol/autenticacion y decide el avance de estado
  const r = await deps.rpc('pago_gestion_registrar_confirmacion', {
    p_gestion_id: g.gestion_id, p_tipo: tipo, p_dedupe: dedupe, p_valor: a.tipo === 'sap' ? a.valor : null, p_remitente: from, p_auth_ok: true,
  });
  if (r.error) { log({ ev: 'registrar_error', gid, code: r.error.code ?? 'rpc' }); return transitorio('registrar'); }
  log({ ev: 'confirmacion', gid, rol, resultado: String(r.data) });
  return ok(String(r.data));
}
